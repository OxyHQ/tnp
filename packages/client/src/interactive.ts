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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MenuItem {
  label: string;
  description: string;
  action: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

function write(text: string): void {
  process.stdout.write(text);
}

/**
 * Read a line of input from the user with raw mode temporarily disabled.
 * Returns the trimmed input string.
 */
function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    // Disable raw mode so the user can type normally with backspace, etc.
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
          // Re-enable raw mode for the menu
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
          }
          write(HIDE_CURSOR);
          resolve(buf.trim());
          return;
        } else if (ch === "\x7F" || ch === "\b") {
          // Backspace
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            write("\b \b");
          }
        } else if (ch === "\x03") {
          // Ctrl+C during input -- return empty
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

// ---------------------------------------------------------------------------
// Settings submenu
// ---------------------------------------------------------------------------

interface SettingField {
  key: keyof TnpConfig;
  label: string;
  validate?: (value: string) => string | null; // returns error string or null
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
  const totalItems = SETTING_FIELDS.length + 1; // +1 for "Back"

  const config = loadConfig();

  const renderSettings = (): void => {
    write(CLEAR_SCREEN);
    write(`\n  ${BOLD}${WHITE}Settings${RESET}\n\n`);

    for (let i = 0; i < SETTING_FIELDS.length; i++) {
      const field = SETTING_FIELDS[i];
      const value = String(config[field.key]);
      const isSelected = i === selectedIndex;

      if (isSelected) {
        write(`  ${GREEN}${BOLD}> ${field.label.padEnd(20)}${RESET} ${CYAN}${value}${RESET}\n`);
      } else {
        write(`  ${DIM}  ${field.label.padEnd(20)}${RESET} ${DIM}${value}${RESET}\n`);
      }
    }

    // Back option
    write("\n");
    if (selectedIndex === backIndex) {
      write(`  ${GREEN}${BOLD}> ${"\u2190"} Back${RESET}\n`);
    } else {
      write(`  ${DIM}  ${"\u2190"} Back${RESET}\n`);
    }

    write(`\n  ${DIM}\u2191/\u2193 Navigate  \u23CE Select  q Back${RESET}\n`);
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
        // Ctrl+C
        process.stdin.removeListener("data", onData);
        resolve();
        return;
      }

      if (key === "\x1B[A") {
        // Up arrow
        selectedIndex = (selectedIndex - 1 + totalItems) % totalItems;
        renderSettings();
        return;
      }

      if (key === "\x1B[B") {
        // Down arrow
        selectedIndex = (selectedIndex + 1) % totalItems;
        renderSettings();
        return;
      }

      if (key === "\r") {
        // Enter
        if (selectedIndex === backIndex) {
          process.stdin.removeListener("data", onData);
          resolve();
          return;
        }

        const field = SETTING_FIELDS[selectedIndex];
        const currentValue = String(config[field.key]);

        // Temporarily remove this listener while reading input
        process.stdin.removeListener("data", onData);

        write(`\n`);
        const newValue = await readLine(`  ${field.label} [${currentValue}]: `);

        if (newValue === "") {
          // Keep current value
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
          write(`  ${GREEN}Saved.${RESET}\n`);
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
// Menu actions
// ---------------------------------------------------------------------------

async function actionStatus(): Promise<void> {
  write(`\n  ${BOLD}Status${RESET}\n\n`);

  const running = serviceStatus();
  if (running) {
    write(`  ${GREEN}Resolver is running${RESET}\n`);
  } else {
    write(`  ${YELLOW}Resolver is not running${RESET}\n`);
  }

  const config = loadConfig();
  write(`  API:          ${config.apiBaseUrl}\n`);
  write(`  DNS listen:   ${config.listenAddr}:${config.listenPort}\n`);
  write(`  Privacy:      ${config.privacyLevel}\n`);
  write(`  SOCKS port:   ${config.socksPort}\n`);
  write(`  Relay pref:   ${config.relayPreference}\n`);

  // Try to fetch TLDs from the API
  write(`\n  ${DIM}Checking API...${RESET}`);
  try {
    const { TnpApiClient } = await import("./api");
    const client = new TnpApiClient(config.apiBaseUrl);
    const tlds = await client.fetchTlds();
    // Clear "Checking API..." line
    write(`\r${ESC}[2K`);
    write(`  ${GREEN}API reachable${RESET} - ${tlds.length} TLDs loaded: ${tlds.join(", ")}\n`);
  } catch (err) {
    write(`\r${ESC}[2K`);
    write(`  ${RED}API unreachable${RESET}: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  await waitForKey();
}

async function actionSettings(): Promise<void> {
  await settingsSubmenu();
}

async function actionUpdate(): Promise<void> {
  write(`\n  ${BOLD}Update check${RESET}\n\n`);
  write(`  Current version: v${VERSION}\n`);
  write(`  ${DIM}Checking for updates...${RESET}`);

  const config = loadConfig();
  try {
    const res = await fetch(`${config.apiBaseUrl}/client/latest`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      write(`\r${ESC}[2K`);
      write(`  ${YELLOW}Could not check for updates (HTTP ${res.status})${RESET}\n`);
      await waitForKey();
      return;
    }

    const data = (await res.json()) as { version: string; url?: string };
    write(`\r${ESC}[2K`);

    if (data.version === VERSION) {
      write(`  ${GREEN}You are running the latest version (v${VERSION})${RESET}\n`);
    } else {
      write(`  ${CYAN}New version available: v${data.version}${RESET}\n`);
      if (data.url) {
        write(`  Download: ${data.url}\n`);
      }
    }
  } catch (err) {
    write(`\r${ESC}[2K`);
    write(`  ${YELLOW}Could not reach update server${RESET}: ${err instanceof Error ? err.message : String(err)}\n`);
  }

  await waitForKey();
}

async function actionConnect(): Promise<void> {
  write(`\n  ${BOLD}Connect - Overlay Client${RESET}\n\n`);
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

    write(`  ${GREEN}Overlay client running${RESET}\n`);
    write(`  DNS proxy:  ${config.listenAddr}:${config.listenPort}\n`);
    write(`  SOCKS5:     ${config.listenAddr}:${config.socksPort}\n`);
    write(`  Privacy:    ${config.privacyLevel}\n\n`);

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

    write(`\n  ${DIM}Shutting down overlay client...${RESET}\n`);
    socksProxy.stop();
    tunnelManager.shutdown();
    proxy.stop();
    write(`  ${GREEN}Stopped.${RESET}\n`);
  } catch (err) {
    write(`  ${RED}Error: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    proxy.stop();
  }

  await waitForKey();
}

async function actionServe(): Promise<void> {
  write(`\n  ${BOLD}Serve - Service Node${RESET}\n\n`);

  const domain = await readLine("  Domain (e.g. example.ox): ");
  if (!domain) {
    write(`  ${DIM}Cancelled.${RESET}\n`);
    await waitForKey();
    return;
  }

  const target = await readLine("  Local target [localhost:80]: ");
  const token = await readLine("  Auth token: ");
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

    // Discover relay
    const preference = config.relayPreference === "any" ? undefined : config.relayPreference;
    const relays = await apiClient.getRelays(preference as "oxy" | "community" | undefined);
    if (relays.length === 0) {
      write(`  ${RED}No active relays found.${RESET}\n`);
      await waitForKey();
      return;
    }

    const relay = relays[0].endpoint;
    write(`  Relay: ${relay}\n`);

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
  write(`\n  ${BOLD}Install System Service${RESET}\n\n`);

  const config = loadConfig();
  saveConfig(config);

  const binaryPath = process.argv[1] || "tnp";
  write(`  Binary:  ${binaryPath}\n`);
  write(`  Listen:  ${config.listenAddr}:${config.listenPort}\n\n`);

  try {
    const { installService } = await import("./service");
    installService(binaryPath, config);
    write(`  ${GREEN}Service installed and started.${RESET}\n`);
    write(`  TNP domains will now resolve on this device.\n`);
  } catch (err) {
    write(`  ${RED}Install failed: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    write(`  ${DIM}You may need to run with sudo.${RESET}\n`);
  }

  await waitForKey();
}

async function actionUninstall(): Promise<void> {
  write(`\n  ${BOLD}Uninstall System Service${RESET}\n\n`);

  try {
    const { uninstallService } = await import("./service");
    uninstallService();
    write(`  ${GREEN}Service removed.${RESET}\n`);
    write(`  DNS configuration restored.\n`);
  } catch (err) {
    write(`  ${RED}Uninstall failed: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
    write(`  ${DIM}You may need to run with sudo.${RESET}\n`);
  }

  await waitForKey();
}

async function actionTest(): Promise<void> {
  write(`\n  ${BOLD}Test Domain Resolution${RESET}\n\n`);

  const domain = await readLine("  Domain to test (e.g. example.ox): ");
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
        write(`  ${ans.type}\t${ans.name}\t${ans.value}\t${DIM}(TTL: ${ans.ttl})${RESET}\n`);
        foundAny = true;
      }
    }

    if (!foundAny) {
      write(`  ${YELLOW}(no records found for ${domain})${RESET}\n`);
    }

    // Check overlay status
    write("\n");
    const nodeInfo = await client.getServiceNode(domain);
    if (nodeInfo) {
      write(`  ${CYAN}[overlay]${RESET} status: ${nodeInfo.status}\n`);
      write(`  ${CYAN}[overlay]${RESET} relay: ${nodeInfo.connectedRelay || "(none)"}\n`);
      write(`  ${CYAN}[overlay]${RESET} pubkey: ${nodeInfo.publicKey}\n`);
    } else {
      write(`  ${DIM}[overlay] no service node registered${RESET}\n`);
    }
  } catch (err) {
    write(`  ${RED}Error: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
  }

  await waitForKey();
}

async function actionHelp(): Promise<void> {
  write(`\n  ${BOLD}tnp v${VERSION}${RESET} -- The Network Protocol resolver & overlay client\n`);
  write(`\n  ${BOLD}Usage:${RESET}\n`);
  write(`    tnp run              Start the DNS resolver in the foreground\n`);
  write(`    tnp connect          Start overlay client (DNS proxy + SOCKS5 proxy)\n`);
  write(`    tnp serve            Start service node mode (serve a domain)\n`);
  write(`    tnp relay            Start a community relay\n`);
  write(`    tnp install          Install as a system service and configure DNS\n`);
  write(`    tnp uninstall        Remove the system service and DNS configuration\n`);
  write(`    tnp status           Check if the resolver service is running\n`);
  write(`    tnp test <domain>    Test resolving a TNP domain\n`);
  write(`    tnp version          Print version\n`);
  write(`    tnp help             Show this help\n`);
  write(`\n  ${BOLD}Overlay commands:${RESET}\n`);
  write(`    tnp connect [--privacy access|private]\n`);
  write(`      Starts both the DNS proxy and a SOCKS5 proxy. TNP domains with active\n`);
  write(`      service nodes are routed through encrypted tunnels via relay nodes.\n`);
  write(`\n    tnp serve --domain <domain> [--target <host:port>] [--relay <wss://url>] --token <token>\n`);
  write(`      Registers this machine as a service node for the given domain.\n`);
  write(`\n  ${BOLD}Config:${RESET} /etc/tnp/config.json\n`);
  write(`  ${BOLD}Docs:${RESET}   https://tnp.network/install\n`);

  await waitForKey();
}

// ---------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------

const MENU_ITEMS: MenuItem[] = [
  { label: "Status", description: "Check if the resolver is running", action: actionStatus },
  { label: "Settings", description: "Configure DNS and preferences", action: actionSettings },
  { label: "Update", description: "Check for updates", action: actionUpdate },
  { label: "Connect", description: "Start the overlay client", action: actionConnect },
  { label: "Serve", description: "Host a service on TNP", action: actionServe },
  { label: "Install", description: "Install as system service", action: actionInstall },
  { label: "Uninstall", description: "Remove TNP service", action: actionUninstall },
  { label: "Test", description: "Test domain resolution", action: actionTest },
  { label: "Help", description: "Show commands reference", action: actionHelp },
  { label: "Exit", description: "", action: async () => {} },
];

function renderMenu(selectedIndex: number): void {
  write(CLEAR_SCREEN);

  // Header box
  const title = `tnp v${VERSION} \u2014 The Network Protocol`;
  const boxWidth = title.length + 4;
  const topBorder = "\u2554" + "\u2550".repeat(boxWidth) + "\u2557";
  const bottomBorder = "\u255A" + "\u2550".repeat(boxWidth) + "\u255D";

  write(`\n  ${BOLD}${WHITE}${topBorder}${RESET}\n`);
  write(`  ${BOLD}${WHITE}\u2551${RESET}  ${BOLD}${title}${RESET}  ${BOLD}${WHITE}\u2551${RESET}\n`);
  write(`  ${BOLD}${WHITE}${bottomBorder}${RESET}\n\n`);

  // Menu items
  for (let i = 0; i < MENU_ITEMS.length; i++) {
    const item = MENU_ITEMS[i];
    const isSelected = i === selectedIndex;

    if (isSelected) {
      write(`  ${GREEN}${BOLD}> ${item.label.padEnd(16)}${RESET}`);
      if (item.description) {
        write(`${item.description}`);
      }
      write("\n");
    } else {
      write(`  ${DIM}  ${item.label.padEnd(16)}${RESET}`);
      if (item.description) {
        write(`${DIM}${item.description}${RESET}`);
      }
      write("\n");
    }
  }

  // Footer
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
  // Verify we have a TTY
  if (!process.stdin.isTTY) {
    // Not a terminal -- fall back to help text
    console.log(`tnp v${VERSION} -- The Network Protocol`);
    console.log("Run 'tnp help' for usage information.");
    console.log("Interactive mode requires a terminal.");
    process.exit(0);
  }

  let selectedIndex = 0;

  // Enter raw mode
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  write(HIDE_CURSOR);

  renderMenu(selectedIndex);

  const onData = async (data: Buffer): Promise<void> => {
    const key = data.toString("utf8");

    // Ctrl+C -- exit
    if (key === "\x03") {
      cleanup();
      write(CLEAR_SCREEN);
      process.exit(0);
    }

    // 'q' -- exit
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
      // Fall through to execute
    } else if (key !== "\r") {
      // Not Enter and not a recognized key -- ignore
      return;
    }

    // Enter or number shortcut -- execute the selected action
    if (key === "\r" || (num >= 1 && num <= Math.min(9, MENU_ITEMS.length))) {
      const item = MENU_ITEMS[selectedIndex];

      // Exit
      if (item.label === "Exit") {
        cleanup();
        write(CLEAR_SCREEN);
        process.exit(0);
      }

      // Remove listener while running action
      process.stdin.removeListener("data", onData);
      write(CLEAR_SCREEN);

      try {
        await item.action();
      } catch (err) {
        write(`\n  ${RED}Error: ${err instanceof Error ? err.message : String(err)}${RESET}\n`);
        await waitForKey();
      }

      // Return to menu
      renderMenu(selectedIndex);
      process.stdin.on("data", onData);
    }
  };

  process.stdin.on("data", onData);

  // Ensure cleanup on exit
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
