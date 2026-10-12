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
  closeSync,
  fchmodSync,
  fchownSync,
  constants as fsConstants,
  lstatSync as fsLstatSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { posix, win32 } from 'node:path';
import { type Cmd, type CmdRunner, findSystemBinary, runChecked, runCmd } from './system-cmd';

/** Well-known Windows SIDs, so ACLs never depend on localized account names. */
export const WIN_SID = {
  system: 'S-1-5-18',
  administrators: 'S-1-5-32-544',
  users: 'S-1-5-32-545',
  /** OWNER RIGHTS: whoever owns the object (the user who created it). */
  ownerRights: 'S-1-3-4',
  trustedInstaller: 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464',
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

const ADMIN_GRANTS = [`*${WIN_SID.system}:(OI)(CI)F`, `*${WIN_SID.administrators}:(OI)(CI)F`];

function profileGrants(profile: WindowsAclProfile): string[] {
  if (profile === 'private-file') {
    return [`*${WIN_SID.system}:F`, `*${WIN_SID.administrators}:F`, `*${WIN_SID.ownerRights}:F`];
  }
  return profile === 'program-dir'
    ? [...ADMIN_GRANTS, `*${WIN_SID.users}:(OI)(CI)RX`]
    : ADMIN_GRANTS;
}

/**
 * The `icacls` invocations that lock `path` itself under `profile`, without
 * touching anything below it.
 *
 * Every one carries `/L`, so a path that is (or is swapped for) a symbolic link
 * or junction has the link changed, never its target: a junction planted at
 * `C:\ProgramData\tnp` must not turn "reset this ACL" into "reset System32's".
 * Ownership is taken first, then `/reset` drops every explicit entry (a
 * squatter's own ACE included, which `/grant:r` alone would keep), then
 * inheritance is cut and only the profile's entries granted.
 */
export function windowsAclCommands(
  icacls: string,
  path: string,
  profile: WindowsAclProfile,
): Cmd[] {
  const cmds: Cmd[] = [];
  if (profile !== 'private-file') {
    cmds.push({
      file: icacls,
      args: [path, '/setowner', `*${WIN_SID.administrators}`, '/L', '/Q'],
    });
  }
  cmds.push(
    { file: icacls, args: [path, '/reset', '/L', '/Q'] },
    {
      file: icacls,
      args: [path, '/inheritance:r', '/grant:r', ...profileGrants(profile), '/L', '/Q'],
    },
  );
  return cmds;
}

/**
 * The `icacls` invocations that hand each descendant of an already locked
 * directory to Administrators and make it inherit only from that directory.
 *
 * One object per call, with `/L` and no `/T`: icacls' own recursion follows
 * junctions, and the list here comes from a probe that has already refused
 * any reparse point in the tree.
 */
export function windowsDescendantCommands(icacls: string, descendants: string[]): Cmd[] {
  return descendants.flatMap((path) => [
    { file: icacls, args: [path, '/setowner', `*${WIN_SID.administrators}`, '/L', '/Q'] },
    { file: icacls, args: [path, '/reset', '/L', '/Q'] },
  ]);
}

/** One access rule as `Get-Acl` reports it, with the trustee as a SID. */
export interface WindowsAclRule {
  sid: string;
  /** The raw access mask (`FileSystemRights`), as an unsigned 32-bit value. */
  rights: number;
  allow: boolean;
  /** Applies only to children, not to this object. */
  inheritOnly: boolean;
}

/** One filesystem object from {@link windowsAclProbeScript}. */
export interface WindowsAclEntry {
  path: string;
  dir: boolean;
  /** A symbolic link, junction or other reparse point: never descended into. */
  reparse: boolean;
  /** Owner SID; null for a reparse point, whose ACL is not read. */
  owner: string | null;
  rules: WindowsAclRule[];
}

function psUtf16Literal(value: string): string {
  return `[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf16le').toString('base64')}'))`;
}

/**
 * A PowerShell script printing, as JSON, the owner and access rules of each of
 * `paths` and — with `recurse` — of everything below them. It never descends
 * into a reparse point, and reports one instead of reading through it.
 *
 * Paths travel in and out as base64 UTF-16, so neither quoting nor the console
 * code page can change a name. Works in Windows PowerShell 5.1.
 */
export function windowsAclProbeScript(paths: string[], recurse: boolean): string {
  return `$ErrorActionPreference = 'Stop'
$roots = @(${paths.map(psUtf16Literal).join(', ')})
$recurse = $${recurse ? 'true' : 'false'}
$sidType = [System.Security.Principal.SecurityIdentifier]
$out = New-Object System.Collections.ArrayList
$queue = New-Object System.Collections.Queue
foreach ($root in $roots) { $queue.Enqueue((Get-Item -LiteralPath $root -Force)) }
while ($queue.Count -gt 0) {
  $item = $queue.Dequeue()
  $reparse = ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
  $entry = [ordered]@{
    path = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($item.FullName))
    dir = [bool]$item.PSIsContainer
    reparse = [bool]$reparse
    owner = $null
    rules = @()
  }
  if (-not $reparse) {
    $acl = Get-Acl -LiteralPath $item.FullName
    $entry.owner = $acl.GetOwner($sidType).Value
    $entry.rules = @($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object {
      [ordered]@{
        sid = $_.IdentityReference.Value
        rights = [long]([int]$_.FileSystemRights)
        allow = ($_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow)
        inheritOnly = (($_.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)
      }
    })
    if ($recurse -and $item.PSIsContainer) {
      foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) { $queue.Enqueue($child) }
    }
  }
  [void]$out.Add($entry)
}
ConvertTo-Json -InputObject @($out) -Depth 6 -Compress
`;
}

const SID_RE = /^S-1-[0-9]+(-[0-9]+)*$/;

/** Parse the probe's output strictly: anything unexpected is an error, not a pass. */
export function parseWindowsAclProbe(stdout: string): WindowsAclEntry[] {
  const raw: unknown = JSON.parse(stdout.trim());
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) throw new Error('ACL probe returned nothing');
  return list.map((value): WindowsAclEntry => {
    if (typeof value !== 'object' || value === null) throw new Error('malformed ACL probe entry');
    const e = value as Record<string, unknown>;
    if (
      typeof e.path !== 'string' ||
      typeof e.dir !== 'boolean' ||
      typeof e.reparse !== 'boolean'
    ) {
      throw new Error('malformed ACL probe entry');
    }
    const path = Buffer.from(e.path, 'base64').toString('utf16le');
    if (e.reparse) return { path, dir: e.dir, reparse: true, owner: null, rules: [] };
    if (typeof e.owner !== 'string' || !SID_RE.test(e.owner)) {
      throw new Error(`ACL probe gave no owner SID for ${path}`);
    }
    const rulesRaw = e.rules === null || e.rules === undefined ? [] : e.rules;
    const rules = (Array.isArray(rulesRaw) ? rulesRaw : [rulesRaw]).map((r): WindowsAclRule => {
      const rule = r as Record<string, unknown>;
      if (
        typeof rule.sid !== 'string' ||
        !SID_RE.test(rule.sid) ||
        typeof rule.rights !== 'number' ||
        !Number.isInteger(rule.rights) ||
        typeof rule.allow !== 'boolean' ||
        typeof rule.inheritOnly !== 'boolean'
      ) {
        throw new Error(`malformed ACL rule for ${path}`);
      }
      return {
        sid: rule.sid,
        rights: rule.rights >>> 0,
        allow: rule.allow,
        inheritOnly: rule.inheritOnly,
      };
    });
    return { path, dir: e.dir, reparse: false, owner: e.owner, rules };
  });
}

/** FILE_GENERIC_READ | FILE_GENERIC_EXECUTE (icacls `RX`), plus GENERIC_READ/EXECUTE. */
const READ_EXECUTE_MASK = 0x001200a9 | 0x80000000 | 0x20000000;
/** Rights over a container that let a holder rename, delete or re-permission what is in it. */
const REPLACE_MASK =
  0x00010000 /* DELETE */ |
  0x00040000 /* WRITE_DAC */ |
  0x00080000 /* WRITE_OWNER */ |
  0x00000040 /* FILE_DELETE_CHILD */ |
  0x10000000; /* GENERIC_ALL */

const ADMIN_SIDS: ReadonlySet<string> = new Set([WIN_SID.system, WIN_SID.administrators]);
const TRUSTED_OWNERS: ReadonlySet<string> = new Set([...ADMIN_SIDS, WIN_SID.trustedInstaller]);

/**
 * Everything about `entries` that does not match `profile`, as messages; empty
 * when the tree is exactly what the profile says. `entries[0]` is the profiled
 * path itself, the rest its descendants.
 */
export function windowsAclProblems(
  entries: WindowsAclEntry[],
  profile: WindowsAclProfile,
): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    if (entry.reparse) {
      problems.push(`${entry.path} is a symbolic link or junction`);
      continue;
    }
    if (profile !== 'private-file' && !TRUSTED_OWNERS.has(entry.owner ?? '')) {
      problems.push(`${entry.path} is owned by ${entry.owner}, not SYSTEM or Administrators`);
    }
    for (const rule of entry.rules) {
      if (!rule.allow || ADMIN_SIDS.has(rule.sid)) continue;
      if (profile === 'private-file' && rule.sid === WIN_SID.ownerRights) continue;
      if (
        profile === 'program-dir' &&
        rule.sid === WIN_SID.users &&
        (rule.rights & ~READ_EXECUTE_MASK) >>> 0 === 0
      ) {
        continue;
      }
      problems.push(
        `${entry.path} grants ${rule.sid} access 0x${rule.rights.toString(16).padStart(8, '0')}`,
      );
    }
  }
  return problems;
}

/**
 * Problems with the directories above a program directory: any that a
 * non-administrator could rename, delete or re-permission — and so swap the
 * program directory out from under the SYSTEM task that runs from it. Rules
 * that apply only to children are skipped: what a directory hands down shows
 * up in each child's own ACL, which is checked as that child.
 */
export function windowsAncestorProblems(entries: WindowsAclEntry[]): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    if (entry.reparse) {
      problems.push(`${entry.path} is a symbolic link or junction`);
      continue;
    }
    if (!TRUSTED_OWNERS.has(entry.owner ?? '')) {
      problems.push(
        `${entry.path} is owned by ${entry.owner}, not SYSTEM, Administrators or TrustedInstaller`,
      );
    }
    for (const rule of entry.rules) {
      if (!rule.allow || rule.inheritOnly || TRUSTED_OWNERS.has(rule.sid)) continue;
      if ((rule.rights & REPLACE_MASK) !== 0) {
        problems.push(
          `${entry.path} lets ${rule.sid} delete, rename or re-permission it or its contents (0x${rule.rights.toString(16).padStart(8, '0')})`,
        );
      }
    }
  }
  return problems;
}

/** The directories above `path`, nearest first, ending at the drive root. */
export function windowsAncestors(path: string): string[] {
  const out: string[] = [];
  let current = win32.resolve(path);
  for (;;) {
    const parent = win32.dirname(current);
    if (parent === current) break;
    out.push(parent);
    current = parent;
  }
  return out;
}

/** What `restrictWindowsAcl` touches on the machine; injectable for tests. */
export interface WindowsAclHost {
  run: CmdRunner;
  icacls: string;
  powershell: string;
  lstat(path: string): { isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean };
}

function defaultWindowsAclHost(): WindowsAclHost {
  const icacls = findSystemBinary('icacls', 'win32');
  if (!icacls) throw new Error('icacls.exe not found; cannot set Windows permissions');
  const powershell = findSystemBinary('powershell', 'win32');
  if (!powershell) throw new Error('powershell.exe not found; cannot verify Windows permissions');
  return { run: runCmd, icacls, powershell, lstat: fsLstatSync };
}

/** Run the ACL probe for `paths`. */
export function probeWindowsAcl(
  host: Pick<WindowsAclHost, 'run' | 'powershell'>,
  paths: string[],
  recurse: boolean,
): WindowsAclEntry[] {
  const script = windowsAclProbeScript(paths, recurse);
  const res = runChecked(
    {
      file: host.powershell,
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
    },
    host.run,
  );
  return parseWindowsAclProbe(res.stdout);
}

/**
 * Put `path` under a Windows ACL profile, and verify the result. Throws if any
 * step fails or the verified ACLs are not exactly what the profile allows.
 *
 * A directory is locked first (owner, reset, inheritance cut) on its own, so
 * whoever squatted it can no longer add entries; then the whole tree is probed
 * and refused if it holds a symbolic link, a junction, or a subdirectory owned
 * by anyone but SYSTEM or Administrators (its owner could still plant a
 * junction in it). Each descendant is then reset to inherit from the locked
 * directory — which removes the explicit Users entries a config or key file
 * from an older build may carry — and the tree is probed again and checked
 * entry by entry.
 */
export function restrictWindowsAcl(
  path: string,
  profile: WindowsAclProfile,
  host: WindowsAclHost = defaultWindowsAclHost(),
): void {
  const st = host.lstat(path);
  if (st.isSymbolicLink()) {
    throw new Error(`${path} is a symbolic link or junction; refusing to change its permissions`);
  }
  const wantDir = profile !== 'private-file';
  if (wantDir ? !st.isDirectory() : !st.isFile()) {
    throw new Error(`${path} is not a ${wantDir ? 'directory' : 'regular file'}; refusing`);
  }
  if (wantDir) {
    // Before anything changes: an ACL change on a directory propagates to its
    // children, so a link already planted inside must stop us here.
    const links = probeWindowsAcl(host, [path], true).filter((e) => e.reparse);
    if (links.length > 0) {
      throw new Error(
        `${path} holds symbolic links or junctions TNP did not create (${links.map((e) => e.path).join('; ')}). Refusing to change its permissions; delete ${path} as Administrator and retry.`,
      );
    }
  }
  for (const cmd of windowsAclCommands(host.icacls, path, profile)) runChecked(cmd, host.run);

  if (wantDir) {
    const before = probeWindowsAcl(host, [path], true);
    const descendants = before.slice(1);
    const unsafe = descendants
      .filter((e) => e.reparse || (e.dir && !TRUSTED_OWNERS.has(e.owner ?? '')))
      .map((e) =>
        e.reparse
          ? `${e.path} is a symbolic link or junction`
          : `${e.path} is a directory owned by ${e.owner}`,
      );
    if (unsafe.length > 0) {
      throw new Error(
        `${path} holds entries TNP did not create (${unsafe.join('; ')}). Refusing to continue; delete ${path} as Administrator and retry.`,
      );
    }
    for (const cmd of windowsDescendantCommands(
      host.icacls,
      descendants.map((e) => e.path),
    )) {
      runChecked(cmd, host.run);
    }
  }

  const problems = windowsAclProblems(probeWindowsAcl(host, [path], wantDir), profile);
  if (problems.length > 0) {
    throw new Error(`permissions on ${path} are not as required: ${problems.join('; ')}`);
  }
}

/**
 * Refuse a program directory whose ancestors a non-administrator could rename,
 * delete or re-permission.
 */
export function assertWindowsAncestorsSafe(
  path: string,
  host: Pick<WindowsAclHost, 'run' | 'powershell'> = defaultWindowsAclHost(),
): void {
  const problems = windowsAncestorProblems(probeWindowsAcl(host, windowsAncestors(path), false));
  if (problems.length > 0) {
    throw new Error(
      `a non-administrator could replace ${path} through a parent directory: ${problems.join('; ')}. Refusing to install there.`,
    );
  }
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
  // POSIX only (uid and mode bits); `posix` so the walk is the same whatever
  // OS the tests run on.
  const parts = posix.resolve(path).split('/').filter(Boolean);
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
 * Give an existing regular file exact ownership and mode, without following a
 * symlink. Returns false when nothing is at `path`.
 *
 * The file is opened with O_NOFOLLOW (and O_NONBLOCK, so a FIFO cannot hang
 * the call), checked through the descriptor, and changed with fchown/fchmod on
 * that same descriptor: there is no window between "checked it is a plain
 * file" and "changed it" in which a symlink could be swapped in, as there is
 * with lstat followed by chown/chmod (which both follow symlinks).
 */
export function settlePlainFile(
  path: string,
  owner: { uid: number; gid: number } | null,
  mode: number,
): boolean {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    if (code === 'ELOOP' || code === 'EMLINK') {
      throw new Error(`${path} is a symbolic link; refusing to touch it`);
    }
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile())
      throw new Error(`${path} is not a regular file; refusing to touch it`);
    if (owner) fchownSync(fd, owner.uid, owner.gid);
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
  return true;
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
