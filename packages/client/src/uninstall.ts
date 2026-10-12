/**
 * `tnp uninstall [--purge]`.
 *
 * Plain uninstall removes everything that *acts*: the resolver service, TNP's
 * DNS routing, kill-switch firewall rules and autoconnect units. It then lists
 * the data that remains — config, identity key, log, binary — because for
 * someone whose device may be seized, "uninstalled" must not quietly mean
 * "evidence left on disk".
 *
 * `--purge` deletes that data as well and says what it deleted.
 *
 * DNS capture and restore are not changed here; `uninstallService` keeps doing
 * exactly what it did.
 */

import { execFileSync } from 'node:child_process';
import { lstatSync, rmdirSync, rmSync, unlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, win32 } from 'node:path';
import { type AutoConnectUser, removeAutoConnect } from './autoconnect';
import { dataDir, logPath, RESOLVER_STATE_DIR } from './config';
import { readRoutingState, removeNativeRouting, routingStatePath } from './dns-routing';
import { disableKillSwitch } from './killswitch';
import { SERVICE_USER, serviceBinaryPath, uninstallService } from './service';
import { findSystemBinary, isRoot, runCmd } from './system-cmd';

export interface Trace {
  path: string;
  what: string;
  /**
   * Set for directories inside a user's home. Only these files are unlinked
   * and the directory removed if then empty — never a recursive delete as root
   * in a tree the user controls, where a swapped-in symlink could aim it
   * elsewhere.
   */
  files?: string[];
}

export interface TraceContext {
  platform: NodeJS.Platform;
  /** Home directories whose per-user TNP data should be considered. */
  homes: string[];
  env: Readonly<Record<string, string | undefined>>;
  /** Null when it could not be determined (Windows registry unreadable). */
  serviceBinary: string | null;
}

/** Files TNP keeps in a per-user (or per-service-account) data directory. */
const DATA_DIR_FILES = [
  'identity.key',
  'tlds.json',
  'dns-routing-install.json',
  'dns-routing-connect.json',
];

/** Every place TNP leaves data, per platform. Pure: decides, does not look. */
export function tnpTraces(ctx: TraceContext): Trace[] {
  if (ctx.platform === 'win32') {
    // Every Windows trace is deleted file by file: the environment of an
    // elevated process is the user's, so a forged %PROGRAMDATA%,
    // %LOCALAPPDATA% or %SystemRoot% must not be able to aim a recursive
    // delete anywhere.
    const localAppData = ctx.env.LOCALAPPDATA;
    const systemRoot = ctx.env.SystemRoot || 'C:\\Windows';
    const programData = win32.join(ctx.env.PROGRAMDATA || 'C:\\ProgramData', 'tnp');
    return [
      {
        // Before its parent, which is removed only once empty.
        path: win32.join(programData, 'dns-rules'),
        what: 'personal DNS rules key and state',
        files: ['key.json', 'state.json', 'envelope.json'],
      },
      {
        path: programData,
        what: 'configuration, kill-switch record and active personal DNS rules',
        files: ['config.json', 'killswitch.json', 'dns-rules.conf'],
      },
      ...(localAppData
        ? [
            {
              path: win32.join(localAppData, 'tnp'),
              what: 'identity key, DNS routing records, TLD cache and log',
              files: [...DATA_DIR_FILES, 'tnp-resolver.log'],
            },
          ]
        : []),
      {
        // The resolver task runs as SYSTEM, whose %LOCALAPPDATA% this is.
        path: win32.join(
          systemRoot,
          'System32',
          'config',
          'systemprofile',
          'AppData',
          'Local',
          'tnp',
        ),
        what: "the resolver service's log and TLD cache",
        files: [...DATA_DIR_FILES, 'tnp-resolver.log'],
      },
      ...(ctx.serviceBinary
        ? [
            {
              path: win32.dirname(ctx.serviceBinary),
              what: 'installed tnp binary',
              files: [win32.basename(ctx.serviceBinary)],
            },
          ]
        : []),
    ];
  }

  const shared: Trace[] = [
    { path: '/var/log/tnp-resolver.log', what: 'resolver log' },
    ...(ctx.serviceBinary ? [{ path: ctx.serviceBinary, what: 'tnp binary' }] : []),
  ];
  if (ctx.platform === 'darwin') {
    return [
      {
        path: '/usr/local/etc/tnp',
        what: 'configuration (may hold a relay auth token) and active personal DNS rules',
      },
      {
        path: '/Library/Application Support/tnp',
        what: 'kill-switch record and personal DNS rules key',
      },
      ...ctx.homes.map((home) => ({
        path: join(home, 'Library', 'Application Support', 'tnp'),
        what: 'identity key, DNS routing records and TLD cache',
        files: DATA_DIR_FILES,
      })),
      ...shared,
    ];
  }
  return [
    {
      path: '/etc/tnp',
      what: 'configuration (may hold a relay auth token) and active personal DNS rules',
    },
    {
      path: '/var/lib/tnp',
      what: 'identity key, kill-switch record, DNS routing records, TLD cache and personal DNS rules key',
    },
    {
      // Owned by the resolver's service user, so never deleted recursively.
      path: RESOLVER_STATE_DIR,
      what: "the resolver service's TLD cache",
      files: ['tlds.json'],
    },
    ...shared,
  ];
}
const USERNAME_RE = /^[a-z_][a-z0-9_.-]*$/i;

/** Home directory of `user`, from the system account database. */
function homeOf(user: string): string | null {
  if (!USERNAME_RE.test(user)) return null;
  try {
    if (process.platform === 'darwin') {
      const dscl = findSystemBinary('dscl');
      if (!dscl) return null;
      const out = execFileSync(dscl, ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'], {
        encoding: 'utf-8',
      });
      return /NFSHomeDirectory:\s*(\S.*)$/m.exec(out)?.[1]?.trim() ?? null;
    }
    const getent = findSystemBinary('getent');
    if (!getent) return null;
    const out = execFileSync(getent, ['passwd', user], { encoding: 'utf-8' });
    return out.trim().split(':')[5] || null;
  } catch {
    return null;
  }
}

/**
 * The users whose per-user TNP files to consider: the current one, plus the
 * user who invoked `sudo` — whose home, not root's, holds their autoconnect
 * unit and (on macOS) their identity key.
 */
export function affectedUsers(): AutoConnectUser[] {
  const users: AutoConnectUser[] = [{ home: homedir(), user: userInfo().username }];
  const sudoUser = process.env.SUDO_USER;
  if (process.platform !== 'win32' && isRoot() && sudoUser && sudoUser !== 'root') {
    const home = homeOf(sudoUser);
    if (home && home !== users[0].home) users.push({ home, user: sudoUser });
  }
  return users;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Delete a trace. Throws on failure. */
function removeTrace(trace: Trace): void {
  if (!trace.files) {
    rmSync(trace.path, { recursive: true, force: true });
    return;
  }
  for (const file of trace.files) {
    try {
      unlinkSync(join(trace.path, file));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  try {
    rmdirSync(trace.path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTEMPTY' || code === 'EEXIST') {
      throw new Error(`${trace.path} still holds files TNP did not create; left in place`);
    }
    if (code !== 'ENOENT') throw err;
  }
}

export interface UninstallReport {
  /** What was removed. */
  done: string[];
  /** Data still on disk (plain uninstall). */
  remaining: Trace[];
  /** Steps that failed, each with what to do about it. */
  failed: string[];
  /** What TNP cannot remove itself. */
  notes: string[];
}

export function performUninstall(opts: { purge: boolean; publicDnsIp: string }): UninstallReport {
  const report: UninstallReport = { done: [], remaining: [], failed: [], notes: [] };

  uninstallService();
  report.done.push('resolver service and the DNS configuration TNP installed');

  // A `tnp connect` that died without restoring left its routing recorded.
  // Remove exactly that, through the same path connect itself uses.
  const connectState = routingStatePath(dataDir(), 'connect');
  if (exists(connectState)) {
    try {
      removeNativeRouting(readRoutingState(connectState));
      unlinkSync(connectState);
      report.done.push('DNS routing left by an interrupted `tnp connect`');
    } catch (err) {
      report.failed.push(`DNS routing left by \`tnp connect\`: ${errorMessage(err)}`);
    }
  }

  try {
    const { residual } = disableKillSwitch(opts.publicDnsIp);
    if (residual.length === 0) report.done.push('kill-switch firewall rules (if any)');
    else report.failed.push(`kill-switch rules still present: ${residual.join(', ')}`);
  } catch (err) {
    report.failed.push(`kill-switch rules: ${errorMessage(err)}`);
  }

  const users = affectedUsers();
  const autoconnect = removeAutoConnect(users);
  for (const item of autoconnect.removed) report.done.push(`autoconnect: ${item}`);
  for (const item of autoconnect.failed) report.failed.push(`autoconnect: ${item}`);

  let serviceBinary: string | null = null;
  try {
    serviceBinary = serviceBinaryPath();
  } catch (err) {
    report.failed.push(`locating the installed binary: ${errorMessage(err)}`);
  }

  const traces = tnpTraces({
    platform: process.platform,
    homes: users.map((u) => u.home),
    env: process.env,
    serviceBinary,
  }).filter((t) => exists(t.path));

  if (!opts.purge) {
    report.remaining = traces;
    return report;
  }

  for (const trace of traces) {
    try {
      removeTrace(trace);
      report.done.push(`${trace.what}: ${trace.path}`);
    } catch (err) {
      const hint =
        process.platform === 'win32' && trace.what === 'installed tnp binary'
          ? ' (a running tnp.exe cannot be deleted; delete the folder after this command exits)'
          : '';
      report.failed.push(`${trace.path}: ${errorMessage(err)}${hint}`);
    }
  }

  if (process.platform === 'linux') {
    const id = findSystemBinary('id');
    const userdel = findSystemBinary('userdel');
    if (id && runCmd({ file: id, args: ['-u', SERVICE_USER] }).status === 0) {
      const res = userdel ? runCmd({ file: userdel, args: [SERVICE_USER] }) : null;
      if (res?.status === 0) report.done.push(`system account "${SERVICE_USER}"`);
      else
        report.failed.push(
          `system account "${SERVICE_USER}": remove it with userdel ${SERVICE_USER}`,
        );
    }
    report.notes.push(
      'systemd journal entries from tnp-resolver.service are not removed by TNP; `journalctl --rotate && journalctl --vacuum-time=1s` deletes them, together with ALL other journal history.',
    );
  }
  if (process.platform === 'darwin') {
    report.notes.push(
      `launchd's own records and unified logs may still mention ${logPath()} and the TNP resolver; TNP cannot remove them.`,
    );
  }
  report.notes.push('Shell history may still contain tnp commands, including any --token value.');
  return report;
}

/** Lines for the CLI and the interactive menu. */
export function formatUninstallReport(report: UninstallReport, purge: boolean): string[] {
  const lines: string[] = [];
  for (const item of report.done) lines.push(`removed: ${item}`);
  for (const item of report.failed) lines.push(`FAILED: ${item}`);
  if (!purge && report.remaining.length > 0) {
    lines.push('', 'This data is still on disk:');
    for (const t of report.remaining) lines.push(`  ${t.path} — ${t.what}`);
    lines.push(
      process.platform === 'win32'
        ? 'Run `tnp uninstall --purge` as Administrator to delete it.'
        : 'Run `sudo tnp uninstall --purge` to delete it.',
    );
  }
  if (purge) for (const note of report.notes) lines.push(`note: ${note}`);
  return lines;
}
