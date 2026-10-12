import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import type { TnpConfig } from './config';
import { dataDir, logPath, saveConfig } from './config';
import {
  applyNativeRouting,
  readRoutingState,
  removeNativeRouting,
  repairLegacyWindowsAdapters,
  ROUTED_TLDS,
  routingStatePath,
  type RoutingState,
} from './dns-routing';

const LAUNCHD_LABEL = 'so.oxy.tnp.resolver';
const SYSTEMD_UNIT = 'tnp-resolver.service';
const WIN_TASK_NAME = 'TnpResolver';

/**
 * TLDs the installer routes to the local resolver: `BUILTIN_NATIVE_TLDS` from
 * `@tnp/namespace`, the one list the resolver, the installers and the SOCKS
 * proxy all read. Earlier versions also captured `.app` and `.com` (audit S4).
 *
 * Static rather than fetched: install must work offline, and a device that
 * routes a TLD to TNP because an API said so is the same trust problem in a
 * different place. New native TLDs are picked up by the running resolver's TLD
 * sync; adding one to the *routing* layer is deliberately a release decision.
 */
export const NATIVE_TLDS = ROUTED_TLDS;

const installStatePath = () => routingStatePath(dataDir(), 'install');

/**
 * Record exactly what install added to the OS DNS configuration, so uninstall
 * removes that and nothing else.
 */
function saveInstallState(state: RoutingState): void {
  const path = installStatePath();
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn(
      `[tnp] could not record DNS routing state at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Remove the DNS routing a previous install recorded, and legacy leftovers. */
function removeInstalledRouting(): void {
  const path = installStatePath();
  removeNativeRouting(readRoutingState(path));
  safeUnlink(path);
}

const platform = process.platform;

function run(cmd: string): string {
  return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
}

function runSilent(cmd: string): void {
  try {
    execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' });
  } catch {
    // Best-effort teardown command (e.g. stopping a unit that isn't loaded).
    // Failure is expected and non-fatal — intentionally ignored.
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // File may already be absent; removal is best-effort and non-fatal.
  }
}

// ── macOS (launchd) ──

function installDarwin(binaryPath: string, cfg: TnpConfig): void {
  const plistPath = `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;
  const log = logPath();

  writeFileSync(
    plistPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>${log}</string>
  <key>StandardOutPath</key>
  <string>${log}</string>
</dict>
</plist>`,
  );

  removeInstalledRouting();
  saveInstallState(
    applyNativeRouting({
      owner: 'install',
      target: { address: cfg.listenAddr, port: cfg.listenPort },
    }).state,
  );

  run(`launchctl load ${plistPath}`);
}

function uninstallDarwin(): void {
  runSilent(`launchctl unload /Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`);
  safeUnlink(`/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`);
  removeInstalledRouting();
}

function statusDarwin(): boolean {
  try {
    run(`launchctl list ${LAUNCHD_LABEL}`);
    return true;
  } catch {
    return false;
  }
}

// ── Linux (systemd) ──

/**
 * The resolver's systemd unit.
 *
 * With `link` (systemd-resolved older than 258), the unit itself brings the
 * dedicated `tnp0` routing link up after the resolver starts and takes it
 * down when it stops, so the routing survives reboots and never outlives the
 * resolver it points at. The leading `-` makes a failure non-fatal: the
 * resolver still runs, `.ox` simply is not routed — and no other name is
 * affected either way.
 */
export function buildSystemdUnit(
  binaryPath: string,
  link?: { up: string[]; down: string[] },
): string {
  const lines = [
    '[Unit]',
    'Description=TNP DNS Resolver',
    'After=network.target systemd-resolved.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${binaryPath} run`,
  ];
  if (link) {
    lines.push(`ExecStartPost=-/bin/sh -c '${link.up.join('; ')}'`);
    lines.push(`ExecStopPost=-/bin/sh -c '${link.down.join('; ')}'`);
  }
  lines.push('Restart=always', 'RestartSec=5', '', '[Install]', 'WantedBy=multi-user.target', '');
  return lines.join('\n');
}

function installLinux(binaryPath: string, cfg: TnpConfig): void {
  // Route only TNP-native TLDs, through a resolved DNS delegate or a dedicated
  // link — never the global section or the user's own interface. See
  // dns-routing.ts for why a global `DNS=` entry captures every lookup.
  removeInstalledRouting();
  const { state, unitLink } = applyNativeRouting({
    owner: 'install',
    target: { address: cfg.listenAddr, port: cfg.listenPort },
    linkCommandsInUnit: true,
  });
  saveInstallState(state);

  writeFileSync(`/etc/systemd/system/${SYSTEMD_UNIT}`, buildSystemdUnit(binaryPath, unitLink));

  run('systemctl daemon-reload');
  run(`systemctl enable ${SYSTEMD_UNIT}`);
  run(`systemctl restart ${SYSTEMD_UNIT}`);
}

function uninstallLinux(): void {
  // Stopping runs ExecStopPost, which removes the tnp0 link if there is one.
  runSilent(`systemctl stop ${SYSTEMD_UNIT}`);
  runSilent(`systemctl disable ${SYSTEMD_UNIT}`);
  safeUnlink(`/etc/systemd/system/${SYSTEMD_UNIT}`);
  runSilent('systemctl daemon-reload');
  removeInstalledRouting();
}

function statusLinux(): boolean {
  try {
    run(`systemctl is-active --quiet ${SYSTEMD_UNIT}`);
    return true;
  } catch {
    return false;
  }
}

// ── Windows (Scheduled Task + DNS config) ──

function installWindows(binaryPath: string, cfg: TnpConfig): void {
  // NRPT rules carry no port, so the resolver must answer on 53. `tnp install`
  // already forces this; the interactive menu's install passes the config as
  // loaded, so enforce it here for every entry point.
  if (cfg.listenPort !== 53 || cfg.listenAddr !== '127.0.0.1') {
    cfg.listenPort = 53;
    cfg.listenAddr = '127.0.0.1';
    saveConfig(cfg);
    console.log(
      '[tnp] Windows: resolver set to listen on 127.0.0.1:53 (NRPT cannot use another port)',
    );
  }

  // An install from before this version prepended 127.0.0.1 to every adapter
  // and recorded nothing. Its task exists and our state file does not.
  const legacyInstall = !existsSync(installStatePath()) && windowsTaskExists();

  // Create a scheduled task that runs at startup (as SYSTEM)
  const taskXml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>TNP DNS Resolver</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal>
      <UserId>S-1-5-18</UserId>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions>
    <Exec>
      <Command>${binaryPath.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}</Command>
      <Arguments>run</Arguments>
    </Exec>
  </Actions>
</Task>`;

  const tmpXml = join(process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp', 'tnp-task.xml');
  // Windows Task Scheduler requires UTF-16LE XML.
  // Bun doesn't support "utf-16le" encoding in writeFileSync,
  // so we encode manually with a BOM.
  const utf16Bytes: number[] = [0xff, 0xfe]; // BOM
  for (let i = 0; i < taskXml.length; i++) {
    const code = taskXml.charCodeAt(i);
    utf16Bytes.push(code & 0xff, (code >> 8) & 0xff);
  }
  writeFileSync(tmpXml, Buffer.from(utf16Bytes));
  run(`schtasks /Create /TN "${WIN_TASK_NAME}" /XML "${tmpXml}" /F`);
  safeUnlink(tmpXml);

  // Start it now
  runSilent(`schtasks /Run /TN "${WIN_TASK_NAME}"`);

  // Route .ox (only) to the local resolver with an NRPT rule. Adapter DNS
  // servers are left exactly as the user set them. NRPT has no port, which is
  // why `tnp install` makes the resolver listen on 53.
  removeInstalledRouting();
  const { state } = applyNativeRouting({
    owner: 'install',
    target: { address: cfg.listenAddr, port: cfg.listenPort },
  });
  if (legacyInstall) state.adapterSnapshot = repairLegacyWindowsAdapters();
  saveInstallState(state);
}

function windowsTaskExists(): boolean {
  try {
    run(`schtasks /Query /TN "${WIN_TASK_NAME}"`);
    return true;
  } catch {
    return false;
  }
}

function uninstallWindows(): void {
  const legacyInstall = !existsSync(installStatePath()) && windowsTaskExists();
  runSilent(`schtasks /End /TN "${WIN_TASK_NAME}"`);
  runSilent(`schtasks /Delete /TN "${WIN_TASK_NAME}" /F`);

  // Remove TNP's NRPT rules (and only those). Adapter DNS is never reset: the
  // old -ResetServerAddresses threw away a user's own static resolver and
  // reverted them to the ISP's. An install from before this version is undone
  // gently: only the 127.0.0.1 it prepended is taken out.
  removeInstalledRouting();
  if (legacyInstall) repairLegacyWindowsAdapters();
}

function statusWindows(): boolean {
  try {
    const out = run(`schtasks /Query /TN "${WIN_TASK_NAME}" /FO CSV /NH`);
    return out.includes('Running');
  } catch {
    return false;
  }
}

// ── Auto-detect ──

export function installService(binaryPath: string, cfg: TnpConfig): void {
  switch (platform) {
    case 'darwin':
      installDarwin(binaryPath, cfg);
      return;
    case 'linux':
      installLinux(binaryPath, cfg);
      return;
    case 'win32':
      installWindows(binaryPath, cfg);
      return;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

export function uninstallService(): void {
  switch (platform) {
    case 'darwin':
      uninstallDarwin();
      return;
    case 'linux':
      uninstallLinux();
      return;
    case 'win32':
      uninstallWindows();
      return;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

export function serviceStatus(): boolean {
  switch (platform) {
    case 'darwin':
      return statusDarwin();
    case 'linux':
      return statusLinux();
    case 'win32':
      return statusWindows();
    default:
      return false;
  }
}

export function stopService(): void {
  switch (platform) {
    case 'linux':
      runSilent(`systemctl stop ${SYSTEMD_UNIT}`);
      break;
    case 'darwin':
      runSilent(`launchctl unload /Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`);
      break;
    case 'win32':
      runSilent(`schtasks /End /TN "${WIN_TASK_NAME}"`);
      break;
  }
}

export function startService(): void {
  switch (platform) {
    case 'linux':
      run(`systemctl start ${SYSTEMD_UNIT}`);
      break;
    case 'darwin':
      run(`launchctl load /Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`);
      break;
    case 'win32':
      runSilent(`schtasks /Run /TN "${WIN_TASK_NAME}"`);
      break;
  }
}
