import { loadConfig, saveConfig, type TnpConfig } from "./config";
import { serviceStatus } from "./service";

const VERSION = "0.2.0";

// ---------------------------------------------------------------------------
// ANSI escape codes
// ---------------------------------------------------------------------------

const ESC = "\x1B";
const CLEAR_SCREEN = `${ESC}[2J${ESC}[H`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;
const GREEN = `${ESC}[32m`;
const CYAN = `${ESC}[36m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const WHITE = `${ESC}[37m`;
const BG_CYAN = `${ESC}[46m`;
const BLACK = `${ESC}[30m`;

// Erase the current line
const ERASE_LINE = `${ESC}[2K`;

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

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

function write(text: string): void {
  process.stdout.write(text);
}

function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

/**
 * Read a line of input from the user with raw mode temporarily disabled.
 */
function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    write(SHOW_CURSOR);
    write(prompt);

    let buf = "";
    const onData = (data: Buffer): void => {
      const str = data.toString("utf8");
      for (const ch of str) {
        if (ch === "\r" || ch === "\n") {
          write("\n");
          process.stdin.removeListener("data", onData);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
          write(HIDE_CURSOR);
          resolve(buf.trim());
          return;
        } else if (ch === "\x7F" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            write("\b \b");
          }
        } else if (ch === "\x03") {
          write("\n");
          process.stdin.removeListener("data", onData);
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
          write(HIDE_CURSOR);
          resolve("");
          return;
        } else if (ch.charCodeAt(0) >= 32) {
          buf += ch;
          write(ch);
        }
      }
    };

    process.stdin.on("data", onData);
  });
}

/**
 * Wait for any key press, then return.
 */
function waitForKey(prompt?: string): Promise<void> {
  return new Promise((resolve) => {
    write(`\n  ${DIM}${prompt ?? "Press any key to continue..."}${RESET}`);
    const onData = (): void => {
      process.stdin.removeListener("data", onData);
      resolve();
    };
    process.stdin.on("data", onData);
  });
}

/**
 * Pad a string to a specific visible width, accounting for ANSI codes.
 */
function padToWidth(text: string, width: number): string {
  // Strip ANSI codes to measure visible length
  const visible = text.replace(/\x1B\[[0-9;]*m/g, "");
  const pad = Math.max(0, width - visible.length);
  return text + " ".repeat(pad);
}

/**
 * Format bytes into a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Format seconds into a human-readable uptime string.
 */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

const LOGO = [
  `${BOLD}${CYAN}  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2557   \u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2557 ${RESET}`,
  `${BOLD}${CYAN}  \u255A\u2550\u2550\u2588\u2588\u2554\u2550\u2550\u255D\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557${RESET}`,
  `${BOLD}${CYAN}     \u2588\u2588\u2551   \u2588\u2588\u2554\u2588\u2588\u2557 \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D${RESET}`,
  `${BOLD}${CYAN}     \u2588\u2588\u2551   \u2588\u2588\u2551\u255A\u2588\u2588\u2557\u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2550\u255D ${RESET}`,
  `${BOLD}${CYAN}     \u2588\u2588\u2551   \u2588\u2588\u2551 \u255A\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2551     ${RESET}  ${DIM}v${VERSION}${RESET}`,
  `${BOLD}${CYAN}     \u255A\u2550\u255D   \u255A\u2550\u255D  \u255A\u2550\u2550\u2550\u255D\u255A\u2550\u255D     ${RESET}`,
];

const TAGLINE = `${DIM}  The Network Protocol \u2014 Your internet, your rules${RESET}`;

function renderHeader(): void {
  write("\n");
  for (const line of LOGO) {
    write(line + "\n");
  }
  write(TAGLINE + "\n");
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

function renderStatusBar(): void {
  const config = loadConfig();
  const running = serviceStatus();
  const width = getTerminalWidth();

  const serviceIcon = running
    ? `${GREEN}\u25CF${RESET} ${GREEN}running${RESET}`
    : `${RED}\u25CF${RESET} ${DIM}stopped${RESET}`;

  const privacyLabel = config.privacyLevel === "private"
    ? `${YELLOW}private${RESET}`
    : `${GREEN}${config.privacyLevel}${RESET}`;

  const bar = `  Service: ${serviceIcon}  ${DIM}\u2502${RESET}  Privacy: ${privacyLabel}  ${DIM}\u2502${RESET}  Relay: ${CYAN}${config.relayPreference}${RESET}`;
  const separator = `${DIM}  ${"─".repeat(Math.max(0, width - 4))}${RESET}`;

  write(separator + "\n");
  write(bar + "\n");
}

// ---------------------------------------------------------------------------
// Settings submenu
// ---------------------------------------------------------------------------

interface SettingField {
  key: keyof TnpConfig;
  label: string;
  validate?: (value: string) => string | null;
  transform?: (value: string) => string | number;
}

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
      if (v !== "access" && v !== "private") return 'Must be "access" or "private"';
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

async function settingsSubmenu(): Promise<void> {
  let selectedIndex = 0;
  const backIndex = SETTING_FIELDS.length;
  const totalItems = SETTING_FIELDS.length + 1;

  const config = loadConfig();

  const renderSettings = (): void => {
    write(CLEAR_SCREEN);
    write(`\n  ${BOLD}${CYAN}\u2699${RESET}  ${BOLD}${WHITE}Settings${RESET}\n`);
    write(`  ${DIM}Configure DNS, privacy, and network preferences${RESET}\n\n`);

    const width = Math.min(getTerminalWidth() - 4, 70);

    for (let i = 0; i < SETTING_FIELDS.length; i++) {
      const field = SETTING_FIELDS[i];
      const value = String(config[field.key]);
      const isSelected = i === selectedIndex;

      if (isSelected) {
        const content = `  ${BOLD}${WHITE}\u25B8 ${field.label.padEnd(20)}${RESET} ${CYAN}${value}${RESET}`;
        write(`${BG_CYAN}${BLACK}${padToWidth(`  \u25B8 ${field.label.padEnd(20)} ${value}`, width)}${RESET}\n`);
      } else {
        write(`    ${DIM}${field.label.padEnd(20)}${RESET} ${DIM}${value}${RESET}\n`);
      }
    }

    write("\n");
    if (selectedIndex === backIndex) {
      write(`${BG_CYAN}${BLACK}${padToWidth("  \u2190 Back", width)}${RESET}\n`);
    } else {
      write(`    ${DIM}\u2190 Back${RESET}\n`);
    }

    write(`\n  ${DIM}\u2191/\u2193 Navigate  \u23CE Edit  q Back${RESET}\n`);
  };

  renderSettings();

  return new Promise((resolve) => {
    const onData = async (data: Buffer): Promise<void> => {
      const key = data.toString("utf8");

      if (key === "q" || key === "\x1B") {
        process.stdin.removeListener("data", onData);
        resolve();
        return;
      }

      if (key === "\x03") {
        process.stdin.removeListener("data", onData);
        resolve();
        return;
      }

      if (key === "\x1B[A") {
        selectedIndex = (selectedIndex - 1 + totalItems) % totalItems;
        renderSettings();
        return;
      }

      if (key === "\x1B[B") {
        selectedIndex = (selectedIndex + 1) % totalItems;
        renderSettings();
        return;
      }

      if (key === "\r") {
        if (selectedIndex === backIndex) {
          process.stdin.removeListener("data", onData);
          resolve();
          return;
        }

        const field = SETTING_FIELDS[selectedIndex];
        const currentValue = String(config[field.key]);

        process.stdin.removeListener("data", onData);

        write(`\n`);
        const newValue = await readLine(`  ${field.label} [${currentValue}]: `);

        if (newValue === "") {
          process.stdin.on("data", onData);
          renderSettings();
          return;
        }

        if (field.validate) {
          const error = field.validate(newValue);
          if (error !== null) {
            write(`  ${RED}${error}${RESET}\n`);
            await waitForKey();
            process.stdin.on("data", onData);
            renderSettings();
            return;
          }
        }

        const transformed = field.transform ? field.transform(newValue) : newValue;
        (config as Record<string, string | number>)[field.key] = transformed;

        try {
          saveConfig(config);
          write(`  ${GREEN}\u2713 Saved.${RESET}\n`);
        } catch (err) {
          write(`  ${RED}Failed to save: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
          write(`  ${DIM}You may need to run with sudo to write to the config directory.${RESET}\n`);
        }

        await waitForKey();
        process.stdin.on("data", onData);
        renderSettings();
        return;
      }
    };

    process.stdin.on("data", onData);
  });
}

// ---------------------------------------------------------------------------
// "Become a Node" submenu
// ---------------------------------------------------------------------------

async function relayNodeSubmenu(): Promise<void> {
  let selectedIndex = 0;
  const items = [
    { label: "Start Relay Node", icon: "\u25B6" },
    { label: "Configure Relay", icon: "\u2699" },
    { label: "View Node Stats", icon: "\u2593" },
    { label: "\u2190 Back", icon: "" },
  ];

  const renderRelayMenu = (): void => {
    write(CLEAR_SCREEN);
    write(`\n  ${BOLD}${CYAN}\u229B${RESET}  ${BOLD}${WHITE}Become a TNP Network Node${RESET}\n\n`);
    write(`  ${DIM}By running a relay node, you help route encrypted traffic${RESET}\n`);
    write(`  ${DIM}for TNP users. You contribute bandwidth and strengthen${RESET}\n`);
    write(`  ${DIM}the network. Your node never sees decrypted content.${RESET}\n\n`);

    write(`  ${BOLD}Requirements:${RESET}\n`);
    write(`    ${DIM}\u2022${RESET} Stable internet connection\n`);
    write(`    ${DIM}\u2022${RESET} Port 8080 open (configurable)\n`);
    write(`    ${DIM}\u2022${RESET} Oxy account (for registration)\n\n`);

    const width = Math.min(getTerminalWidth() - 4, 70);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isSelected = i === selectedIndex;

      if (isSelected) {
        write(`${BG_CYAN}${BLACK}${padToWidth(`  ${item.icon ? item.icon + " " : ""}${item.label}`, width)}${RESET}\n`);
      } else {
        write(`    ${DIM}${item.icon ? item.icon + " " : ""}${item.label}${RESET}\n`);
      }
    }

    write(`\n  ${DIM}\u2191/\u2193 Navigate  \u23CE Select  q Back${RESET}\n`);
  };

  renderRelayMenu();

  return new Promise((resolve) => {
    const onData = async (data: Buffer): Promise<void> => {
      const key = data.toString("utf8");

      if (key === "q" || key === "\x1B") {
        process.stdin.removeListener("data", onData);
        resolve();
        return;
      }

      if (key === "\x03") {
        process.stdin.removeListener("data", onData);
        resolve();
        return;
      }

      if (key === "\x1B[A") {
        selectedIndex = (selectedIndex - 1 + items.length) % items.length;
        renderRelayMenu();
        return;
      }

      if (key === "\x1B[B") {
        selectedIndex = (selectedIndex + 1) % items.length;
        renderRelayMenu();
        return;
      }

      if (key === "\r") {
        const label = items[selectedIndex].label;

        if (label.includes("Back")) {
          process.stdin.removeListener("data", onData);
          resolve();
          return;
        }

        process.stdin.removeListener("data", onData);
        write(CLEAR_SCREEN);

        if (label === "Start Relay Node") {
          await actionStartRelay();
        } else if (label === "Configure Relay") {
          await actionConfigureRelay();
        } else if (label === "View Node Stats") {
          await actionViewNodeStats();
        }

        renderRelayMenu();
        process.stdin.on("data", onData);
      }
    };

    process.stdin.on("data", onData);
  });
}

// Active relay node reference (module-level so stats can be viewed)
let activeRelayNode: import("./relay-node").RelayNode | null = null;

async function actionStartRelay(): Promise<void> {
  write(`\n  ${BOLD}${CYAN}\u25B6${RESET}  ${BOLD}Start Relay Node${RESET}\n\n`);

  const config = loadConfig();

  // Check for existing running relay
  if (activeRelayNode?.isRunning) {
    write(`  ${YELLOW}A relay node is already running on port ${config.relayPort}${RESET}\n\n`);
    write(`  ${DIM}Stop it first by pressing Ctrl+C from its live view,${RESET}\n`);
    write(`  ${DIM}or restart the client to clear the state.${RESET}\n`);
    await waitForKey();
    return;
  }

  // Auth token
  let authToken = config.relayAuthToken;
  if (!authToken) {
    authToken = await readLine(`  ${BOLD}Auth token:${RESET} `);
    if (!authToken) {
      write(`  ${DIM}Cancelled.${RESET}\n`);
      await waitForKey();
      return;
    }
    // Save for future use
    config.relayAuthToken = authToken;
    try {
      saveConfig(config);
    } catch {
      // Non-fatal: config write may fail without sudo
    }
  } else {
    write(`  ${DIM}Using saved auth token${RESET}\n`);
  }

  // Port
  const portInput = await readLine(`  ${BOLD}Port${RESET} [${config.relayPort}]: `);
  const port = portInput ? parseInt(portInput, 10) : config.relayPort;
  if (isNaN(port) || port < 1 || port > 65535) {
    write(`  ${RED}Invalid port number${RESET}\n`);
    await waitForKey();
    return;
  }

  // Location
  const locationInput = await readLine(`  ${BOLD}Location label${RESET} [${config.relayLocation || "none"}]: `);
  const location = locationInput || config.relayLocation;

  // Save updated config
  config.relayPort = port;
  config.relayLocation = location;
  try {
    saveConfig(config);
  } catch {
    // Non-fatal
  }

  write(`\n  ${DIM}Starting relay node on port ${port}...${RESET}\n`);

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

    write(`\n  ${GREEN}\u2713 Relay node running${RESET}\n`);
    write(`  ${DIM}Port:${RESET}        ${port}\n`);
    write(`  ${DIM}Location:${RESET}    ${location || "(not set)"}\n`);
    write(`  ${DIM}Max conns:${RESET}   ${config.relayMaxConnections}\n\n`);

    // Live stats display
    write(`  ${DIM}Press Ctrl+C to stop and return to menu${RESET}\n\n`);

    // Update stats display periodically
    const statsInterval = setInterval(() => {
      const stats = relay.getStats();
      write(`${ESC}[s`); // Save cursor
      // Move to stats display area
      write(`\r${ERASE_LINE}`);
      write(`  ${CYAN}\u25B8${RESET} Nodes: ${BOLD}${stats.serviceNodes}${RESET}  Circuits: ${BOLD}${stats.activeCircuits}${RESET}  Traffic: ${BOLD}${formatBytes(stats.bytesRelayed)}${RESET}  Uptime: ${BOLD}${formatUptime(stats.uptimeSeconds)}${RESET}`);
    }, 1000);

    // Wait for Ctrl+C
    await new Promise<void>((resolve) => {
      const onData = (data: Buffer): void => {
        if (data.toString("utf8") === "\x03") {
          process.stdin.removeListener("data", onData);
          resolve();
        }
      };
      process.stdin.on("data", onData);
    });

    clearInterval(statsInterval);
    write(`\n\n  ${DIM}Stopping relay node...${RESET}\n`);
    relay.stop();
    activeRelayNode = null;
    write(`  ${GREEN}\u2713 Relay stopped.${RESET}\n`);
  } catch (err) {
    write(`  ${RED}Error: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
  }

  await waitForKey();
}

async function actionConfigureRelay(): Promise<void> {
  write(`\n  ${BOLD}${CYAN}\u2699${RESET}  ${BOLD}Configure Relay${RESET}\n\n`);

  const config = loadConfig();

  // Port
  const portInput = await readLine(`  ${BOLD}Relay port${RESET} [${config.relayPort}]: `);
  if (portInput) {
    const n = parseInt(portInput, 10);
    if (isNaN(n) || n < 1 || n > 65535) {
      write(`  ${RED}Invalid port number${RESET}\n`);
      await waitForKey();
      return;
    }
    config.relayPort = n;
  }

  // Location
  const locationInput = await readLine(`  ${BOLD}Location label${RESET} [${config.relayLocation || "none"}]: `);
  if (locationInput) {
    config.relayLocation = locationInput;
  }

  // Max connections
  const maxInput = await readLine(`  ${BOLD}Max connections${RESET} [${config.relayMaxConnections}]: `);
  if (maxInput) {
    const n = parseInt(maxInput, 10);
    if (isNaN(n) || n < 1 || n > 10000) {
      write(`  ${RED}Must be 1-10000${RESET}\n`);
      await waitForKey();
      return;
    }
    config.relayMaxConnections = n;
  }

  // Auth token
  const tokenInput = await readLine(`  ${BOLD}Auth token${RESET} [${config.relayAuthToken ? "****" : "not set"}]: `);
  if (tokenInput) {
    config.relayAuthToken = tokenInput;
  }

  try {
    saveConfig(config);
    write(`\n  ${GREEN}\u2713 Relay configuration saved.${RESET}\n`);
  } catch (err) {
    write(`  ${RED}Failed to save: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    write(`  ${DIM}You may need to run with sudo to write to the config directory.${RESET}\n`);
  }

  await waitForKey();
}

async function actionViewNodeStats(): Promise<void> {
  write(`\n  ${BOLD}${CYAN}\u2593${RESET}  ${BOLD}Node Statistics${RESET}\n\n`);

  if (!activeRelayNode?.isRunning) {
    write(`  ${DIM}No relay node is currently running.${RESET}\n`);
    write(`  ${DIM}Start one from the "Start Relay Node" option.${RESET}\n`);
    await waitForKey();
    return;
  }

  const stats = activeRelayNode.getStats();
  const width = Math.min(getTerminalWidth() - 4, 50);
  const separator = `  ${DIM}${"─".repeat(width)}${RESET}`;

  write(separator + "\n");
  write(`  ${DIM}Status:${RESET}           ${GREEN}\u25CF Running${RESET}\n`);
  write(`  ${DIM}Uptime:${RESET}           ${BOLD}${formatUptime(stats.uptimeSeconds)}${RESET}\n`);
  write(separator + "\n");
  write(`  ${DIM}Service nodes:${RESET}    ${BOLD}${stats.serviceNodes}${RESET}\n`);
  write(`  ${DIM}Active circuits:${RESET}  ${BOLD}${stats.activeCircuits}${RESET}\n`);
  write(`  ${DIM}Total conns:${RESET}      ${BOLD}${stats.totalConnections}${RESET}\n`);
  write(`  ${DIM}Traffic relayed:${RESET}  ${BOLD}${formatBytes(stats.bytesRelayed)}${RESET}\n`);
  write(separator + "\n");

  await waitForKey();
}

// ---------------------------------------------------------------------------
// Menu actions
// ---------------------------------------------------------------------------

async function actionStatus(): Promise<void> {
  write(`\n  ${BOLD}${CYAN}\u25C9${RESET}  ${BOLD}Network Status${RESET}\n\n`);

  const running = serviceStatus();
  if (running) {
    write(`  ${GREEN}\u25CF${RESET} Resolver is ${GREEN}running${RESET}\n`);
  } else {
    write(`  ${YELLOW}\u25CF${RESET} Resolver is ${YELLOW}not running${RESET}\n`);
  }

  const config = loadConfig();
  const width = Math.min(getTerminalWidth() - 4, 50);
  const separator = `  ${DIM}${"─".repeat(width)}${RESET}`;

  write(separator + "\n");
  write(`  ${DIM}API:${RESET}          ${config.apiBaseUrl}\n`);
  write(`  ${DIM}DNS listen:${RESET}   ${config.listenAddr}:${config.listenPort}\n`);
  write(`  ${DIM}Privacy:${RESET}      ${config.privacyLevel}\n`);
  write(`  ${DIM}SOCKS port:${RESET}   ${config.socksPort}\n`);
  write(`  ${DIM}Relay pref:${RESET}   ${config.relayPreference}\n`);
  write(separator + "\n");

  write(`  ${DIM}Checking API...${RESET}`);
  try {
    const { TnpApiClient } = await import("./api");
    const client = new TnpApiClient(config.apiBaseUrl);
    const tlds = await client.fetchTlds();
    write(`\r${ERASE_LINE}`);
    write(`  ${GREEN}\u25CF${RESET} API reachable ${DIM}\u2014${RESET} ${BOLD}${tlds.length}${RESET} TLDs: ${CYAN}${tlds.join(", ")}${RESET}\n`);
  } catch (err) {
    write(`\r${ERASE_LINE}`);
    write(`  ${RED}\u25CF${RESET} API unreachable: ${RED}${err instanceof Error ? err.message : String(err)}${RESET}\n`);
  }

  // Relay node status
  if (activeRelayNode?.isRunning) {
    const stats = activeRelayNode.getStats();
    write(`\n  ${GREEN}\u25CF${RESET} Relay node ${GREEN}running${RESET} \u2014 ${stats.serviceNodes} nodes, ${stats.activeCircuits} circuits\n`);
  }

  await waitForKey();
}

async function actionSettings(): Promise<void> {
  await settingsSubmenu();
}

async function actionUpdate(): Promise<void> {
  write(`\n  ${BOLD}${CYAN}\u21BB${RESET}  ${BOLD}Update Check${RESET}\n\n`);
  write(`  Current version: ${BOLD}v${VERSION}${RESET}\n`);
  write(`  ${DIM}Checking for updates...${RESET}`);

  const config = loadConfig();
  try {
    const res = await fetch(`${config.apiBaseUrl}/client/latest`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      write(`\r${ERASE_LINE}`);
      write(`  ${YELLOW}Could not check for updates (HTTP ${res.status})${RESET}\n`);
      await waitForKey();
      return;
    }

    const data = (await res.json()) as { version: string; url?: string };
    write(`\r${ERASE_LINE}`);

    if (data.version === VERSION) {
      write(`  ${GREEN}\u2713 You are running the latest version (v${VERSION})${RESET}\n`);
    } else {
      write(`  ${CYAN}New version available: ${BOLD}v${data.version}${RESET}\n`);
      if (data.url) {
        write(`  Download: ${data.url}\n`);
      }
    }
  } catch (err) {
    write(`\r${ERASE_LINE}`);
    write(`  ${YELLOW}Could not reach update server${RESET}: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  await waitForKey();
}

async function actionConnect(): Promise<void> {
  write(`\n  ${BOLD}${CYAN}\u2197${RESET}  ${BOLD}Connect \u2014 Overlay Client${RESET}\n\n`);
  write(`  Starting DNS proxy + SOCKS5 proxy...\n`);
  write(`  ${DIM}Press Ctrl+C to stop and return to menu${RESET}\n\n`);

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

    write(`  ${GREEN}\u25CF Overlay client running${RESET}\n`);
    write(`  ${DIM}DNS proxy:${RESET}  ${config.listenAddr}:${config.listenPort}\n`);
    write(`  ${DIM}SOCKS5:${RESET}     ${config.listenAddr}:${config.socksPort}\n`);
    write(`  ${DIM}Privacy:${RESET}    ${config.privacyLevel}\n\n`);

    await new Promise<void>((resolve) => {
      const onData = (data: Buffer): void => {
        if (data.toString("utf8") === "\x03") {
          process.stdin.removeListener("data", onData);
          resolve();
        }
      };
      process.stdin.on("data", onData);
    });

    write(`\n  ${DIM}Shutting down overlay client...${RESET}\n`);
    socksProxy.stop();
    tunnelManager.shutdown();
    proxy.stop();
    write(`  ${GREEN}\u2713 Stopped.${RESET}\n`);
  } catch (err) {
    write(`  ${RED}Error: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    proxy.stop();
  }

  await waitForKey();
}

async function actionServe(): Promise<void> {
  write(`\n  ${BOLD}${CYAN}\u25B2${RESET}  ${BOLD}Serve \u2014 Service Node${RESET}\n\n`);

  const domain = await readLine(`  ${BOLD}Domain${RESET} (e.g. example.ox): `);
  if (!domain) {
    write(`  ${DIM}Cancelled.${RESET}\n`);
    await waitForKey();
    return;
  }

  const target = await readLine(`  ${BOLD}Local target${RESET} [localhost:80]: `);
  const token = await readLine(`  ${BOLD}Auth token:${RESET} `);
  if (!token) {
    write(`  ${RED}Auth token is required.${RESET}\n`);
    await waitForKey();
    return;
  }

  const config = loadConfig();
  write(`\n  ${DIM}Starting service node...${RESET}\n`);
  write(`  ${DIM}Press Ctrl+C to stop and return to menu${RESET}\n\n`);

  try {
    const { TnpApiClient } = await import("./api");
    const apiClient = new TnpApiClient(config.apiBaseUrl);

    const preference = config.relayPreference === "any" ? undefined : config.relayPreference;
    const relays = await apiClient.getRelays(preference as "oxy" | "community" | undefined);
    if (relays.length === 0) {
      write(`  ${RED}No active relays found.${RESET}\n`);
      await waitForKey();
      return;
    }

    const relay = relays[0].endpoint;
    write(`  ${DIM}Relay:${RESET} ${relay}\n`);

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
    write(`  ${RED}Error: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
  }

  await waitForKey();
}

async function actionInstall(): Promise<void> {
  write(`\n  ${BOLD}${CYAN}\u2913${RESET}  ${BOLD}Install System Service${RESET}\n\n`);

  const config = loadConfig();
  saveConfig(config);

  const binaryPath = process.argv[1] || "tnp";
  write(`  ${DIM}Binary:${RESET}  ${binaryPath}\n`);
  write(`  ${DIM}Listen:${RESET}  ${config.listenAddr}:${config.listenPort}\n\n`);

  try {
    const { installService } = await import("./service");
    installService(binaryPath, config);
    write(`  ${GREEN}\u2713 Service installed and started.${RESET}\n`);
    write(`  ${DIM}TNP domains will now resolve on this device.${RESET}\n`);
  } catch (err) {
    write(`  ${RED}Install failed: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    write(`  ${DIM}You may need to run with sudo.${RESET}\n`);
  }

  await waitForKey();
}

async function actionUninstall(): Promise<void> {
  write(`\n  ${BOLD}${CYAN}\u2717${RESET}  ${BOLD}Uninstall System Service${RESET}\n\n`);

  try {
    const { uninstallService } = await import("./service");
    uninstallService();
    write(`  ${GREEN}\u2713 Service removed.${RESET}\n`);
    write(`  ${DIM}DNS configuration restored.${RESET}\n`);
  } catch (err) {
    write(`  ${RED}Uninstall failed: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    write(`  ${DIM}You may need to run with sudo.${RESET}\n`);
  }

  await waitForKey();
}

async function actionTest(): Promise<void> {
  write(`\n  ${BOLD}${CYAN}\u25CE${RESET}  ${BOLD}Test Domain Resolution${RESET}\n\n`);

  const domain = await readLine(`  ${BOLD}Domain${RESET} (e.g. example.ox): `);
  if (!domain) {
    write(`  ${DIM}Cancelled.${RESET}\n`);
    await waitForKey();
    return;
  }

  const config = loadConfig();
  write(`\n  ${DIM}Resolving ${domain} via ${config.apiBaseUrl}...${RESET}\n\n`);

  try {
    const { TnpApiClient } = await import("./api");
    const client = new TnpApiClient(config.apiBaseUrl);

    let foundAny = false;
    for (const type of ["A", "AAAA", "CNAME", "TXT"]) {
      const answers = await client.resolve(domain, type);
      for (const ans of answers) {
        write(`  ${CYAN}${ans.type}${RESET}\t${ans.name}\t${BOLD}${ans.value}${RESET}\t${DIM}TTL: ${ans.ttl}${RESET}\n`);
        foundAny = true;
      }
    }

    if (!foundAny) {
      write(`  ${YELLOW}(no records found for ${domain})${RESET}\n`);
    }

    write("\n");
    const nodeInfo = await client.getServiceNode(domain);
    if (nodeInfo) {
      write(`  ${CYAN}[overlay]${RESET} status: ${nodeInfo.status === "online" ? GREEN : YELLOW}${nodeInfo.status}${RESET}\n`);
      write(`  ${CYAN}[overlay]${RESET} relay: ${nodeInfo.connectedRelay || DIM + "(none)" + RESET}\n`);
      write(`  ${CYAN}[overlay]${RESET} pubkey: ${DIM}${nodeInfo.publicKey}${RESET}\n`);
    } else {
      write(`  ${DIM}[overlay] no service node registered${RESET}\n`);
    }
  } catch (err) {
    write(`  ${RED}Error: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
  }

  await waitForKey();
}

async function actionHelp(): Promise<void> {
  write(`\n  ${BOLD}${CYAN}?${RESET}  ${BOLD}tnp v${VERSION}${RESET} ${DIM}\u2014 The Network Protocol${RESET}\n`);
  write(`\n  ${BOLD}Usage:${RESET}\n`);
  write(`    ${CYAN}tnp run${RESET}              Start the DNS resolver in the foreground\n`);
  write(`    ${CYAN}tnp connect${RESET}          Start overlay client (DNS proxy + SOCKS5 proxy)\n`);
  write(`    ${CYAN}tnp serve${RESET}            Start service node mode (serve a domain)\n`);
  write(`    ${CYAN}tnp relay${RESET}            Start a community relay\n`);
  write(`    ${CYAN}tnp install${RESET}          Install as a system service and configure DNS\n`);
  write(`    ${CYAN}tnp uninstall${RESET}        Remove the system service and DNS configuration\n`);
  write(`    ${CYAN}tnp status${RESET}           Check if the resolver service is running\n`);
  write(`    ${CYAN}tnp test <domain>${RESET}    Test resolving a TNP domain\n`);
  write(`    ${CYAN}tnp version${RESET}          Print version\n`);
  write(`    ${CYAN}tnp help${RESET}             Show this help\n`);
  write(`\n  ${BOLD}Overlay commands:${RESET}\n`);
  write(`    ${CYAN}tnp connect${RESET} [--privacy access|private]\n`);
  write(`      Starts both the DNS proxy and a SOCKS5 proxy. TNP domains with active\n`);
  write(`      service nodes are routed through encrypted tunnels via relay nodes.\n`);
  write(`\n    ${CYAN}tnp serve${RESET} --domain <domain> [--target <host:port>] [--relay <wss://url>] --token <token>\n`);
  write(`      Registers this machine as a service node for the given domain.\n`);
  write(`\n  ${BOLD}Config:${RESET} /etc/tnp/config.json\n`);
  write(`  ${BOLD}Docs:${RESET}   https://tnp.network/install\n`);

  await waitForKey();
}

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

const MENU_ITEMS: MenuItem[] = [
  // Primary actions
  { label: "Status", description: "Check resolver & network health", icon: "\u25C9", action: actionStatus, group: "primary" },
  { label: "Connect", description: "Start the overlay network client", icon: "\u2197", action: actionConnect, group: "primary" },
  { label: "Serve", description: "Host a service on your domain", icon: "\u25B2", action: actionServe, group: "primary" },
  { label: "Become a Node", description: "Contribute to the TNP network", icon: "\u229B", action: () => relayNodeSubmenu(), group: "primary" },
  // System
  { label: "Settings", description: "Configure DNS, privacy & more", icon: "\u2699", action: actionSettings, group: "system" },
  { label: "Update", description: "Check for new versions", icon: "\u21BB", action: actionUpdate, group: "system" },
  { label: "Install Service", description: "Install as system daemon", icon: "\u2913", action: actionInstall, group: "system" },
  { label: "Uninstall", description: "Remove TNP from this system", icon: "\u2717", action: actionUninstall, group: "system" },
  // Tools
  { label: "Test Domain", description: "Resolve a TNP domain", icon: "\u25CE", action: actionTest, group: "tools" },
  { label: "Help", description: "Show all commands", icon: "?", action: actionHelp, group: "tools" },
  { label: "Exit", description: "", icon: "\u2190", action: async () => {}, group: "tools" },
];

function renderMenu(selectedIndex: number): void {
  write(CLEAR_SCREEN);

  // Header
  renderHeader();
  write("\n");

  const width = Math.min(getTerminalWidth() - 4, 70);

  let lastGroup: string | undefined;

  for (let i = 0; i < MENU_ITEMS.length; i++) {
    const item = MENU_ITEMS[i];
    const isSelected = i === selectedIndex;

    // Group separator
    if (item.group !== lastGroup && lastGroup !== undefined) {
      write(`  ${DIM}${"─".repeat(width)}${RESET}\n`);
    }
    lastGroup = item.group;

    if (isSelected) {
      // Highlighted bar: cyan background, black text, full width
      const label = `  ${item.icon} ${item.label}`;
      const desc = item.description ? `  ${item.description}` : "";
      const lineText = `${label.padEnd(22)}${desc}`;
      write(`${BG_CYAN}${BLACK}${BOLD}${padToWidth(lineText, width + 2)}${RESET}\n`);
    } else {
      // Normal: icon + label in regular, description in dim
      const icon = `${DIM}${item.icon}${RESET}`;
      const label = item.label.padEnd(18);
      const desc = item.description ? `${DIM}${item.description}${RESET}` : "";
      write(`  ${icon} ${label} ${desc}\n`);
    }
  }

  // Status bar at bottom
  write("\n");
  renderStatusBar();

  // Key hints
  write(`\n  ${DIM}\u2191/\u2193 Navigate  \u23CE Select  q Quit${RESET}\n`);
}

function cleanup(): void {
  write(SHOW_CURSOR);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
}

export function startInteractive(): void {
  if (!process.stdin.isTTY) {
    console.log(`tnp v${VERSION} -- The Network Protocol`);
    console.log("Run 'tnp help' for usage information.");
    console.log("Interactive mode requires a terminal.");
    process.exit(0);
  }

  let selectedIndex = 0;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  write(HIDE_CURSOR);

  renderMenu(selectedIndex);

  const onData = async (data: Buffer): Promise<void> => {
    const key = data.toString("utf8");

    // Ctrl+C
    if (key === "\x03") {
      cleanup();
      write(CLEAR_SCREEN);
      process.exit(0);
    }

    // 'q'
    if (key === "q") {
      cleanup();
      write(CLEAR_SCREEN);
      process.exit(0);
    }

    // Up arrow
    if (key === "\x1B[A") {
      selectedIndex = (selectedIndex - 1 + MENU_ITEMS.length) % MENU_ITEMS.length;
      renderMenu(selectedIndex);
      return;
    }

    // Down arrow
    if (key === "\x1B[B") {
      selectedIndex = (selectedIndex + 1) % MENU_ITEMS.length;
      renderMenu(selectedIndex);
      return;
    }

    // Number shortcuts (1-9)
    const num = parseInt(key, 10);
    if (num >= 1 && num <= Math.min(9, MENU_ITEMS.length)) {
      selectedIndex = num - 1;
      renderMenu(selectedIndex);
    } else if (key !== "\r") {
      return;
    }

    // Enter or number shortcut
    if (key === "\r" || (num >= 1 && num <= Math.min(9, MENU_ITEMS.length))) {
      const item = MENU_ITEMS[selectedIndex];

      if (item.label === "Exit") {
        cleanup();
        write(CLEAR_SCREEN);
        process.exit(0);
      }

      process.stdin.removeListener("data", onData);
      write(CLEAR_SCREEN);

      try {
        await item.action();
      } catch (err) {
        write(`\n  ${RED}Error: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
        await waitForKey();
      }

      renderMenu(selectedIndex);
      process.stdin.on("data", onData);
    }
  };

  process.stdin.on("data", onData);

  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
}
