/**
 * `tnp connect --autoconnect`: start the overlay client at login.
 *
 * Linux and macOS use a per-user unit / LaunchAgent, which runs with the
 * user's own privileges, so the binary it names is no more trusted than the
 * user. Windows registers an elevated (`/RL HIGHEST`) logon task, and an
 * elevated task that runs a user-writable file is a privilege escalation — so
 * it only ever names the admin-only copy from `installServiceBinary`.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installServiceBinary, isCompiledBinary, serviceBinaryPath, xmlEscape } from './service';
import { type Cmd, findSystemBinary, isRoot, runChecked, runCmd } from './system-cmd';

export const AUTOCONNECT_UNIT = 'tnp-connect.service';
export const AUTOCONNECT_LABEL = 'so.oxy.tnp.connect';
export const AUTOCONNECT_TASK = 'TnpAutoConnect';

export function autoConnectUnit(binaryPath: string): string {
  return `[Unit]
Description=TNP Overlay Client
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${binaryPath} connect
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function autoConnectPlist(binaryPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AUTOCONNECT_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xmlEscape(binaryPath)}</string><string>connect</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>`;
}

/** The elevated logon task. `binaryPath` must be the admin-only service copy. */
export function windowsAutoConnectCommand(schtasks: string, binaryPath: string): Cmd {
  return {
    file: schtasks,
    args: [
      '/Create',
      '/TN',
      AUTOCONNECT_TASK,
      '/TR',
      `"${binaryPath}" connect`,
      '/SC',
      'ONLOGON',
      '/RL',
      'HIGHEST',
      '/F',
    ],
  };
}

export function userUnitPaths(home: string): { unit: string; wants: string } {
  const dir = join(home, '.config', 'systemd', 'user');
  return {
    unit: join(dir, AUTOCONNECT_UNIT),
    wants: join(dir, 'default.target.wants', AUTOCONNECT_UNIT),
  };
}

export function launchAgentPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${AUTOCONNECT_LABEL}.plist`);
}

/** The binary a per-user autostart names: the installed copy when there is one. */
function userBinaryPath(): string {
  const installed = serviceBinaryPath();
  if (existsSync(installed)) return installed;
  if (!isCompiledBinary()) {
    throw new Error('autoconnect needs the compiled tnp binary (bun run build)');
  }
  return process.execPath;
}

/** Register autoconnect for the current user. Throws on failure. */
export function installAutoConnect(): void {
  if (process.platform === 'win32') {
    const schtasks = findSystemBinary('schtasks', 'win32');
    if (!schtasks) throw new Error('schtasks.exe not found');
    runChecked(windowsAutoConnectCommand(schtasks, installServiceBinary()));
    return;
  }

  const binaryPath = userBinaryPath();
  if (process.platform === 'darwin') {
    const path = launchAgentPath(homedir());
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(path, autoConnectPlist(binaryPath), { mode: 0o644 });
    const launchctl = findSystemBinary('launchctl');
    if (!launchctl) throw new Error('launchctl not found');
    runChecked({ file: launchctl, args: ['load', path] });
    return;
  }

  const { unit } = userUnitPaths(homedir());
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(unit, autoConnectUnit(binaryPath), { mode: 0o644 });
  const systemctl = findSystemBinary('systemctl');
  if (!systemctl) throw new Error('systemctl not found');
  runChecked({ file: systemctl, args: ['--user', 'daemon-reload'] });
  runChecked({ file: systemctl, args: ['--user', 'enable', AUTOCONNECT_UNIT] });
  runChecked({ file: systemctl, args: ['--user', 'start', AUTOCONNECT_UNIT] });
}

export interface AutoConnectUser {
  home: string;
  /** Login name, when known; lets root stop another user's unit. */
  user?: string;
}

export interface AutoConnectRemoval {
  removed: string[];
  /** Autostart entries that exist but could not be removed, with the reason. */
  failed: string[];
}

function unlinkInto(path: string, result: AutoConnectRemoval): void {
  try {
    unlinkSync(path);
    result.removed.push(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') result.failed.push(`${path}: ${code ?? String(err)}`);
  }
}

/**
 * Remove autoconnect for each given user. An entry that was never installed is
 * not an error; one that exists and could not be removed is reported, so an
 * uninstall never claims success while an (elevated, on Windows) autostart
 * remains.
 */
export function removeAutoConnect(users: AutoConnectUser[]): AutoConnectRemoval {
  const result: AutoConnectRemoval = { removed: [], failed: [] };

  if (process.platform === 'win32') {
    const schtasks = findSystemBinary('schtasks', 'win32');
    if (!schtasks) {
      result.failed.push(`scheduled task ${AUTOCONNECT_TASK}: schtasks.exe not found`);
      return result;
    }
    const exists = runCmd({ file: schtasks, args: ['/Query', '/TN', AUTOCONNECT_TASK] });
    if (exists.status !== 0) return result;
    const res = runCmd({ file: schtasks, args: ['/Delete', '/TN', AUTOCONNECT_TASK, '/F'] });
    if (res.status === 0) result.removed.push(`scheduled task ${AUTOCONNECT_TASK}`);
    else {
      result.failed.push(
        `scheduled task ${AUTOCONNECT_TASK}: ${(res.stderr || res.stdout).trim() || `exit ${res.status}`}`,
      );
    }
    return result;
  }

  if (process.platform === 'darwin') {
    const launchctl = findSystemBinary('launchctl');
    for (const { home } of users) {
      const path = launchAgentPath(home);
      if (!existsSync(path)) continue;
      if (launchctl) runCmd({ file: launchctl, args: ['unload', path] });
      unlinkInto(path, result);
    }
    return result;
  }

  const systemctl = findSystemBinary('systemctl');
  for (const { home, user } of users) {
    const { unit, wants } = userUnitPaths(home);
    if (!existsSync(unit) && !existsSync(wants)) continue;
    if (systemctl) {
      // Root reaches another user's manager with --machine=<user>@. A failure
      // here (no running user manager) is fine once the files are gone.
      const scope = isRoot() && user && user !== 'root' ? ['--machine', `${user}@`] : [];
      runCmd({ file: systemctl, args: [...scope, '--user', 'disable', '--now', AUTOCONNECT_UNIT] });
    }
    unlinkInto(wants, result);
    unlinkInto(unit, result);
  }
  return result;
}
