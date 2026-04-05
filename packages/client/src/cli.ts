#!/usr/bin/env bun
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { resolve, join } from "path";
import {
  loadConfig,
  saveConfig,
  KILLSWITCH_MARKER_PATH,
  type TnpConfig,
} from "./config";
import { DnsProxy } from "./proxy";
import { installService, uninstallService, serviceStatus } from "./service";

/** Regex to validate network interface names, preventing command injection. */
const VALID_IFACE_RE = /^[a-zA-Z0-9_.-]+$/;

const VERSION = "0.2.0";

function resolveRealBinaryPath(): string {
  try {
    if (process.platform === "linux" && existsSync("/proc/self/exe")) {
      const { readlinkSync } = require("fs");
      const real = readlinkSync("/proc/self/exe");
      if (!real.includes("bunfs")) return real;
    }
    const { execSync } = require("child_process");
    return execSync("which tnp", { encoding: "utf-8", stdio: "pipe" }).trim();
  } catch {
    return "/usr/local/bin/tnp";
  }
}

function usage() {
  console.log(`
tnp v${VERSION} -- The Network Protocol resolver & overlay client

Usage:
  tnp run              Start the DNS resolver in the foreground
  tnp connect          Start overlay client (DNS proxy + SOCKS5 proxy)
  tnp serve            Start service node mode (serve a domain)
  tnp relay            Start a community relay (see apps/relay)
  tnp install          Install as a system service and configure DNS
  tnp uninstall        Remove the system service and DNS configuration
  tnp update           Update to the latest version
  tnp status           Check if the resolver service is running
  tnp test <domain>    Test resolving a TNP domain
  tnp version          Print version
  tnp help             Show this help

Overlay commands:
  tnp connect [--privacy access|private]
    Starts both the DNS proxy and a SOCKS5 proxy. TNP domains with active
    service nodes are routed through encrypted tunnels via relay nodes.
    Default privacy: "access" (direct relay selection).

  tnp serve --domain <domain> [--target <host:port>] [--relay <wss://url>] --token <token>
    Registers this machine as a service node for the given domain.
    Incoming connections are forwarded to the local target (default localhost:80).

Config: /etc/tnp/config.json (or /usr/local/etc/tnp/config.json on macOS)
Docs:   https://tnp.network/install
`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdRun() {
  const config = loadConfig();
  console.log(`[tnp] v${VERSION} starting...`);
  console.log(`[tnp] API: ${config.apiBaseUrl}`);
  console.log(`[tnp] upstream DNS: ${config.upstreamDns}`);

  const proxy = new DnsProxy(config);

  // Start the DNS proxy FIRST so upstream forwarding works immediately.
  // This is critical when system DNS points to us (127.0.0.1) — we need
  // to be able to forward non-TNP queries before syncing TLDs from the API.
  await proxy.start();

  // Now sync TLDs from API (this uses fetch which goes through system DNS,
  // which now routes through us and we forward to upstream 1.1.1.1)
  await proxy.syncTlds().catch((err: unknown) => {
    console.warn(`[tnp] initial TLD sync failed, will retry: ${err}`);
  });

  // Re-sync TLDs every 5 minutes
  proxy.startTldSync(5 * 60 * 1000);

  // Handle shutdown
  const shutdown = () => {
    console.log("\n[tnp] shutting down...");
    proxy.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdConnect() {
  // Recover from a previous crash: if kill switch marker exists, stale firewall rules are blocking DNS
  if (existsSync(KILLSWITCH_MARKER_PATH)) {
    console.log("[tnp] detected stale kill switch from a previous session, cleaning up...");
    disableKillSwitch();
  }

  const config = loadConfig();

  // Parse --privacy flag
  const privacyIdx = process.argv.indexOf("--privacy");
  if (privacyIdx !== -1) {
    const val = process.argv[privacyIdx + 1];
    if (val === "access" || val === "private") {
      config.privacyLevel = val;
    } else {
      console.error(`[tnp] invalid privacy level: ${val}. Use "access" or "private".`);
      process.exit(1);
    }
  }

  // Parse --autoconnect flag
  if (process.argv.includes("--autoconnect")) {
    config.autoConnect = true;
    saveConfig(config);
    installAutoConnect();
    console.log(`[tnp] autoconnect enabled — TNP will connect on startup`);
  }

  // Parse --killswitch flag
  if (process.argv.includes("--killswitch")) {
    config.killSwitch = true;
  }

  // Parse --no-autoconnect / --no-killswitch
  if (process.argv.includes("--no-autoconnect")) {
    config.autoConnect = false;
    saveConfig(config);
    removeAutoConnect();
    console.log(`[tnp] autoconnect disabled`);
  }
  if (process.argv.includes("--no-killswitch")) {
    config.killSwitch = false;
  }

  console.log(`[tnp] v${VERSION} overlay client starting...`);
  console.log(`[tnp] API: ${config.apiBaseUrl}`);
  console.log(`[tnp] privacy: ${config.privacyLevel}  kill switch: ${config.killSwitch ? "on" : "off"}  autoconnect: ${config.autoConnect ? "on" : "off"}`);

  // Enable kill switch (block all DNS if tunnel drops)
  if (config.killSwitch) {
    enableKillSwitch();
  }

  // Start DNS proxy with overlay enabled
  const proxy = new DnsProxy(config);
  proxy.enableOverlay();

  proxy.startTldSync(5 * 60 * 1000);
  await proxy.syncTlds();
  await proxy.start();

  // Auto-configure system DNS to use the local proxy
  const dnsConfigured = configureDns(config);

  // Start SOCKS5 proxy
  const { TunnelManager } = await import("./tunnel");
  const { SocksProxy } = await import("./socks");

  const tunnelManager = new TunnelManager();
  const socksProxy = new SocksProxy({
    port: config.socksPort,
    host: config.listenAddr,
    tunnelManager,
    apiClient: proxy.getApiClient(),
    getOverlayInfo: (domain: string) => proxy.getOverlayInfo(domain),
  });

  console.log(`[tnp] overlay client ready — TNP domains now resolve on this device`);
  console.log(`[tnp] press Ctrl+C to disconnect`);

  const shutdown = () => {
    console.log("\n[tnp] shutting down overlay client...");
    if (config.killSwitch) {
      disableKillSwitch();
    }
    if (dnsConfigured) {
      restoreDns();
    }
    socksProxy.stop();
    tunnelManager.shutdown();
    proxy.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Configure system DNS to use the local TNP proxy. Returns true if configured. */
function configureDns(config: TnpConfig): boolean {
  const addr = `${config.listenAddr}:${config.listenPort}`;
  const dnsIp = config.publicDnsIp;

  try {
    if (process.platform === "win32") {
      // Windows: set DNS on all active adapters to TNP public resolver.
      // The proxy listens on port 5354, but Windows only supports port 53 for DNS.
      const { execSync } = require("child_process");
      execSync(
        `powershell -Command "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ServerAddresses ('${dnsIp}','1.1.1.1') }"`,
        { stdio: "pipe" }
      );
      console.log(`[tnp] DNS configured: using TNP resolver (${dnsIp}) + Cloudflare fallback`);
      return true;
    } else if (process.platform === "darwin") {
      // macOS: create resolver files for TNP TLDs
      const { execSync } = require("child_process");
      const { mkdirSync: mkdirSyncFs, writeFileSync: writeFileSyncFs } = require("fs");
      mkdirSyncFs("/etc/resolver", { recursive: true });
      for (const tld of ["ox", "app"]) {
        writeFileSyncFs(
          `/etc/resolver/${tld}`,
          `nameserver ${config.listenAddr}\nport ${config.listenPort}\n`
        );
      }
      console.log(`[tnp] DNS configured: /etc/resolver/ox and /etc/resolver/app -> ${addr}`);
      return true;
    } else {
      // Linux: try systemd-resolved split DNS, then resolv.conf
      return configureLinuxDns(config, addr, dnsIp);
    }
  } catch (err) {
    console.log(`[tnp] could not auto-configure DNS: ${err instanceof Error ? err.message : err}`);
    console.log(`[tnp] set your DNS to ${dnsIp} manually to resolve TNP domains`);
    return false;
  }
}

/** Linux-specific DNS configuration with systemd-resolved or resolv.conf fallback. */
function configureLinuxDns(config: TnpConfig, addr: string, dnsIp: string): boolean {
  const { execSync } = require("child_process");

  // Try systemd-resolved first
  try {
    const rawIface = execSync("ip route show default 2>/dev/null | awk '{print $5; exit}'", {
      encoding: "utf-8", stdio: "pipe"
    }).trim() || "eth0";

    // Validate interface name to prevent command injection
    if (!VALID_IFACE_RE.test(rawIface)) {
      console.warn(`[tnp] invalid network interface name "${rawIface}", falling back to resolv.conf`);
      return configureLinuxResolvConf(dnsIp);
    }

    execSync(`resolvectl dns ${rawIface} ${config.listenAddr}`, { stdio: "pipe" });
    execSync(`resolvectl domain ${rawIface} ~ox ~app`, { stdio: "pipe" });
    console.log(`[tnp] DNS configured: systemd-resolved split DNS on ${rawIface} for .ox .app -> ${addr}`);
    return true;
  } catch (err) {
    console.warn(`[tnp] systemd-resolved not available, trying resolv.conf: ${err instanceof Error ? err.message : String(err)}`);
    return configureLinuxResolvConf(dnsIp);
  }
}

/** Fallback Linux DNS configuration via /etc/resolv.conf. */
function configureLinuxResolvConf(dnsIp: string): boolean {
  try {
    const { readFileSync: readFileSyncFs, writeFileSync: writeFileSyncFs } = require("fs");
    const current = readFileSyncFs("/etc/resolv.conf", "utf-8") as string;
    if (!current.includes(dnsIp)) {
      writeFileSyncFs("/etc/resolv.conf", `nameserver ${dnsIp}\n${current}`);
      console.log(`[tnp] DNS configured: added TNP resolver to /etc/resolv.conf`);
      return true;
    }
    console.log(`[tnp] DNS already configured`);
    return true;
  } catch (err) {
    console.log(`[tnp] could not auto-configure DNS (need sudo): ${err instanceof Error ? err.message : String(err)}`);
    console.log(`[tnp] fix: sudo resolvectl dns <iface> 127.0.0.1  OR  set DNS to ${dnsIp}`);
    return false;
  }
}

/** Restore DNS settings when disconnecting. */
function restoreDns(): void {
  const dnsIp = loadConfig().publicDnsIp;
  const escapedIp = dnsIp.replace(/\./g, "\\.");

  try {
    if (process.platform === "win32") {
      const { execSync } = require("child_process");
      execSync(
        `powershell -Command "Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object { Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ResetServerAddresses }"`,
        { stdio: "pipe" }
      );
      console.log("[tnp] DNS restored to default");
    } else if (process.platform === "darwin") {
      for (const tld of ["ox", "app"]) {
        try {
          unlinkSync(`/etc/resolver/${tld}`);
        } catch (err) {
          console.warn(`[tnp] could not remove /etc/resolver/${tld}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      console.log("[tnp] DNS restored: removed /etc/resolver/ox and /etc/resolver/app");
    } else {
      // Linux: remove our entry from resolv.conf if we added it
      try {
        const { readFileSync: readFileSyncFs, writeFileSync: writeFileSyncFs } = require("fs");
        const current = readFileSyncFs("/etc/resolv.conf", "utf-8") as string;
        const restored = current.replace(new RegExp(`nameserver ${escapedIp}\\n?`), "");
        if (restored !== current) {
          writeFileSyncFs("/etc/resolv.conf", restored);
          console.log("[tnp] DNS restored: removed TNP resolver from /etc/resolv.conf");
        }
      } catch (err) {
        console.warn(`[tnp] could not restore Linux DNS: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    console.warn(`[tnp] could not restore DNS automatically: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Install autoconnect — register tnp connect to run on system boot/login. */
function installAutoConnect(): void {
  const { execSync } = require("child_process");
  const binaryPath = resolveRealBinaryPath();

  try {
    if (process.platform === "win32") {
      // Windows: create a scheduled task that runs tnp connect at logon
      execSync(
        `schtasks /Create /TN "TnpAutoConnect" /TR "\\"${binaryPath}\\" connect" /SC ONLOGON /RL HIGHEST /F`,
        { stdio: "pipe" }
      );
    } else if (process.platform === "darwin") {
      // macOS: create a LaunchAgent plist
      const { writeFileSync, mkdirSync } = require("fs");
      const { homedir } = require("os");
      const { join } = require("path");
      const plistDir = join(homedir(), "Library", "LaunchAgents");
      mkdirSync(plistDir, { recursive: true });
      writeFileSync(join(plistDir, "so.oxy.tnp.connect.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>so.oxy.tnp.connect</string>
  <key>ProgramArguments</key><array><string>${binaryPath}</string><string>connect</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>`);
      execSync(`launchctl load ~/Library/LaunchAgents/so.oxy.tnp.connect.plist`, { stdio: "pipe" });
    } else {
      // Linux: create a systemd user service
      const { writeFileSync, mkdirSync } = require("fs");
      const { homedir } = require("os");
      const { join } = require("path");
      const unitDir = join(homedir(), ".config", "systemd", "user");
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(join(unitDir, "tnp-connect.service"), `[Unit]
Description=TNP Overlay Client
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${binaryPath} connect
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`);
      execSync("systemctl --user daemon-reload", { stdio: "pipe" });
      execSync("systemctl --user enable tnp-connect.service", { stdio: "pipe" });
      execSync("systemctl --user start tnp-connect.service", { stdio: "pipe" });
    }
  } catch (err) {
    console.error(`[tnp] autoconnect setup failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Remove autoconnect service. */
function removeAutoConnect(): void {
  const { execSync } = require("child_process");
  try {
    if (process.platform === "win32") {
      execSync(`schtasks /Delete /TN "TnpAutoConnect" /F`, { stdio: "pipe" });
    } else if (process.platform === "darwin") {
      execSync(`launchctl unload ~/Library/LaunchAgents/so.oxy.tnp.connect.plist 2>/dev/null`, { stdio: "pipe" });
      try {
        require("fs").unlinkSync(`${require("os").homedir()}/Library/LaunchAgents/so.oxy.tnp.connect.plist`);
      } catch (err: unknown) {
        console.warn(`[tnp] could not remove launch agent plist: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      execSync("systemctl --user stop tnp-connect.service 2>/dev/null", { stdio: "pipe" });
      execSync("systemctl --user disable tnp-connect.service 2>/dev/null", { stdio: "pipe" });
      try {
        require("fs").unlinkSync(`${require("os").homedir()}/.config/systemd/user/tnp-connect.service`);
      } catch (err: unknown) {
        console.warn(`[tnp] could not remove systemd unit file: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    console.error(`[tnp] failed to remove autoconnect: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Kill switch: block all DNS except through TNP. If the tunnel drops, nothing leaks. */
function enableKillSwitch(): void {
  const { execSync } = require("child_process");
  const dnsIp = loadConfig().publicDnsIp;
  console.log("[tnp] enabling kill switch...");

  try {
    if (process.platform === "win32") {
      // Windows: create firewall rules to block all DNS (port 53) except to localhost
      execSync(`netsh advfirewall firewall add rule name="TNP-KillSwitch-Block-DNS" dir=out protocol=udp remoteport=53 action=block`, { stdio: "pipe" });
      execSync(`netsh advfirewall firewall add rule name="TNP-KillSwitch-Block-DNS-TCP" dir=out protocol=tcp remoteport=53 action=block`, { stdio: "pipe" });
      execSync(`netsh advfirewall firewall add rule name="TNP-KillSwitch-Allow-Local" dir=out protocol=udp remoteport=53 remoteip=127.0.0.1 action=allow`, { stdio: "pipe" });
      execSync(`netsh advfirewall firewall add rule name="TNP-KillSwitch-Allow-TNP" dir=out protocol=udp remoteport=53 remoteip=${dnsIp} action=allow`, { stdio: "pipe" });
    } else if (process.platform === "darwin") {
      // macOS: use pf anchor so we don't replace the entire ruleset
      writeFileSync("/tmp/tnp-killswitch.conf", [
        "block out quick proto { tcp, udp } to any port 53",
        "pass out quick proto { tcp, udp } to 127.0.0.1 port 53",
        `pass out quick proto { tcp, udp } to ${dnsIp} port 53`,
        "pass out quick proto { tcp, udp } to 127.0.0.1 port 5354",
        "",
      ].join("\n"));
      execSync("sudo pfctl -a tnp-killswitch -f /tmp/tnp-killswitch.conf 2>/dev/null", { stdio: "pipe" });
    } else {
      // Linux: use iptables
      execSync("sudo iptables -I OUTPUT -p udp --dport 53 -j DROP 2>/dev/null", { stdio: "pipe" });
      execSync("sudo iptables -I OUTPUT -p tcp --dport 53 -j DROP 2>/dev/null", { stdio: "pipe" });
      execSync("sudo iptables -I OUTPUT -p udp --dport 53 -d 127.0.0.1 -j ACCEPT 2>/dev/null", { stdio: "pipe" });
      execSync(`sudo iptables -I OUTPUT -p udp --dport 53 -d ${dnsIp} -j ACCEPT 2>/dev/null`, { stdio: "pipe" });
      execSync("sudo iptables -I OUTPUT -p udp --dport 5354 -d 127.0.0.1 -j ACCEPT 2>/dev/null", { stdio: "pipe" });
    }

    // Write marker file so a future process can detect stale rules after a crash
    writeFileSync(KILLSWITCH_MARKER_PATH, String(process.pid), { mode: 0o600 });
    console.log("[tnp] kill switch active -- DNS blocked except through TNP");
  } catch (err) {
    console.log(`[tnp] kill switch failed (may need admin/sudo): ${err instanceof Error ? err.message : err}`);
  }
}

/** Disable kill switch -- restore normal DNS access. */
function disableKillSwitch(): void {
  const { execSync } = require("child_process");
  const dnsIp = loadConfig().publicDnsIp;
  console.log("[tnp] disabling kill switch...");

  try {
    if (process.platform === "win32") {
      const rules = [
        "TNP-KillSwitch-Block-DNS",
        "TNP-KillSwitch-Block-DNS-TCP",
        "TNP-KillSwitch-Allow-Local",
        "TNP-KillSwitch-Allow-TNP",
      ];
      for (const rule of rules) {
        try {
          execSync(`netsh advfirewall firewall delete rule name="${rule}"`, { stdio: "pipe" });
        } catch (err) {
          console.warn(`[tnp] could not remove firewall rule "${rule}": ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else if (process.platform === "darwin") {
      // Flush only the tnp-killswitch anchor, leaving the rest of pf intact
      execSync("sudo pfctl -a tnp-killswitch -F all 2>/dev/null", { stdio: "pipe" });
    } else {
      execSync("sudo iptables -D OUTPUT -p udp --dport 53 -j DROP 2>/dev/null", { stdio: "pipe" });
      execSync("sudo iptables -D OUTPUT -p tcp --dport 53 -j DROP 2>/dev/null", { stdio: "pipe" });
      execSync("sudo iptables -D OUTPUT -p udp --dport 53 -d 127.0.0.1 -j ACCEPT 2>/dev/null", { stdio: "pipe" });
      execSync(`sudo iptables -D OUTPUT -p udp --dport 53 -d ${dnsIp} -j ACCEPT 2>/dev/null`, { stdio: "pipe" });
      execSync("sudo iptables -D OUTPUT -p udp --dport 5354 -d 127.0.0.1 -j ACCEPT 2>/dev/null", { stdio: "pipe" });
    }
    console.log("[tnp] kill switch disabled -- normal DNS restored");
  } catch (err) {
    console.warn(`[tnp] could not remove kill switch rules automatically: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Remove marker file regardless of whether rule removal succeeded
  try {
    unlinkSync(KILLSWITCH_MARKER_PATH);
  } catch {
    // Marker file may already be gone -- that is fine
  }
}

async function cmdServe() {
  const config = loadConfig();

  // Parse flags
  const domain = getFlag("--domain");
  const target = getFlag("--target") || "localhost:80";
  const relayEndpoint = getFlag("--relay");
  const authToken = getFlag("--token");

  if (!domain) {
    console.error("[tnp] --domain is required for serve mode");
    console.error("Example: tnp serve --domain example.ox --token <auth-token>");
    process.exit(1);
  }

  if (!authToken) {
    console.error("[tnp] --token is required for serve mode (Oxy auth token)");
    process.exit(1);
  }

  // Auto-discover relay if not specified
  let relay = relayEndpoint;
  if (!relay) {
    console.log("[tnp] auto-discovering relay...");
    const { TnpApiClient } = await import("./api");
    const apiClient = new TnpApiClient(config.apiBaseUrl);

    const preference = config.relayPreference === "any" ? undefined : config.relayPreference;
    const relays = await apiClient.getRelays(preference as "oxy" | "community" | undefined);

    if (relays.length === 0) {
      console.error("[tnp] no active relays found. Specify one with --relay <wss://url>");
      process.exit(1);
    }

    relay = relays[0].endpoint;
    console.log(`[tnp] selected relay: ${relay}`);
  }

  console.log(`[tnp] v${VERSION} service node starting...`);
  console.log(`[tnp] domain: ${domain}`);
  console.log(`[tnp] target: ${target}`);
  console.log(`[tnp] relay: ${relay}`);

  const { startServiceNode } = await import("./service-node");
  const { TnpApiClient } = await import("./api");
  const apiClient = new TnpApiClient(config.apiBaseUrl);

  await startServiceNode(
    {
      domain,
      localTarget: target,
      apiBaseUrl: config.apiBaseUrl,
      relayEndpoint: relay,
      identityKeyPath: config.identityKeyPath,
      authToken,
    },
    apiClient,
  );
}

async function cmdRelay() {
  const config = loadConfig();

  const port = Number(getFlag("--port") ?? config.relayPort);
  const host = getFlag("--host") ?? "0.0.0.0";
  const location = getFlag("--location") ?? config.relayLocation;
  const authToken = getFlag("--token") ?? config.relayAuthToken;
  const maxConn = Number(getFlag("--max-connections") ?? config.relayMaxConnections);

  if (!authToken) {
    console.error("[tnp] --token is required (Oxy auth token)");
    console.error("Example: tnp relay --token <auth-token>");
    process.exit(1);
  }

  console.log(`[tnp] v${VERSION} relay node starting...`);
  console.log(`[tnp] listen: ${host}:${port}`);
  console.log(`[tnp] location: ${location || "(not set)"}`);
  console.log(`[tnp] max connections: ${maxConn}`);

  const { RelayNode } = await import("./relay-node");
  const { TnpApiClient } = await import("./api");

  const apiClient = new TnpApiClient(config.apiBaseUrl);

  const relay = new RelayNode({
    port,
    host,
    maxConnections: maxConn,
    authToken,
    location,
    apiBaseUrl: config.apiBaseUrl,
  });

  await relay.start(apiClient);

  console.log(`[tnp] relay node ready on ${host}:${port}`);

  const shutdown = () => {
    console.log("\n[tnp] shutting down relay node...");
    relay.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function cmdInstall() {
  const config = loadConfig();
  // Force port 53 for system DNS integration
  config.listenPort = 53;
  config.listenAddr = "127.0.0.1";
  saveConfig(config);

  const binaryPath = resolveRealBinaryPath();
  console.log(`[tnp] installing service...`);
  console.log(`[tnp] binary: ${binaryPath}`);
  console.log(`[tnp] listen: ${config.listenAddr}:${config.listenPort}`);

  try {
    installService(binaryPath, config);
    console.log("[tnp] service installed and started");
    console.log("[tnp] TNP domains (.ox, .app, .com) will now resolve on this device");
  } catch (err) {
    console.error(`[tnp] install failed: ${err}`);
    console.error("[tnp] you may need to run this command with sudo");
    process.exit(1);
  }
}

async function cmdUpdate() {
  const api = `https://api.tnp.network/client/latest`;
  console.log("[tnp] checking for updates...");

  try {
    const res = await fetch(api);
    if (!res.ok) throw new Error(`API returned ${res.status}`);
    const data = await res.json() as { version: string; platforms: Record<string, { url: string } | null> };

    if (data.version === VERSION) {
      console.log(`[tnp] already on latest version (v${VERSION})`);
      return;
    }

    console.log(`[tnp] updating v${VERSION} → v${data.version}...`);

    const platformKey = `${process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
    const platformInfo = data.platforms[platformKey];
    if (!platformInfo) {
      console.error(`[tnp] no binary available for ${platformKey}`);
      process.exit(1);
    }

    const dlRes = await fetch(platformInfo.url);
    if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);
    const binary = Buffer.from(await dlRes.arrayBuffer());

    const currentPath = resolve(process.argv[1] || "/usr/local/bin/tnp");
    const tmpPath = `${currentPath}.tmp`;

    // Stop service, replace binary, restart
    const { execSync } = await import("child_process");
    const isLinux = process.platform === "linux";
    const isDarwin = process.platform === "darwin";

    if (isLinux) {
      try { execSync("systemctl stop tnp-resolver", { stdio: "pipe" }); } catch {}
    } else if (isDarwin) {
      try { execSync("launchctl unload /Library/LaunchDaemons/so.oxy.tnp.resolver.plist", { stdio: "pipe" }); } catch {}
    }

    writeFileSync(tmpPath, binary, { mode: 0o755 });
    const { renameSync } = await import("fs");
    renameSync(tmpPath, currentPath);

    console.log(`[tnp] updated to v${data.version}`);

    if (isLinux) {
      try { execSync("systemctl start tnp-resolver", { stdio: "pipe" }); } catch {}
      console.log("[tnp] service restarted");
    } else if (isDarwin) {
      try { execSync("launchctl load /Library/LaunchDaemons/so.oxy.tnp.resolver.plist", { stdio: "pipe" }); } catch {}
      console.log("[tnp] service restarted");
    }
  } catch (err) {
    console.error(`[tnp] update failed: ${err}`);
    console.error("[tnp] you may need to run this command with sudo");
    process.exit(1);
  }
}

function cmdUninstall() {
  console.log("[tnp] uninstalling service...");

  try {
    uninstallService();
    console.log("[tnp] service removed");
    console.log("[tnp] DNS configuration restored");
  } catch (err) {
    console.error(`[tnp] uninstall failed: ${err}`);
    console.error("[tnp] you may need to run this command with sudo");
    process.exit(1);
  }
}

function cmdStatus() {
  const running = serviceStatus();
  if (running) {
    console.log("[tnp] resolver is running");
  } else {
    console.log("[tnp] resolver is not running");
  }
  process.exit(running ? 0 : 1);
}

async function cmdTest(domain: string) {
  if (!domain) {
    console.error("Usage: tnp test <domain>");
    console.error("Example: tnp test example.ox");
    process.exit(1);
  }

  const config = loadConfig();
  const { TnpApiClient } = await import("./api");
  const client = new TnpApiClient(config.apiBaseUrl);

  console.log(`[tnp] resolving ${domain} via ${config.apiBaseUrl}...`);

  let foundAny = false;
  for (const type of ["A", "AAAA", "CNAME", "TXT"]) {
    const answers = await client.resolve(domain, type);
    for (const ans of answers) {
      console.log(`  ${ans.type}\t${ans.name}\t${ans.value}\t(TTL: ${ans.ttl})`);
      foundAny = true;
    }
  }

  if (!foundAny) {
    console.log(`  (no records found for ${domain})`);
  }

  // Also check overlay status
  const nodeInfo = await client.getServiceNode(domain);
  if (nodeInfo) {
    console.log(`  [overlay] status: ${nodeInfo.status}`);
    console.log(`  [overlay] relay: ${nodeInfo.connectedRelay || "(none)"}`);
    console.log(`  [overlay] pubkey: ${nodeInfo.publicKey}`);
  } else {
    console.log(`  [overlay] no service node registered`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2] || "interactive";
const arg = process.argv[3];

switch (command) {
  case "interactive": {
    const { startInteractive } = await import("./interactive");
    startInteractive();
    break;
  }
  case "run":
    await cmdRun();
    break;
  case "connect":
    await cmdConnect();
    break;
  case "serve":
    await cmdServe();
    break;
  case "relay":
    await cmdRelay();
    break;
  case "install":
    cmdInstall();
    break;
  case "uninstall":
    cmdUninstall();
    break;
  case "update":
    await cmdUpdate();
    break;
  case "status":
    cmdStatus();
    break;
  case "test":
    await cmdTest(arg || "");
    break;
  case "version":
  case "--version":
  case "-v":
    console.log(`tnp v${VERSION}`);
    break;
  case "help":
  case "--help":
  case "-h":
    usage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
}
