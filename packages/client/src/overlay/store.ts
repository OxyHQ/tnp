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
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
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

/**
 * The per-USER data directory. Overlay keys and pins belong to the user who
 * runs `tnp serve` / `tnp connect`, never to the resolver daemon's sandboxed
 * service account and never to a machine-wide directory another account
 * could read.
 */
export function userDataDir(): string {
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'tnp');
    case 'win32':
      return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'tnp');
    default:
      return join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'), 'tnp');
  }
}

/** The overlay state directory. `TNP_DATA_DIR` overrides the per-user data dir. */
export function overlayDir(base?: string): string {
  return join(base ?? (process.env.TNP_DATA_DIR?.trim() || userDataDir()), 'overlay');
}

export type StoreArea = 'domain-keys' | 'node-keys' | 'grants';

export class OverlayStore {
  constructor(readonly root: string = overlayDir()) {}

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

  /** Atomically replace `path` with `content`, mode 0600, in a 0700 directory. */
  writePrivate(path: string, content: string): void {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
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
}
