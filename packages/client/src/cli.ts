#!/usr/bin/env bun
import { loadConfig, saveConfig } from "./config";
import { DnsProxy } from "./proxy";
import { installService, uninstallService, serviceStatus } from "./service";
import { resolve } from "path";

const VERSION = "0.1.0";

function usage() {
  console.log(`
tnp v${VERSION} -- The Network Protocol resolver

Usage:
  tnp run              Start the DNS resolver in the foreground
  tnp install          Install as a system service and configure DNS
  tnp uninstall        Remove the system service and DNS configuration
  tnp status           Check if the resolver service is running
  tnp test <domain>    Test resolving a TNP domain
  tnp version          Print version
  tnp help             Show this help

The resolver intercepts DNS queries for TNP domains (.ox, .app, .com)
and resolves them via the TNP API. All other queries are forwarded
to 1.1.1.1 (or your configured upstream DNS).

Config: /etc/tnp/config.json (or /usr/local/etc/tnp/config.json on macOS)
Docs:   https://tnp.network/install
`);
}

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
}

// -- Main --

const command = process.argv[2] || "help";
const arg = process.argv[3];

switch (command) {
  case "run":
    cmdRun();
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
