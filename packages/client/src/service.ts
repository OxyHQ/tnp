import {
  chmodSync,
  chownSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, join, win32 } from 'node:path';
import type { TnpConfig } from './config';
import {
  configDir,
  configPath,
  logPath,
  routingStateDirs,
  saveConfig,
  systemStateDir,
  writeSystemStateFile,
} from './config';
import {
  applyNativeRouting,
  readRecordedRouting,
  removeNativeRouting,
  repairLegacyWindowsAdapters,
  ROUTED_TLDS,
  routingStatePath,
  type RoutingState,
} from './dns-routing';
import {
  assertWindowsAncestorsSafe,
  ensurePrivateDir,
  findUntrustedComponent,
  restrictWindowsAcl,
  settlePlainFile,
  writeFileAtomic,
} from './secure-fs';
import { findSystemBinary, isRoot, requireSystemBinary, runChecked, runCmd } from './system-cmd';
import { isCompiledBinary } from './update';
import { parseRegSz, windowsProgramFiles as readWindowsProgramFiles } from './windows-paths';

export const LAUNCHD_LABEL = 'so.oxy.tnp.resolver';
export const LAUNCHD_PLIST = `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;
export const SYSTEMD_UNIT = 'tnp-resolver.service';
export const SYSTEMD_UNIT_PATH = `/etc/systemd/system/${SYSTEMD_UNIT}`;
export const WIN_TASK_NAME = 'TnpResolver';
/** The unprivileged system account the Linux resolver daemon runs as. */
export const SERVICE_USER = 'tnp';

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

/**
 * Record exactly what install added to the OS DNS configuration, so uninstall
 * removes that and nothing else. Root/Administrators only (routingStateDirs).
 */
function saveInstallState(state: RoutingState): void {
  const path = routingStatePath(routingStateDirs().current, 'install');
  try {
    writeSystemStateFile(path, `${JSON.stringify(state, null, 2)}\n`);
  } catch (err) {
    console.warn(
      `[tnp] could not record DNS routing state at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Whether an install recorded its routing (here or where 0.5.1 kept it). */
function installRecorded(): boolean {
  const dirs = routingStateDirs();
  return [dirs.current, dirs.legacy]
    .filter((dir): dir is string => dir !== null)
    .some((dir) => existsSync(routingStatePath(dir, 'install')));
}

/** Remove the DNS routing a previous install recorded, and legacy leftovers. */
function removeInstalledRouting(): void {
  const { state, paths } = readRecordedRouting('install', routingStateDirs());
  removeNativeRouting(state);
  for (const path of paths) safeUnlink(path);
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

// ── The binary a service runs ──

// Only a compiled binary can be installed as a service: for a script,
// `process.execPath` is the Bun runtime, not TNP. Shared with `tnp update`.
export { isCompiledBinary };

export { parseRegSz };

/**
 * `%ProgramFiles%`, read from HKLM rather than the environment: an elevated
 * process inherits the user's environment, and a user-level `ProgramFiles`
 * variable would otherwise choose where SYSTEM's binary lives. No fallback to
 * the environment; unreadable or not a local absolute path is an error.
 */
const windowsProgramFiles = (): string => readWindowsProgramFiles();

/**
 * Where the binary that system services and elevated tasks execute lives: a
 * location only administrators can write.
 *
 * Pointing a SYSTEM boot task or a root unit at the copy the user downloaded —
 * or at whatever `which tnp` found — lets anyone who can write that file run
 * code as SYSTEM/root.
 */
export function serviceBinaryPath(
  target: NodeJS.Platform = platform,
  programFiles: () => string = windowsProgramFiles,
): string {
  if (target === 'win32') return win32.join(programFiles(), 'TNP', 'tnp.exe');
  return '/usr/local/bin/tnp';
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Put a copy of this binary at `serviceBinaryPath()` and return that path.
 *
 * POSIX: needs root, and refuses unless every component of the destination is
 * root-owned and not group/world-writable (a Homebrew-owned `/usr/local/bin` on
 * an Intel Mac fails this). Windows: refuses unless no non-administrator can
 * rename, delete or re-permission any directory above the destination; then
 * the destination directory's ACL is set to SYSTEM/Administrators (Users
 * read/execute), and verified, before anything is copied in.
 */
export function installServiceBinary(): string {
  if (!isCompiledBinary()) {
    throw new Error(
      'the service must run the compiled tnp binary; build it (bun run build) and run install from that binary',
    );
  }
  const target = serviceBinaryPath();
  const dir = dirname(target);
  const self = process.execPath;

  if (platform === 'win32') {
    // Locking down TNP's own directory is worth nothing if a user can rename
    // %ProgramFiles% (or anything above it) and put another one in its place.
    assertWindowsAncestorsSafe(dir);
    mkdirSync(dir, { recursive: true });
    restrictWindowsAcl(dir, 'program-dir');
    if (!sameFile(self, target)) {
      // A running task holds the file open; stop it so it can be replaced.
      const schtasks = findSystemBinary('schtasks', 'win32');
      if (schtasks) runCmd({ file: schtasks, args: ['/End', '/TN', WIN_TASK_NAME] });
      const tmp = join(dir, `tnp.exe.${randomBytes(6).toString('hex')}.new`);
      copyFileSync(self, tmp, fsConstants.COPYFILE_EXCL);
      renameSync(tmp, target);
    }
    return target;
  }

  if (!isRoot()) {
    throw new Error('installing the system service needs root: rerun with sudo');
  }
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const untrustedDir = findUntrustedComponent(realpathSync(dir));
  if (untrustedDir) {
    throw new Error(
      `${untrustedDir} is not root-owned or is writable by other users, so a service binary in ${dir} could be replaced by a non-root user. Refusing to install; make it root-owned and not group/world-writable, then retry.`,
    );
  }
  if (!sameFile(self, target)) {
    const tmp = join(dir, `.tnp.${randomBytes(6).toString('hex')}.new`);
    try {
      copyFileSync(self, tmp, fsConstants.COPYFILE_EXCL);
      chownSync(tmp, 0, 0);
      chmodSync(tmp, 0o755);
      renameSync(tmp, target);
    } catch (err) {
      safeUnlink(tmp);
      throw err;
    }
  }
  const untrusted = findUntrustedComponent(realpathSync(target));
  if (untrusted) {
    throw new Error(`${untrusted} could be replaced by a non-root user; refusing to install`);
  }
  return target;
}

// ── Service definitions (pure, so tests can read them on any OS) ──

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * The resolver's systemd unit.
 *
 * The daemon answers DNS on loopback and fetches from the TNP API — nothing
 * more — so it runs as an unprivileged system user holding only the capability
 * to bind port 53, with the filesystem read-only and the kernel surfaces it
 * does not use closed. Logs go to the journal; the daemon reads only the
 * secret-free `/etc/tnp/resolver.json` through the `tnp` group (`/etc/tnp`
 * root:tnp 0750, resolver.json 0640, config.json root 0600); its one writable
 * path is its own `StateDirectory` (`/var/lib/tnp-resolver`, the TLD cache).
 *
 * With `link` (systemd-resolved older than 258), the unit itself brings the
 * dedicated `tnp0` routing link up after the resolver starts and takes it
 * down when it stops, so the routing survives reboots and never outlives the
 * resolver it points at. The leading `-` makes a failure non-fatal: the
 * resolver still runs, `.ox` simply is not routed — and no other name is
 * affected either way. The `+` runs those commands with full privileges:
 * creating a link and reconfiguring resolved need root, which the sandboxed
 * daemon deliberately does not have.
 *
 * Deliberately not set: `MemoryDenyWriteExecute` (Bun's JavaScriptCore JIT
 * needs writable+executable pages), and any access to `/var/lib/tnp`: it is
 * root's — root writes the kill-switch record there — so the daemon's user must
 * neither own nor write it.
 */
export function buildSystemdUnit(
  binaryPath: string,
  link?: { up: string[]; down: string[] },
  user: string = SERVICE_USER,
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
    lines.push(`ExecStartPost=-+/bin/sh -c '${link.up.join('; ')}'`);
    lines.push(`ExecStopPost=-+/bin/sh -c '${link.down.join('; ')}'`);
  }
  lines.push(
    'Restart=always',
    'RestartSec=5',
    `User=${user}`,
    `Group=${user}`,
    'UMask=0077',
    'AmbientCapabilities=CAP_NET_BIND_SERVICE',
    'CapabilityBoundingSet=CAP_NET_BIND_SERVICE',
    'NoNewPrivileges=yes',
    'ProtectSystem=strict',
    // The one writable path: the daemon's TLD cache (RESOLVER_STATE_DIR).
    'StateDirectory=tnp-resolver',
    'StateDirectoryMode=0700',
    'ProtectHome=yes',
    'PrivateTmp=yes',
    'PrivateDevices=yes',
    'ProtectProc=invisible',
    'ProtectKernelTunables=yes',
    'ProtectKernelModules=yes',
    'ProtectKernelLogs=yes',
    'ProtectControlGroups=yes',
    'ProtectClock=yes',
    'ProtectHostname=yes',
    'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
    'RestrictNamespaces=yes',
    'RestrictRealtime=yes',
    'RestrictSUIDSGID=yes',
    'LockPersonality=yes',
    'RemoveIPC=yes',
    'SystemCallArchitectures=native',
    'SystemCallFilter=@system-service',
    'SystemCallFilter=~@privileged @resources',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  );
  return lines.join('\n');
}

/**
 * The resolver's launchd job.
 *
 * It still runs as root: a dedicated macOS service account needs a reserved
 * UID and group created through `dscl`, and a config that account can read.
 * Recorded as a follow-up in docs/architecture/platforms.md.
 */
export function launchdPlist(binaryPath: string, log: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(binaryPath)}</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>Umask</key>
  <integer>63</integer>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(log)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(log)}</string>
</dict>
</plist>`;
}

/** The boot task that runs the resolver as SYSTEM on Windows. */
export function windowsTaskXml(binaryPath: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
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
      <Command>${xmlEscape(binaryPath)}</Command>
      <Arguments>run</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

/**
 * UTF-16LE with a BOM, which Task Scheduler requires. Bun's writeFileSync has
 * no "utf-16le" encoding, so it is encoded by hand.
 */
export function encodeUtf16le(text: string): Buffer {
  const bytes: number[] = [0xff, 0xfe];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes.push(code & 0xff, (code >> 8) & 0xff);
  }
  return Buffer.from(bytes);
}

// ── macOS (launchd) ──

function installDarwin(binaryPath: string, cfg: TnpConfig): void {
  const plistPath = LAUNCHD_PLIST;
  writeFileAtomic(plistPath, launchdPlist(binaryPath, logPath()), { mode: 0o644 });
  // The root-only state dir (kill-switch record) is created by the installer
  // so its ownership is settled here, not by whichever command needs it first.
  ensurePrivateDir(systemStateDir());

  removeInstalledRouting();
  saveInstallState(
    applyNativeRouting({
      owner: 'install',
      target: { address: cfg.listenAddr, port: cfg.listenPort },
    }).state,
  );

  runChecked({ file: requireSystemBinary('launchctl'), args: ['load', plistPath] });
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
 * Create the `tnp` system account if it does not exist and return its ids:
 * no home directory, no login shell, its own group.
 */
function ensureServiceUser(): { uid: number; gid: number } {
  const id = requireSystemBinary('id');
  if (runCmd({ file: id, args: ['-u', SERVICE_USER] }).status !== 0) {
    const useradd = requireSystemBinary('useradd');
    const shell = findSystemBinary('nologin') ?? '/bin/false';
    runChecked({
      file: useradd,
      args: [
        '--system',
        '--user-group',
        '--no-create-home',
        '--home-dir',
        '/nonexistent',
        '--shell',
        shell,
        SERVICE_USER,
      ],
    });
  }
  const uid = Number(runChecked({ file: id, args: ['-u', SERVICE_USER] }).stdout.trim());
  const gid = Number(runChecked({ file: id, args: ['-g', SERVICE_USER] }).stdout.trim());
  if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid === 0 || gid === 0) {
    throw new Error(
      `account "${SERVICE_USER}" exists but is root or unreadable; refusing to run the resolver as it`,
    );
  }
  return { uid, gid };
}

/**
 * Settle ownership so the sandboxed daemon can read its resolver settings and
 * nothing else of TNP's: `/etc/tnp` root:tnp 0750, `config.json` root 0600
 * (it can hold the relay token), `resolver.json` root:tnp 0640 (no secrets,
 * written by `saveConfig`), `/var/lib/tnp` root 0700 with the identity key
 * 0600. chown/chmod follow symlinks, so files are changed only through an
 * O_NOFOLLOW descriptor (`settlePlainFile`) and the directory only once lstat
 * says it is a real one in root-only `/etc`.
 */
function settleLinuxOwnership(gid: number, cfg: TnpConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o750 });
  const dirStat = lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error(`${dir} is not a plain directory; refusing to install`);
  }
  chownSync(dir, 0, gid);
  chmodSync(dir, 0o750);
  settlePlainFile(configPath(), { uid: 0, gid: 0 }, 0o600);
  // Rewrites config.json 0600 and writes resolver.json root:<gid> 0640.
  saveConfig(cfg);

  ensurePrivateDir(systemStateDir());
  settlePlainFile(join(systemStateDir(), 'identity.key'), { uid: 0, gid: 0 }, 0o600);
}

function installLinux(binaryPath: string, cfg: TnpConfig): void {
  const { gid } = ensureServiceUser();
  settleLinuxOwnership(gid, cfg);

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

  writeFileAtomic(SYSTEMD_UNIT_PATH, buildSystemdUnit(binaryPath, unitLink), { mode: 0o644 });

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

  // Config and state: SYSTEM and Administrators only. %ProgramData% children
  // otherwise inherit Users:Read, and the config can hold a token.
  mkdirSync(configDir(), { recursive: true });
  restrictWindowsAcl(configDir(), 'admin-only');

  // An install from before this version prepended 127.0.0.1 to every adapter
  // and recorded nothing. Its task exists and our state file does not.
  const legacyInstall = !installRecorded() && windowsTaskExists();

  // schtasks reads task XML only from a file. It gets an unpredictable name,
  // O_EXCL creation and the admin-only program directory — never a fixed name
  // in %TEMP%, where the user could swap in a task of their own between the
  // write and the registration.
  const schtasks = requireSystemBinary('schtasks', 'win32');
  const xmlPath = join(dirname(binaryPath), `task-${randomBytes(8).toString('hex')}.xml`);
  writeFileSync(xmlPath, encodeUtf16le(windowsTaskXml(binaryPath)), { flag: 'wx' });
  try {
    runChecked({ file: schtasks, args: ['/Create', '/TN', WIN_TASK_NAME, '/XML', xmlPath, '/F'] });
  } finally {
    safeUnlink(xmlPath);
  }

  // Start it now
  runCmd({ file: schtasks, args: ['/Run', '/TN', WIN_TASK_NAME] });

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
  const legacyInstall = !installRecorded() && windowsTaskExists();
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

/**
 * Install the resolver as a system service. Returns the binary the service
 * runs — always the admin-only copy from `installServiceBinary`, never the
 * file the user happened to launch.
 */
export function installService(cfg: TnpConfig): string {
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  const binaryPath = installServiceBinary();
  switch (platform) {
    case 'darwin':
      installDarwin(binaryPath, cfg);
      break;
    case 'linux':
      installLinux(binaryPath, cfg);
      break;
    case 'win32':
      installWindows(binaryPath, cfg);
      break;
  }
  return binaryPath;
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
