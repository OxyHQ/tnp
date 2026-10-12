/**
 * Filesystem primitives for files that hold secrets or that root acts on.
 *
 * The threat this exists for: a local unprivileged process (another user, or
 * malware running as the user) planting a symlink, a FIFO or a replacement file
 * where a privileged TNP process will later write, read or execute. Every helper
 * here refuses rather than follows when the path is not what it should be.
 */

import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  lstatSync as fsLstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve, sep } from 'node:path';
import { type Cmd, type CmdRunner, findSystemBinary, runChecked, runCmd } from './system-cmd';

/** Well-known Windows SIDs, so ACLs never depend on localized account names. */
export const WIN_SID = {
  system: 'S-1-5-18',
  administrators: 'S-1-5-32-544',
  users: 'S-1-5-32-545',
  /** OWNER RIGHTS: whoever owns the object (the user who created it). */
  ownerRights: 'S-1-3-4',
} as const;

/**
 * Who may touch a Windows path.
 *
 * - `admin-only`: SYSTEM and Administrators, full control, inherited by
 *   everything below (config and state directories).
 * - `program-dir`: as `admin-only`, plus read/execute for Users (the directory
 *   the service binary runs from).
 * - `private-file`: SYSTEM, Administrators and the file's owner only (a key
 *   file a non-elevated user may legitimately need to read).
 */
export type WindowsAclProfile = 'admin-only' | 'program-dir' | 'private-file';

/**
 * The `icacls` invocations that put `path` under `profile`.
 *
 * Ownership is taken first and explicit entries are reset before inheritance is
 * cut, because `/grant:r` only replaces entries for the SIDs it names: a
 * directory squatted by an unprivileged user before install would otherwise
 * keep that user's explicit ACE, and ownership would let them re-add it.
 */
export function windowsAclCommands(
  icacls: string,
  path: string,
  profile: WindowsAclProfile,
): Cmd[] {
  if (profile === 'private-file') {
    return [
      {
        file: icacls,
        args: [
          path,
          '/inheritance:r',
          '/grant:r',
          `*${WIN_SID.system}:F`,
          `*${WIN_SID.administrators}:F`,
          `*${WIN_SID.ownerRights}:F`,
          '/Q',
        ],
      },
    ];
  }
  const grants = [`*${WIN_SID.system}:(OI)(CI)F`, `*${WIN_SID.administrators}:(OI)(CI)F`];
  if (profile === 'program-dir') grants.push(`*${WIN_SID.users}:(OI)(CI)RX`);
  return [
    { file: icacls, args: [path, '/setowner', `*${WIN_SID.administrators}`, '/T', '/Q'] },
    { file: icacls, args: [path, '/reset', '/T', '/Q'] },
    { file: icacls, args: [path, '/inheritance:r', '/grant:r', ...grants, '/Q'] },
  ];
}

/** Apply a Windows ACL profile. Throws if any step fails. */
export function restrictWindowsAcl(
  path: string,
  profile: WindowsAclProfile,
  run: CmdRunner = runCmd,
): void {
  const icacls = findSystemBinary('icacls', 'win32');
  if (!icacls) throw new Error(`icacls.exe not found; cannot restrict access to ${path}`);
  for (const cmd of windowsAclCommands(icacls, path, profile)) runChecked(cmd, run);
}

/** The slice of `fs.Stats` the trust walk reads; injectable for tests. */
export interface PathStat {
  uid: number;
  mode: number;
  isSymbolicLink(): boolean;
}
export type LstatFn = (path: string) => PathStat;

/**
 * The first component of `path` (from `/` down to the path itself) that a
 * non-root user could replace, or null when the whole chain is root-controlled.
 *
 * A component is untrusted when it is not owned by root, or is group- or
 * world-writable. A sticky world-writable directory such as `/tmp` is
 * untrusted too: its sticky bit stops deletion, not a planted sibling. `path`
 * must already be resolved (`realpath`) so a symlink cannot route the walk.
 */
export function findUntrustedComponent(path: string, lstat: LstatFn = fsLstatSync): string | null {
  const parts = resolve(path).split(sep).filter(Boolean);
  const chain = ['/', ...parts.map((_, i) => `/${parts.slice(0, i + 1).join('/')}`)];
  for (const component of chain) {
    let st: ReturnType<LstatFn>;
    try {
      st = lstat(component);
    } catch {
      return component;
    }
    if (st.isSymbolicLink()) return component;
    if (st.uid !== 0) return component;
    if ((st.mode & 0o022) !== 0) return component;
  }
  return null;
}

/**
 * Create (or tighten) a directory only the current user can enter.
 *
 * Refuses a symlink, a non-directory, or a directory owned by someone else: in
 * each case another user controls what lands inside it.
 */
export function ensurePrivateDir(path: string, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (platform === 'win32') {
    restrictWindowsAcl(path, 'admin-only');
    return;
  }
  const st = fsLstatSync(path);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`${path} is not a plain directory; refusing to use it`);
  }
  const euid = process.geteuid?.();
  if (euid !== undefined && st.uid !== euid) {
    throw new Error(`${path} is owned by uid ${st.uid}, not ${euid}; refusing to use it`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

/**
 * Write `data` to `path` atomically with exact permissions.
 *
 * The temporary file is created with O_EXCL (`wx`), so a pre-planted symlink or
 * FIFO at that name makes the write fail instead of being followed, and the
 * rename means a reader never sees a half-written file. `mode` is re-applied
 * after creation because the process umask can only remove bits, and an
 * existing file's mode is otherwise left as it was.
 */
export function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: { mode?: number; gid?: number } = {},
): void {
  const mode = options.mode ?? 0o600;
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, data, { mode, flag: 'wx' });
    if (process.platform !== 'win32') {
      chmodSync(tmp, mode);
      if (options.gid !== undefined) chownSync(tmp, 0, options.gid);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // The temporary file may never have been created.
    }
    throw err;
  }
}
