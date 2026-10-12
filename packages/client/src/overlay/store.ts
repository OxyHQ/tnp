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

export interface InvokingUser {
  uid: number;
  gid: number;
  home: string;
}

/**
 * The user `sudo` was invoked by, when this process runs as root under sudo;
 * null otherwise. The home directory comes from the password database, never
 * from the environment root inherited.
 */
export function invokingUser(
  env: NodeJS.ProcessEnv = process.env,
  uid: number | undefined = process.getuid?.(),
  passwd: () => string = () => readFileSync('/etc/passwd', 'utf-8'),
): InvokingUser | null {
  if (uid !== 0) return null;
  const name = env.SUDO_USER;
  const sudoUid = Number(env.SUDO_UID);
  const sudoGid = Number(env.SUDO_GID);
  if (!name || name === 'root' || !Number.isInteger(sudoUid) || !Number.isInteger(sudoGid)) {
    return null;
  }
  if (process.platform === 'darwin')
    return { uid: sudoUid, gid: sudoGid, home: join('/Users', name) };
  try {
    for (const line of passwd().split('\n')) {
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

  /** Move a file over another in the same directory (atomic). */
  promote(from: string, to: string): void {
    renameSync(from, to);
  }
}
