import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import type { TnpConfig } from "./config";
import { logPath, getDefaultInterface } from "./config";
import { isReservedTld } from "@tnp/namespace";

const LAUNCHD_LABEL = "so.oxy.tnp.resolver";
const SYSTEMD_UNIT = "tnp-resolver.service";
const WIN_TASK_NAME = "TnpResolver";

/**
 * TLDs the installer routes to the local resolver.
 *
 * Only TNP-native labels. Earlier versions also captured `.app` and `.com`,
 * which pointed every lookup under those TLDs at TNP and is the namespace
 * violation in docs/architecture/naming.md rule N1 (audit S4).
 *
 * Static rather than fetched: install must work offline, and a device that
 * routes a TLD to TNP because an API said so is the same trust problem in a
 * different place. New native TLDs are picked up by the running resolver's TLD
 * sync; adding one to the *routing* layer is deliberately a release decision.
 */
export const NATIVE_TLDS = ["ox"] as const;

/**
 * Delete `/etc/resolver` entries an earlier version wrote for reserved TLDs.
 *
 * Upgrades must repair the machine, not merely stop making it worse: a user who
 * installed before this change has `/etc/resolver/com` on disk, and until it is
 * removed every `.com` lookup on that Mac still goes to TNP.
 */
export function removeReservedResolverFiles(): void {
  if (!existsSync("/etc/resolver")) return;

  for (const entry of readdirSync("/etc/resolver")) {
    if (!isReservedTld(entry)) continue;

    const path = join("/etc/resolver", entry);
    // Only remove files this client wrote — a resolver entry pointing somewhere
    // else belongs to another tool and is not ours to delete.
    try {
      if (!readFileSync(path, "utf-8").includes("nameserver 127.0.0.1")) continue;
    } catch {
      continue;
    }

    safeUnlink(path);
    console.log(`[tnp] removed /etc/resolver/${entry} — .${entry} is public DNS, not TNP's`);
  }
}

const platform = process.platform;

function run(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
}

function runSilent(cmd: string): void {
  try {
    execSync(cmd, { encoding: "utf-8", stdio: "pipe" });
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

  writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?>
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
</plist>`);

  removeReservedResolverFiles();

  mkdirSync("/etc/resolver", { recursive: true });
  for (const tld of NATIVE_TLDS) {
    writeFileSync(
      join("/etc/resolver", tld),
      `nameserver ${cfg.listenAddr}\nport ${cfg.listenPort}\n`
    );
  }

  run(`launchctl load ${plistPath}`);
}

function uninstallDarwin(): void {
  runSilent(`launchctl unload /Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`);
  safeUnlink(`/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`);
  for (const tld of NATIVE_TLDS) {
    safeUnlink(join("/etc/resolver", tld));
  }
  removeReservedResolverFiles();
}

function statusDarwin(): boolean {
  try { run(`launchctl list ${LAUNCHD_LABEL}`); return true; } catch { return false; }
}

// ── Linux (systemd) ──

function installLinux(binaryPath: string, cfg: TnpConfig): void {
  writeFileSync(`/etc/systemd/system/${SYSTEMD_UNIT}`, `[Unit]
Description=TNP DNS Resolver
After=network.target
Wants=network-online.target
Before=systemd-resolved.service

[Service]
Type=simple
ExecStart=${binaryPath} run
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`);

  if (existsSync("/etc/systemd/resolved.conf") || existsSync("/run/systemd/resolve")) {
    const dir = "/etc/systemd/resolved.conf.d";
    mkdirSync(dir, { recursive: true });
    // Route only TNP-native TLDs. This drop-in used to say `Domains=~.`, which
    // makes TNP the routing domain for ALL DNS on the machine — every public
    // name resolved through TNP (audit S4). An upgrade overwrites the old file,
    // so the repair happens without extra cleanup here.
    const routingDomains = NATIVE_TLDS.map((tld) => `~${tld}`).join(" ");
    writeFileSync(join(dir, "tnp.conf"), `[Resolve]
DNS=${cfg.listenAddr}
Domains=${routingDomains}
DNSStubListener=yes
`);
    runSilent("systemctl restart systemd-resolved");
  }

  run("systemctl daemon-reload");
  run(`systemctl enable ${SYSTEMD_UNIT}`);
  run(`systemctl start ${SYSTEMD_UNIT}`);

  const iface = getDefaultInterface();
  if (iface) {
    runSilent(`resolvectl dns ${iface} ${cfg.listenAddr}`);
    // Per-TLD routing domains, not `~.` — see the drop-in above.
    runSilent(`resolvectl domain ${iface} ${NATIVE_TLDS.map((t) => `'~${t}'`).join(" ")}`);
  } else {
    console.warn("[tnp] could not detect default network interface; resolvectl DNS not configured");
  }
}

function uninstallLinux(): void {
  runSilent(`systemctl stop ${SYSTEMD_UNIT}`);
  runSilent(`systemctl disable ${SYSTEMD_UNIT}`);
  safeUnlink(`/etc/systemd/system/${SYSTEMD_UNIT}`);
  safeUnlink("/etc/systemd/resolved.conf.d/tnp.conf");
  runSilent("systemctl daemon-reload");
  runSilent("systemctl restart systemd-resolved");

  const iface = getDefaultInterface();
  if (iface) {
    runSilent(`resolvectl revert ${iface}`);
  } else {
    console.warn("[tnp] could not detect default network interface; resolvectl DNS not reverted");
  }
}

function statusLinux(): boolean {
  try { run(`systemctl is-active --quiet ${SYSTEMD_UNIT}`); return true; } catch { return false; }
}

// ── Windows (Scheduled Task + DNS config) ──

function installWindows(binaryPath: string, cfg: TnpConfig): void {
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
      <Command>${binaryPath.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}</Command>
      <Arguments>run</Arguments>
    </Exec>
  </Actions>
</Task>`;

  const tmpXml = join(
    process.env.TEMP || process.env.TMP || "C:\\Windows\\Temp",
    "tnp-task.xml"
  );
  // Windows Task Scheduler requires UTF-16LE XML.
  // Bun doesn't support "utf-16le" encoding in writeFileSync,
  // so we encode manually with a BOM.
  const utf16Bytes: number[] = [0xFF, 0xFE]; // BOM
  for (let i = 0; i < taskXml.length; i++) {
    const code = taskXml.charCodeAt(i);
    utf16Bytes.push(code & 0xFF, (code >> 8) & 0xFF);
  }
  writeFileSync(tmpXml, Buffer.from(utf16Bytes));
  run(`schtasks /Create /TN "${WIN_TASK_NAME}" /XML "${tmpXml}" /F`);
  safeUnlink(tmpXml);

  // Start it now
  runSilent(`schtasks /Run /TN "${WIN_TASK_NAME}"`);

  // Configure Windows DNS: add 127.0.0.1 as DNS for the primary adapter.
  // We use PowerShell to find the active adapter and prepend our resolver.
  runSilent(
    `powershell -Command "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ServerAddresses ('127.0.0.1',(Get-DnsClientServerAddress -InterfaceIndex $_.ifIndex -AddressFamily IPv4).ServerAddresses) }"`
  );

  console.log("[tnp] note: on Windows the resolver listens on port 53 if possible,");
  console.log("[tnp] otherwise configure your DNS to 127.0.0.1 manually in network settings.");
}

function uninstallWindows(): void {
  runSilent(`schtasks /End /TN "${WIN_TASK_NAME}"`);
  runSilent(`schtasks /Delete /TN "${WIN_TASK_NAME}" /F`);

  // Restore DNS -- remove 127.0.0.1 from adapter DNS
  runSilent(
    `powershell -Command "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ResetServerAddresses }"`
  );
}

function statusWindows(): boolean {
  try {
    const out = run(`schtasks /Query /TN "${WIN_TASK_NAME}" /FO CSV /NH`);
    return out.includes("Running");
  } catch {
    return false;
  }
}

// ── Auto-detect ──

export function installService(binaryPath: string, cfg: TnpConfig): void {
  switch (platform) {
    case "darwin":  return installDarwin(binaryPath, cfg);
    case "linux":   return installLinux(binaryPath, cfg);
    case "win32":   return installWindows(binaryPath, cfg);
    default:        throw new Error(`Unsupported platform: ${platform}`);
  }
}

export function uninstallService(): void {
  switch (platform) {
    case "darwin":  return uninstallDarwin();
    case "linux":   return uninstallLinux();
    case "win32":   return uninstallWindows();
    default:        throw new Error(`Unsupported platform: ${platform}`);
  }
}

export function serviceStatus(): boolean {
  switch (platform) {
    case "darwin":  return statusDarwin();
    case "linux":   return statusLinux();
    case "win32":   return statusWindows();
    default:        return false;
  }
}

export function stopService(): void {
  switch (platform) {
    case "linux":
      runSilent(`systemctl stop ${SYSTEMD_UNIT}`);
      break;
    case "darwin":
      runSilent(`launchctl unload /Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`);
      break;
    case "win32":
      runSilent(`schtasks /End /TN "${WIN_TASK_NAME}"`);
      break;
  }
}

export function startService(): void {
  switch (platform) {
    case "linux":
      run(`systemctl start ${SYSTEMD_UNIT}`);
      break;
    case "darwin":
      run(`launchctl load /Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`);
      break;
    case "win32":
      runSilent(`schtasks /Run /TN "${WIN_TASK_NAME}"`);
      break;
  }
}
