#!/usr/bin/env bun
import { loadConfig, saveConfig, dataDir } from "./config";
import { DnsProxy } from "./proxy";
import { installService, uninstallService, serviceStatus } from "./service";
import { resolve, join } from "path";

const VERSION = "0.2.0";

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

  // Sync TLDs from API every 5 minutes
  proxy.startTldSync(5 * 60 * 1000);

  // Wait for initial TLD sync before starting
  await proxy.syncTlds();

  // Start the DNS proxy
  await proxy.start();

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

  console.log(`[tnp] v${VERSION} overlay client starting...`);
  console.log(`[tnp] API: ${config.apiBaseUrl}`);
  console.log(`[tnp] privacy level: ${config.privacyLevel}`);
  console.log(`[tnp] SOCKS5 port: ${config.socksPort}`);

  // Start DNS proxy with overlay enabled
  const proxy = new DnsProxy(config);
  proxy.enableOverlay();

  proxy.startTldSync(5 * 60 * 1000);
  await proxy.syncTlds();
  await proxy.start();

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

  console.log(`[tnp] overlay client ready`);
  console.log(`[tnp] configure your browser/app to use SOCKS5 proxy at ${config.listenAddr}:${config.socksPort}`);

  const shutdown = () => {
    console.log("\n[tnp] shutting down overlay client...");
    socksProxy.stop();
    tunnelManager.shutdown();
    proxy.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
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
  saveConfig(config);

  const binaryPath = resolve(process.argv[1] || "tnp");
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

  for (const type of ["A", "AAAA", "CNAME", "TXT"]) {
    const answers = await client.resolve(domain, type);
    for (const ans of answers) {
      console.log(`  ${ans.type}\t${ans.name}\t${ans.value}\t(TTL: ${ans.ttl})`);
    }
  }

  const allEmpty = (
    await Promise.all(
      ["A", "AAAA", "CNAME", "TXT"].map((t) => client.resolve(domain, t))
    )
  ).every((a) => a.length === 0);

  if (allEmpty) {
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
    cmdRun();
    break;
  case "connect":
    cmdConnect();
    break;
  case "serve":
    cmdServe();
    break;
  case "relay":
    cmdRelay();
    break;
  case "install":
    cmdInstall();
    break;
  case "uninstall":
    cmdUninstall();
    break;
  case "status":
    cmdStatus();
    break;
  case "test":
    cmdTest(arg || "");
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
