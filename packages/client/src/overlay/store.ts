/**
 * Where the overlay's keys and pins live on disk.
 *
 *   <user data dir>/overlay/
 *     domain-keys/<name>.json   the domain key (Ed25519) — only on the owner's device
 *     node-keys/<name>.json     this service node's node key (Ed25519)
 *     grants/<name>.json        the grant chain for the node key, when the domain
 *                               key lives on another device
 *     pins.json                 domain keys this client pinned, per name
 *
 * Directories are 0700 and files 0600 (security.md §2). A file is written to
 * an exclusive temp file in the same directory and renamed over the target, so
 * a crash never leaves half a key, and a planted symlink at the target or temp
 * path is refused rather than followed. Keys are never written to a temporary
 * directory and never logged.
 *
 * One place per invoking user: under `sudo`, the data directory is the
 * INVOKING user's (`SUDO_USER`), and files written there are given back to
 * that user, so `sudo tnp connect`, `tnp pins` and `tnp test` read and write
 * the same pin store.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  closeSync,
  constants,
  existsSync,
  fchownSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isCanonicalName } from '@tnp/shared-types';
import { restrictWindowsAcl } from '../secure-fs';
import { findSystemBinary, runCmd } from '../system-cmd';

export interface InvokingUser {
  uid: number;
  gid: number;
  home: string;
}

const ACCOUNT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * passwd(5) lines that include `name`'s account, if it exists. Linux reads
 * /etc/passwd. macOS keeps its accounts in Directory Services, not in
 * /etc/passwd, so the line is built from `dscl . -read /Users/<name>`.
 */
export function systemPasswd(name: string): string {
  if (process.platform !== 'darwin') return readFileSync('/etc/passwd', 'utf-8');
  const dscl = findSystemBinary('dscl');
  if (!dscl || !ACCOUNT_NAME_RE.test(name)) return '';
  const res = runCmd({
    file: dscl,
    args: ['.', '-read', `/Users/${name}`, 'UniqueID', 'NFSHomeDirectory'],
  });
  if (res.status !== 0) return '';
  const uid = /^UniqueID:\s*(\d+)\s*$/m.exec(res.stdout)?.[1];
  const home = /^NFSHomeDirectory:\s*(\/\S.*?)\s*$/m.exec(res.stdout)?.[1];
  return uid && home ? `${name}:*:${uid}:::${home}:\n` : '';
}

/**
 * The user `sudo` was invoked by, when this process runs as root under sudo;
 * null otherwise. The account must exist in the system's account database
 * with the uid sudo recorded, and the home directory is the one recorded
 * there, never one derived from the environment root inherited.
 *
 * macOS used to skip that check and take `/Users/$SUDO_USER` with whatever
 * `SUDO_UID` said; the unit tests caught it once they ran on a Mac.
 */
export function invokingUser(
  env: NodeJS.ProcessEnv = process.env,
  uid: number | undefined = process.getuid?.(),
  passwd: (name: string) => string = systemPasswd,
): InvokingUser | null {
  if (uid !== 0) return null;
  const name = env.SUDO_USER;
  const sudoUid = Number(env.SUDO_UID);
  const sudoGid = Number(env.SUDO_GID);
  if (!name || name === 'root' || !Number.isInteger(sudoUid) || !Number.isInteger(sudoGid)) {
    return null;
  }
  try {
    for (const line of passwd(name).split('\n')) {
      const fields = line.split(':');
      if (fields[0] === name && Number(fields[2]) === sudoUid && fields[5]) {
        return { uid: sudoUid, gid: sudoGid, home: fields[5] };
      }
    }
  } catch {
    // no password database: fall through
  }
  return null;
}

/**
 * The per-USER data directory. Overlay keys and pins belong to the user who
 * runs `tnp serve` / `tnp connect` (the invoking user under sudo), never to
 * the resolver daemon's sandboxed service account and never to a machine-wide
 * directory another account could read.
 */
export function userDataDir(): string {
  const sudo = invokingUser();
  const home = sudo?.home ?? homedir();
  switch (process.platform) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'tnp');
    case 'win32':
      return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'tnp');
    default:
      return join(
        (!sudo && process.env.XDG_DATA_HOME?.trim()) || join(home, '.local', 'share'),
        'tnp',
      );
  }
}

/** The overlay state directory. `TNP_DATA_DIR` overrides the per-user data dir. */
export function overlayDir(base?: string): string {
  return join(base ?? (process.env.TNP_DATA_DIR?.trim() || userDataDir()), 'overlay');
}

export type StoreArea = 'domain-keys' | 'node-keys' | 'grants';

/**
 * On Windows every private write also sets and verifies the file's ACL, which
 * starts icacls and Windows PowerShell (about a second on a CI runner), so a
 * lock is held far longer there. With the POSIX figures, four processes
 * recording pins at once timed out waiting on each other on a Windows runner,
 * and a slow holder risked having its live lock broken as stale.
 */
const SLOW_WRITES = process.platform === 'win32';
/** A lock older than this is a crashed holder's and is broken. */
const STALE_LOCK_MS = SLOW_WRITES ? 60_000 : 10_000;
/** How long to wait for another process's lock before giving up. */
const LOCK_WAIT_MS = SLOW_WRITES ? 30_000 : 5_000;

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

export class OverlayStore {
  private readonly owner: InvokingUser | null;

  constructor(
    readonly root: string = overlayDir(),
    owner: InvokingUser | null = invokingUser(),
  ) {
    this.owner = owner;
  }

  pathFor(area: StoreArea, name: string): string {
    if (!isCanonicalName(name)) throw new Error('not a canonical name');
    return join(this.root, area, `${name}.json`);
  }

  get pinsPath(): string {
    return join(this.root, 'pins.json');
  }

  exists(path: string): boolean {
    return existsSync(path);
  }

  /** Read a private file. Refuses a symlink; tightens loose permissions. */
  readPrivate(path: string): string | null {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch {
      return null;
    }
    if (!stat.isFile()) throw new Error(`refusing to read ${path}: not a regular file`);
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      console.warn(`[tnp] ${path} was readable by other users; restricting it to 0600`);
      chmodSync(path, 0o600);
    }
    return readFileSync(path, 'utf-8');
  }

  /** Create `dir` (0700) and hand it, and the overlay root, to the invoking user under sudo. */
  ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') return;
    chmodSync(dir, 0o700);
    if (this.owner) {
      for (const d of new Set([dirname(this.root), this.root, dir])) {
        try {
          if (lstatSync(d).uid === 0) chownSync(d, this.owner.uid, this.owner.gid);
        } catch {
          // not ours to fix
        }
      }
    }
  }

  /** Atomically replace `path` with `content`, mode 0600, in a 0700 directory. */
  writePrivate(path: string, content: string): void {
    this.ensureDir(dirname(path));
    try {
      if (!lstatSync(path).isFile())
        throw new Error(`refusing to replace ${path}: not a regular file`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      writeSync(fd, content);
      fsyncSync(fd);
      if (this.owner) fchownSync(fd, this.owner.uid, this.owner.gid);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, path);
      if (process.platform === 'win32') restrictWindowsAcl(path, 'private-file');
    } catch (err) {
      try {
        unlinkSync(temp);
      } catch {
        // nothing to clean
      }
      throw err;
    }
  }

  /**
   * Overwrite a secret file in place with random bytes, flush, and unlink it.
   * Best effort against recovery from the same filesystem (copy-on-write and
   * SSD wear-levelling can keep old blocks); the real defence is that a key
   * never leaves this directory.
   */
  shred(path: string): void {
    let size: number;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile()) return;
      size = stat.size;
    } catch {
      return;
    }
    const fd = openSync(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      writeSync(fd, randomBytes(Math.max(size, 1)), 0, Math.max(size, 1), 0);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    unlinkSync(path);
  }

  /**
   * Run `fn` holding an exclusive lock file next to `path` (`<path>.lock`,
   * O_EXCL, never followed through a symlink). Several processes share the
   * pin file and the relay-directory state; each change is re-read, decided
   * and written atomically under this lock, so one never overwrites another.
   * A lock older than STALE_LOCK_MS is a crashed holder's and is broken.
   */
  withLock<T>(path: string, fn: () => T): T {
    const lockPath = `${path}.lock`;
    this.ensureDir(dirname(path));
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = openSync(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          if (Date.now() - lstatSync(lockPath).mtimeMs > STALE_LOCK_MS) {
            unlinkSync(lockPath); // a holder that crashed
            continue;
          }
        } catch {
          continue; // released between our open and stat
        }
        if (Date.now() > deadline) {
          throw new Error(`the file ${path} is locked by another process`);
        }
        sleepSync(10);
      }
    }
    try {
      writeSync(fd, `${process.pid}\n`);
      return fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        // already broken as stale by someone else
      }
    }
  }

  /** Move a file over another in the same directory (atomic). */
  promote(from: string, to: string): void {
    renameSync(from, to);
  }
}
