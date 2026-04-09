import {
  createCliRenderer,
  Text,
  Box,
  Select,
  Input,
  ASCIIFont,
  SelectRenderableEvents,
  InputRenderableEvents,
  type CliRenderer,
} from "@opentui/core";
import type { KeyEvent } from "@opentui/core";
import { loadConfig, saveConfig, type TnpConfig } from "./config";
import { serviceStatus } from "./service";

const VERSION = "0.2.0";

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const CYAN = "#00CCCC";
const GREEN = "#00CC00";
const RED = "#CC0000";
const YELLOW = "#CCCC00";
const DIM = "#888888";
const WHITE = "#FFFFFF";
const BLACK = "#000000";
const SELECTED_BG = "#006666";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MenuItem {
  label: string;
  description: string;
  icon: string;
  action: () => Promise<void>;
  group?: "primary" | "system" | "tools";
}

interface SettingField {
  key: keyof TnpConfig;
  label: string;
  validate?: (value: string) => string | null;
  transform?: (value: string) => string | number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let renderer: CliRenderer;
let activeRelayNode: import("./relay-node").RelayNode | null = null;
let quitKeyHandler: ((key: KeyEvent) => void) | null = null;

// Helper to access keyInput as a standard EventEmitter (the typed generic
// EventEmitter doesn't expose .on/.removeListener in all TS configurations)
function onKey(handler: (key: KeyEvent) => void): void {
  (renderer.keyInput as any).on("keypress", handler);
}
function offKey(handler: (key: KeyEvent) => void): void {
  (renderer.keyInput as any).removeListener("keypress", handler);
}

// Helper to register events on ProxiedVNode constructs
function onEvent(vnode: any, event: string, handler: (...args: any[]) => void): void {
  vnode.on(event, handler);
}

// ---------------------------------------------------------------------------
// Settings fields
// ---------------------------------------------------------------------------

const SETTING_FIELDS: SettingField[] = [
  {
    key: "apiBaseUrl",
    label: "API URL",
    validate: (v) => {
      try {
        new URL(v);
        return null;
      } catch {
        return "Invalid URL";
      }
    },
  },
  {
    key: "listenPort",
    label: "DNS listen port",
    validate: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1 || n > 65535) return "Port must be 1-65535";
      return null;
    },
    transform: (v) => parseInt(v, 10),
  },
  {
    key: "privacyLevel",
    label: "Privacy level",
    validate: (v) => {
      if (v !== "access" && v !== "private")
        return 'Must be "access" or "private"';
      return null;
    },
  },
  {
    key: "socksPort",
    label: "SOCKS port",
    validate: (v) => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1 || n > 65535) return "Port must be 1-65535";
      return null;
    },
    transform: (v) => parseInt(v, 10),
  },
  {
    key: "relayPreference",
    label: "Relay preference",
    validate: (v) => {
      if (v !== "oxy" && v !== "community" && v !== "any") {
        return 'Must be "oxy", "community", or "any"';
      }
      return null;
    },
  },
];

// ---------------------------------------------------------------------------
// View management
// ---------------------------------------------------------------------------

function clearRoot(): void {
  for (const child of renderer.root.getChildren()) {
    child.destroyRecursively();
  }
}

function removeQuitHandler(): void {
  if (quitKeyHandler) {
    offKey(quitKeyHandler);
    quitKeyHandler = null;
  }
}

function waitForKeypress(): Promise<void> {
  return new Promise((resolve) => {
    const handler = () => {
      offKey(handler);
      resolve();
    };
    onKey(handler);
  });
}

function waitForCtrlC(): Promise<void> {
  return new Promise((resolve) => {
    const handler = (key: KeyEvent) => {
      if (key.ctrl && key.name === "c") {
        offKey(handler);
        resolve();
      }
    };
    onKey(handler);
  });
}

function promptInput(label: string, defaultValue = ""): Promise<string> {
  return new Promise((resolve) => {
    const labelNode = Text({
      content: `  ${label} [${defaultValue}]: `,
      fg: WHITE,
    });
    renderer.root.add(labelNode);

    const input = Input({
      width: 40,
      value: defaultValue,
      placeholder: defaultValue || "...",
      textColor: WHITE,
      focusedBackgroundColor: "#333333",
    });

    onEvent(input, InputRenderableEvents.ENTER, () => {
      // Read value from the materialized InputRenderable in the tree
      const children = renderer.root.getChildren();
      let val = defaultValue;
      for (const child of children) {
        if ("value" in child && "placeholder" in child) {
          val = (child as any).value?.trim() || defaultValue;
          break;
        }
      }
      resolve(val);
    });

    renderer.root.add(input);
    input.focus();
  });
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function buildStatusBar() {
  const config = loadConfig();
  const running = serviceStatus();

  const serviceLabel = running ? "● running" : "● stopped";
  const serviceColor = running ? GREEN : RED;
  const privacyColor =
    config.privacyLevel === "private" ? YELLOW : GREEN;

  return Box(
    { width: "100%" as any, flexDirection: "row", gap: 2, paddingLeft: 2, paddingTop: 1 },
    Text({ content: `Service: ${serviceLabel}`, fg: serviceColor }),
    Text({ content: "│", fg: DIM }),
    Text({
      content: `Privacy: ${config.privacyLevel}`,
      fg: privacyColor,
    }),
    Text({ content: "│", fg: DIM }),
    Text({ content: `Relay: ${config.relayPreference}`, fg: CYAN }),
  );
}

// ---------------------------------------------------------------------------
// Action screen wrapper
// ---------------------------------------------------------------------------

async function showActionScreen(
  title: string,
  icon: string,
  run: () => Promise<void>,
): Promise<void> {
  removeQuitHandler();
  clearRoot();

  renderer.root.add(
    Box(
      { paddingLeft: 2, paddingTop: 1, flexDirection: "column" },
      Text({ content: `${icon}  ${title}`, fg: CYAN }),
    ),
  );

  renderer.root.add(Text({ content: "", fg: DIM }));

  await run();

  renderer.root.add(
    Text({ content: "\n  Press any key to continue...", fg: DIM }),
  );
  await waitForKeypress();
  showMainMenu();
}

function addLine(content: string, color?: string): void {
  renderer.root.add(Text({ content: `  ${content}`, fg: color || WHITE }));
}

function addSeparator(width = 50): void {
  addLine("─".repeat(width), DIM);
}

function addKeyValue(key: string, value: string, valueColor?: string): void {
  renderer.root.add(
    Box(
      { flexDirection: "row", gap: 1, paddingLeft: 2 },
      Text({ content: `${key}:`, fg: DIM }),
      Text({ content: value, fg: valueColor || WHITE }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Action implementations
// ---------------------------------------------------------------------------

async function actionStatus(): Promise<void> {
  await showActionScreen("Network Status", "◉", async () => {
    const running = serviceStatus();
    if (running) {
      addLine("● Resolver is running", GREEN);
    } else {
      addLine("● Resolver is not running", YELLOW);
    }

    const config = loadConfig();
    addSeparator();
    addKeyValue("API", config.apiBaseUrl);
    addKeyValue("DNS listen", `${config.listenAddr}:${config.listenPort}`);
    addKeyValue("Privacy", config.privacyLevel);
    addKeyValue("SOCKS port", String(config.socksPort));
    addKeyValue("Relay pref", config.relayPreference);
    addSeparator();

    addLine("Checking API...", DIM);
    try {
      const { TnpApiClient } = await import("./api");
      const client = new TnpApiClient(config.apiBaseUrl);
      const tlds = await client.fetchTlds();
      addLine(
        `● API reachable — ${tlds.length} TLDs: ${tlds.join(", ")}`,
        GREEN,
      );
    } catch (err) {
      addLine(
        `● API unreachable: ${err instanceof Error ? err.message : String(err)}`,
        RED,
      );
    }

    if (activeRelayNode?.isRunning) {
      const stats = activeRelayNode.getStats();
      addLine(
        `● Relay node running — ${stats.serviceNodes} nodes, ${stats.activeCircuits} circuits`,
        GREEN,
      );
    }
  });
}

async function actionSettings(): Promise<void> {
  await showSettings();
}

async function actionUpdate(): Promise<void> {
  await showActionScreen("Update Check", "↻", async () => {
    addLine(`Current version: v${VERSION}`);
    addLine("Checking for updates...", DIM);

    const config = loadConfig();
    try {
      const res = await fetch(`${config.apiBaseUrl}/client/latest`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        addLine(`Could not check for updates (HTTP ${res.status})`, YELLOW);
        return;
      }

      const data = (await res.json()) as { version: string; url?: string };

      if (data.version === VERSION) {
        addLine(`✓ You are running the latest version (v${VERSION})`, GREEN);
      } else {
        addLine(`New version available: v${data.version}`, CYAN);
        if (data.url) {
          addLine(`Download: ${data.url}`);
        }
      }
    } catch (err) {
      addLine(
        `Could not reach update server: ${err instanceof Error ? err.message : String(err)}`,
        YELLOW,
      );
    }
  });
}

async function actionConnect(): Promise<void> {
  removeQuitHandler();
  clearRoot();

  renderer.root.add(
    Box(
      { paddingLeft: 2, paddingTop: 1, flexDirection: "column" },
      Text({ content: "↗  Connect — Overlay Client", fg: CYAN }),
    ),
  );

  addLine("Starting DNS proxy + SOCKS5 proxy...");
  addLine("Press Ctrl+C to stop and return to menu", DIM);

  const config = loadConfig();
  const { DnsProxy } = await import("./proxy");

  const proxy = new DnsProxy(config);
  proxy.enableOverlay();

  try {
    await proxy.syncTlds();
    proxy.startTldSync(5 * 60 * 1000);
    await proxy.start();

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

    addLine("● Overlay client running", GREEN);
    addKeyValue("DNS proxy", `${config.listenAddr}:${config.listenPort}`);
    addKeyValue("SOCKS5", `${config.listenAddr}:${config.socksPort}`);
    addKeyValue("Privacy", config.privacyLevel);

    await waitForCtrlC();

    addLine("Shutting down overlay client...", DIM);
    socksProxy.stop();
    tunnelManager.shutdown();
    proxy.stop();
    addLine("✓ Stopped.", GREEN);
  } catch (err) {
    addLine(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      RED,
    );
    proxy.stop();
  }

  renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
  await waitForKeypress();
  showMainMenu();
}

async function actionServe(): Promise<void> {
  removeQuitHandler();
  clearRoot();

  renderer.root.add(
    Box(
      { paddingLeft: 2, paddingTop: 1, flexDirection: "column" },
      Text({ content: "▲  Serve — Service Node", fg: CYAN }),
    ),
  );

  const domain = await promptInput("Domain (e.g. example.ox)");
  if (!domain) {
    addLine("Cancelled.", DIM);
    renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
    await waitForKeypress();
    showMainMenu();
    return;
  }

  const target = await promptInput("Local target", "localhost:80");
  const token = await promptInput("Auth token");
  if (!token) {
    addLine("Auth token is required.", RED);
    renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
    await waitForKeypress();
    showMainMenu();
    return;
  }

  const config = loadConfig();
  addLine("Starting service node...", DIM);
  addLine("Press Ctrl+C to stop and return to menu", DIM);

  try {
    const { TnpApiClient } = await import("./api");
    const apiClient = new TnpApiClient(config.apiBaseUrl);

    const preference =
      config.relayPreference === "any" ? undefined : config.relayPreference;
    const relays = await apiClient.getRelays(
      preference as "oxy" | "community" | undefined,
    );
    if (relays.length === 0) {
      addLine("No active relays found.", RED);
      renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
      await waitForKeypress();
      showMainMenu();
      return;
    }

    const relay = relays[0].endpoint;
    addKeyValue("Relay", relay);

    const { startServiceNode } = await import("./service-node");

    await startServiceNode(
      {
        domain,
        localTarget: target || "localhost:80",
        apiBaseUrl: config.apiBaseUrl,
        relayEndpoint: relay,
        identityKeyPath: config.identityKeyPath,
        authToken: token,
      },
      apiClient,
    );
  } catch (err) {
    addLine(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      RED,
    );
  }

  renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
  await waitForKeypress();
  showMainMenu();
}

async function actionInstall(): Promise<void> {
  await showActionScreen("Install System Service", "⤓", async () => {
    const config = loadConfig();
    saveConfig(config);

    const binaryPath = process.argv[1] || "tnp";
    addKeyValue("Binary", binaryPath);
    addKeyValue("Listen", `${config.listenAddr}:${config.listenPort}`);

    try {
      const { installService } = await import("./service");
      installService(binaryPath, config);
      addLine("✓ Service installed and started.", GREEN);
      addLine("TNP domains will now resolve on this device.", DIM);
    } catch (err) {
      addLine(
        `Install failed: ${err instanceof Error ? err.message : String(err)}`,
        RED,
      );
      addLine("You may need to run with sudo.", DIM);
    }
  });
}

async function actionUninstall(): Promise<void> {
  await showActionScreen("Uninstall System Service", "✗", async () => {
    try {
      const { uninstallService } = await import("./service");
      uninstallService();
      addLine("✓ Service removed.", GREEN);
      addLine("DNS configuration restored.", DIM);
    } catch (err) {
      addLine(
        `Uninstall failed: ${err instanceof Error ? err.message : String(err)}`,
        RED,
      );
      addLine("You may need to run with sudo.", DIM);
    }
  });
}

async function actionTest(): Promise<void> {
  removeQuitHandler();
  clearRoot();

  renderer.root.add(
    Box(
      { paddingLeft: 2, paddingTop: 1, flexDirection: "column" },
      Text({ content: "◎  Test Domain Resolution", fg: CYAN }),
    ),
  );

  const domain = await promptInput("Domain (e.g. example.ox)");
  if (!domain) {
    addLine("Cancelled.", DIM);
    renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
    await waitForKeypress();
    showMainMenu();
    return;
  }

  const config = loadConfig();
  addLine(`Resolving ${domain} via ${config.apiBaseUrl}...`, DIM);

  try {
    const { TnpApiClient } = await import("./api");
    const client = new TnpApiClient(config.apiBaseUrl);

    let foundAny = false;
    for (const type of ["A", "AAAA", "CNAME", "TXT"]) {
      const answers = await client.resolve(domain, type);
      for (const ans of answers) {
        renderer.root.add(
          Box(
            { flexDirection: "row", gap: 1, paddingLeft: 2 },
            Text({ content: ans.type, fg: CYAN }),
            Text({ content: ans.name }),
            Text({ content: ans.value, fg: WHITE }),
            Text({ content: `TTL: ${ans.ttl}`, fg: DIM }),
          ),
        );
        foundAny = true;
      }
    }

    if (!foundAny) {
      addLine(`(no records found for ${domain})`, YELLOW);
    }

    const nodeInfo = await client.getServiceNode(domain);
    if (nodeInfo) {
      addKeyValue(
        "[overlay] status",
        nodeInfo.status,
        nodeInfo.status === "online" ? GREEN : YELLOW,
      );
      addKeyValue(
        "[overlay] relay",
        nodeInfo.connectedRelay || "(none)",
      );
      addKeyValue("[overlay] pubkey", nodeInfo.publicKey, DIM);
    } else {
      addLine("[overlay] no service node registered", DIM);
    }
  } catch (err) {
    addLine(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      RED,
    );
  }

  renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
  await waitForKeypress();
  showMainMenu();
}

async function actionHelp(): Promise<void> {
  await showActionScreen(`tnp v${VERSION} — The Network Protocol`, "?", async () => {
    addLine("Usage:", WHITE);
    const commands = [
      ["tnp run", "Start the DNS resolver in the foreground"],
      ["tnp connect", "Start overlay client (DNS proxy + SOCKS5 proxy)"],
      ["tnp serve", "Start service node mode (serve a domain)"],
      ["tnp relay", "Start a community relay"],
      ["tnp install", "Install as a system service and configure DNS"],
      ["tnp uninstall", "Remove the system service and DNS configuration"],
      ["tnp status", "Check if the resolver service is running"],
      ["tnp test <domain>", "Test resolving a TNP domain"],
      ["tnp version", "Print version"],
      ["tnp help", "Show this help"],
    ];

    for (const [cmd, desc] of commands) {
      renderer.root.add(
        Box(
          { flexDirection: "row", gap: 1, paddingLeft: 4 },
          Text({ content: cmd.padEnd(22), fg: CYAN }),
          Text({ content: desc, fg: DIM }),
        ),
      );
    }

    addLine("");
    addLine("Overlay commands:", WHITE);
    addLine("  tnp connect [--privacy access|private]", CYAN);
    addLine(
      "    Starts both the DNS proxy and a SOCKS5 proxy. TNP domains with active",
    );
    addLine(
      "    service nodes are routed through encrypted tunnels via relay nodes.",
    );
    addLine("");
    addLine(
      "  tnp serve --domain <domain> [--target <host:port>] [--relay <wss://url>] --token <token>",
      CYAN,
    );
    addLine(
      "    Registers this machine as a service node for the given domain.",
    );
    addLine("");
    addKeyValue("Config", "/etc/tnp/config.json");
    addKeyValue("Docs", "https://tnp.network/install");
  });
}

// ---------------------------------------------------------------------------
// Relay node submenu & actions
// ---------------------------------------------------------------------------

async function actionStartRelay(): Promise<void> {
  removeQuitHandler();
  clearRoot();

  renderer.root.add(
    Box(
      { paddingLeft: 2, paddingTop: 1, flexDirection: "column" },
      Text({ content: "▶  Start Relay Node", fg: CYAN }),
    ),
  );

  const config = loadConfig();

  if (activeRelayNode?.isRunning) {
    addLine(
      `A relay node is already running on port ${config.relayPort}`,
      YELLOW,
    );
    addLine("Stop it first by pressing Ctrl+C from its live view,", DIM);
    addLine("or restart the client to clear the state.", DIM);
    renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
    await waitForKeypress();
    showRelayMenu();
    return;
  }

  let authToken = config.relayAuthToken;
  if (!authToken) {
    authToken = await promptInput("Auth token");
    if (!authToken) {
      addLine("Cancelled.", DIM);
      renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
      await waitForKeypress();
      showRelayMenu();
      return;
    }
    config.relayAuthToken = authToken;
    try {
      saveConfig(config);
    } catch (err) {
      addLine(
        `Could not save config (may need sudo): ${err instanceof Error ? err.message : String(err)}`,
        DIM,
      );
    }
  } else {
    addLine("Using saved auth token", DIM);
  }

  const portInput = await promptInput("Port", String(config.relayPort));
  const port = portInput ? parseInt(portInput, 10) : config.relayPort;
  if (isNaN(port) || port < 1 || port > 65535) {
    addLine("Invalid port number", RED);
    renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
    await waitForKeypress();
    showRelayMenu();
    return;
  }

  const locationInput = await promptInput(
    "Location label",
    config.relayLocation || "none",
  );
  const location = locationInput || config.relayLocation;

  config.relayPort = port;
  config.relayLocation = location;
  try {
    saveConfig(config);
  } catch (err) {
    addLine(
      `Could not save config (may need sudo): ${err instanceof Error ? err.message : String(err)}`,
      DIM,
    );
  }

  addLine(`Starting relay node on port ${port}...`, DIM);

  try {
    const { RelayNode } = await import("./relay-node");
    const { TnpApiClient } = await import("./api");

    const apiClient = new TnpApiClient(config.apiBaseUrl);

    const relay = new RelayNode({
      port,
      host: "0.0.0.0",
      maxConnections: config.relayMaxConnections,
      authToken,
      location,
      apiBaseUrl: config.apiBaseUrl,
    });

    await relay.start(apiClient);
    activeRelayNode = relay;

    addLine("✓ Relay node running", GREEN);
    addKeyValue("Port", String(port));
    addKeyValue("Location", location || "(not set)");
    addKeyValue("Max conns", String(config.relayMaxConnections));
    addLine("");
    addLine("Press Ctrl+C to stop and return to menu", DIM);

    // Live stats display
    const statsNode = Text({ content: "", fg: CYAN });
    renderer.root.add(statsNode);

    const statsInterval = setInterval(() => {
      const stats = relay.getStats();
      // Update the text content on the materialized renderable
      const children = renderer.root.getChildren();
      for (const child of children) {
        if ((child as any)._id === (statsNode as any).__pendingCalls?.[0]?.args?.[0] ||
            child === children[children.length - 1]) {
          try {
            (child as any).content = `  ▸ Nodes: ${stats.serviceNodes}  Circuits: ${stats.activeCircuits}  Traffic: ${formatBytes(stats.bytesRelayed)}  Uptime: ${formatUptime(stats.uptimeSeconds)}`;
          } catch {}
          break;
        }
      }
    }, 1000);

    await waitForCtrlC();

    clearInterval(statsInterval);
    addLine("Stopping relay node...", DIM);
    relay.stop();
    activeRelayNode = null;
    addLine("✓ Relay stopped.", GREEN);
  } catch (err) {
    addLine(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
      RED,
    );
  }

  renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
  await waitForKeypress();
  showRelayMenu();
}

async function actionConfigureRelay(): Promise<void> {
  removeQuitHandler();
  clearRoot();

  renderer.root.add(
    Box(
      { paddingLeft: 2, paddingTop: 1, flexDirection: "column" },
      Text({ content: "⚙  Configure Relay", fg: CYAN }),
    ),
  );

  const config = loadConfig();

  const portInput = await promptInput(
    "Relay port",
    String(config.relayPort),
  );
  if (portInput) {
    const n = parseInt(portInput, 10);
    if (isNaN(n) || n < 1 || n > 65535) {
      addLine("Invalid port number", RED);
      renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
      await waitForKeypress();
      showRelayMenu();
      return;
    }
    config.relayPort = n;
  }

  const locationInput = await promptInput(
    "Location label",
    config.relayLocation || "none",
  );
  if (locationInput) {
    config.relayLocation = locationInput;
  }

  const maxInput = await promptInput(
    "Max connections",
    String(config.relayMaxConnections),
  );
  if (maxInput) {
    const n = parseInt(maxInput, 10);
    if (isNaN(n) || n < 1 || n > 10000) {
      addLine("Must be 1-10000", RED);
      renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
      await waitForKeypress();
      showRelayMenu();
      return;
    }
    config.relayMaxConnections = n;
  }

  const tokenInput = await promptInput(
    "Auth token",
    config.relayAuthToken ? "****" : "not set",
  );
  if (tokenInput && tokenInput !== "****") {
    config.relayAuthToken = tokenInput;
  }

  try {
    saveConfig(config);
    addLine("✓ Relay configuration saved.", GREEN);
  } catch (err) {
    addLine(
      `Failed to save: ${err instanceof Error ? err.message : String(err)}`,
      RED,
    );
    addLine("You may need to run with sudo to write to the config directory.", DIM);
  }

  renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
  await waitForKeypress();
  showRelayMenu();
}

async function actionViewNodeStats(): Promise<void> {
  removeQuitHandler();
  clearRoot();

  renderer.root.add(
    Box(
      { paddingLeft: 2, paddingTop: 1, flexDirection: "column" },
      Text({ content: "▓  Node Statistics", fg: CYAN }),
    ),
  );

  if (!activeRelayNode?.isRunning) {
    addLine("No relay node is currently running.", DIM);
    addLine('Start one from the "Start Relay Node" option.', DIM);
    renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
    await waitForKeypress();
    showRelayMenu();
    return;
  }

  const stats = activeRelayNode.getStats();
  addSeparator();
  addKeyValue("Status", "● Running", GREEN);
  addKeyValue("Uptime", formatUptime(stats.uptimeSeconds));
  addSeparator();
  addKeyValue("Service nodes", String(stats.serviceNodes));
  addKeyValue("Active circuits", String(stats.activeCircuits));
  addKeyValue("Total conns", String(stats.totalConnections));
  addKeyValue("Traffic relayed", formatBytes(stats.bytesRelayed));
  addSeparator();

  renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
  await waitForKeypress();
  showRelayMenu();
}

// ---------------------------------------------------------------------------
// Relay node submenu
// ---------------------------------------------------------------------------

function showRelayMenu(): void {
  removeQuitHandler();
  clearRoot();

  renderer.root.add(
    Box(
      { paddingLeft: 2, paddingTop: 1, flexDirection: "column", gap: 1 },
      Text({ content: "⊛  Become a TNP Network Node", fg: CYAN }),
      Text({
        content:
          "By running a relay node, you help route encrypted traffic",
        fg: DIM,
      }),
      Text({
        content:
          "for TNP users. You contribute bandwidth and strengthen",
        fg: DIM,
      }),
      Text({
        content: "the network. Your node never sees decrypted content.",
        fg: DIM,
      }),
    ),
  );

  renderer.root.add(
    Box(
      { paddingLeft: 2, paddingTop: 1, flexDirection: "column" },
      Text({ content: "Requirements:", fg: WHITE }),
      Text({ content: "  • Stable internet connection" }),
      Text({ content: "  • Port 8080 open (configurable)" }),
      Text({ content: "  • Oxy account (for registration)" }),
    ),
  );

  const relayItems = [
    { name: "▶ Start Relay Node", description: "Launch a relay node" },
    { name: "⚙ Configure Relay", description: "Edit relay settings" },
    { name: "▓ View Node Stats", description: "View relay statistics" },
    { name: "← Back", description: "Return to main menu" },
  ];

  const menu = Select({
    options: relayItems,
    selectedBackgroundColor: SELECTED_BG,
    selectedTextColor: WHITE,
    textColor: DIM,
    descriptionColor: DIM,
    wrapSelection: true,
    width: 60,
    paddingTop: 1,
    paddingLeft: 2,
  });

  onEvent(menu, SelectRenderableEvents.ITEM_SELECTED, async (index: number) => {
    switch (index) {
      case 0:
        await actionStartRelay();
        break;
      case 1:
        await actionConfigureRelay();
        break;
      case 2:
        await actionViewNodeStats();
        break;
      case 3:
        showMainMenu();
        break;
    }
  });

  renderer.root.add(menu);
  menu.focus();

  // 'q' to go back
  quitKeyHandler = (key: KeyEvent) => {
    if (key.name === "q" || key.name === "escape") {
      showMainMenu();
    }
  };
  onKey(quitKeyHandler);
}

// ---------------------------------------------------------------------------
// Settings submenu
// ---------------------------------------------------------------------------

function showSettings(): void {
  removeQuitHandler();
  clearRoot();

  const config = loadConfig();

  renderer.root.add(
    Box(
      { paddingLeft: 2, paddingTop: 1, flexDirection: "column" },
      Text({ content: "⚙  Settings", fg: CYAN }),
      Text({
        content: "Configure DNS, privacy, and network preferences",
        fg: DIM,
      }),
    ),
  );

  const options = SETTING_FIELDS.map((f) => ({
    name: f.label,
    description: String(config[f.key]),
  }));
  options.push({ name: "← Back", description: "" });

  const menu = Select({
    options,
    selectedBackgroundColor: SELECTED_BG,
    selectedTextColor: WHITE,
    textColor: DIM,
    descriptionColor: DIM,
    wrapSelection: true,
    width: 60,
    paddingTop: 1,
    paddingLeft: 2,
  });

  onEvent(menu, SelectRenderableEvents.ITEM_SELECTED, async (index: number) => {
    if (index === SETTING_FIELDS.length) {
      showMainMenu();
      return;
    }

    const field = SETTING_FIELDS[index];
    const currentValue = String(config[field.key]);

    // Clear and show inline edit
    removeQuitHandler();
    clearRoot();

    renderer.root.add(
      Box(
        { paddingLeft: 2, paddingTop: 1, flexDirection: "column" },
        Text({ content: `Edit: ${field.label}`, fg: CYAN }),
        Text({ content: `Current value: ${currentValue}`, fg: DIM }),
      ),
    );

    const newValue = await promptInput(field.label, currentValue);

    if (!newValue || newValue === currentValue) {
      showSettings();
      return;
    }

    if (field.validate) {
      const error = field.validate(newValue);
      if (error !== null) {
        addLine(error, RED);
        renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
        await waitForKeypress();
        showSettings();
        return;
      }
    }

    const transformed = field.transform
      ? field.transform(newValue)
      : newValue;
    (config as unknown as Record<string, string | number>)[field.key] = transformed;

    try {
      saveConfig(config);
      addLine("✓ Saved.", GREEN);
    } catch (err) {
      addLine(
        `Failed to save: ${err instanceof Error ? err.message : String(err)}`,
        RED,
      );
      addLine(
        "You may need to run with sudo to write to the config directory.",
        DIM,
      );
    }

    renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
    await waitForKeypress();
    showSettings();
  });

  renderer.root.add(menu);
  menu.focus();

  quitKeyHandler = (key: KeyEvent) => {
    if (key.name === "q" || key.name === "escape") {
      showMainMenu();
    }
  };
  onKey(quitKeyHandler);
}

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

const MENU_ITEMS: MenuItem[] = [
  // Primary actions
  {
    label: "Status",
    description: "Check resolver & network health",
    icon: "◉",
    action: actionStatus,
    group: "primary",
  },
  {
    label: "Connect",
    description: "Start the overlay network client",
    icon: "↗",
    action: actionConnect,
    group: "primary",
  },
  {
    label: "Serve",
    description: "Host a service on your domain",
    icon: "▲",
    action: actionServe,
    group: "primary",
  },
  {
    label: "Become a Node",
    description: "Contribute to the TNP network",
    icon: "⊛",
    action: () => {
      showRelayMenu();
      return Promise.resolve();
    },
    group: "primary",
  },
  // System
  {
    label: "Settings",
    description: "Configure DNS, privacy & more",
    icon: "⚙",
    action: actionSettings,
    group: "system",
  },
  {
    label: "Update",
    description: "Check for new versions",
    icon: "↻",
    action: actionUpdate,
    group: "system",
  },
  {
    label: "Install Service",
    description: "Install as system daemon",
    icon: "⤓",
    action: actionInstall,
    group: "system",
  },
  {
    label: "Uninstall",
    description: "Remove TNP from this system",
    icon: "✗",
    action: actionUninstall,
    group: "system",
  },
  // Tools
  {
    label: "Test Domain",
    description: "Resolve a TNP domain",
    icon: "◎",
    action: actionTest,
    group: "tools",
  },
  {
    label: "Help",
    description: "Show all commands",
    icon: "?",
    action: actionHelp,
    group: "tools",
  },
  {
    label: "Exit",
    description: "",
    icon: "←",
    action: async () => {},
    group: "tools",
  },
];

function showMainMenu(): void {
  removeQuitHandler();
  clearRoot();

  // Header: ASCII art logo + tagline
  renderer.root.add(
    Box(
      { paddingLeft: 2, paddingTop: 1, flexDirection: "column" },
      ASCIIFont({ text: "TNP", font: "block", color: CYAN, selectable: false }),
      Text({
        content: "The Network Protocol — Your internet, your rules",
        fg: DIM,
      }),
    ),
  );

  // Menu
  const menuOptions = MENU_ITEMS.map((item) => ({
    name: `${item.icon} ${item.label}`,
    description: item.description,
  }));

  const menu = Select({
    options: menuOptions,
    selectedBackgroundColor: SELECTED_BG,
    selectedTextColor: WHITE,
    textColor: DIM,
    descriptionColor: DIM,
    wrapSelection: true,
    showDescription: true,
    width: 70,
    paddingTop: 1,
    paddingLeft: 2,
  });

  onEvent(menu, SelectRenderableEvents.ITEM_SELECTED, async (index: number) => {
    const item = MENU_ITEMS[index];

    if (item.label === "Exit") {
      renderer.destroy();
      process.exit(0);
    }

    try {
      await item.action();
    } catch (err) {
      addLine(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
        RED,
      );
      renderer.root.add(Text({ content: "\n  Press any key to continue...", fg: DIM }));
      await waitForKeypress();
      showMainMenu();
    }
  });

  renderer.root.add(menu);
  menu.focus();

  // Status bar
  renderer.root.add(buildStatusBar());

  // Key hints
  renderer.root.add(
    Text({
      content: "  ↑/↓ Navigate  ⏎ Select  q Quit",
      fg: DIM,
      paddingTop: 1,
      paddingLeft: 2,
    } as any),
  );

  // 'q' to quit
  quitKeyHandler = (key: KeyEvent) => {
    if (key.name === "q") {
      renderer.destroy();
      process.exit(0);
    }
  };
  onKey(quitKeyHandler);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function startInteractive(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log(`tnp v${VERSION} -- The Network Protocol`);
    console.log("Run 'tnp help' for usage information.");
    console.log("Interactive mode requires a terminal.");
    process.exit(0);
  }

  renderer = await createCliRenderer({ exitOnCtrlC: false });
  showMainMenu();

  // Keep the process alive
  await new Promise<void>(() => {});
}
