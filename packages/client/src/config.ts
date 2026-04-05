import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

/** Default TNP public DNS resolver IP. Used as fallback when local proxy is unavailable. */
export const TNP_PUBLIC_DNS = "174.138.10.81";

/** Path to the kill switch marker file. Presence means firewall rules are active. */
export const KILLSWITCH_MARKER_PATH = join(tmpdir(), "tnp-killswitch-active");

export interface TnpConfig {
  listenAddr: string;
  listenPort: number;
  apiBaseUrl: string;
  upstreamDns: string;
  cacheTtlSeconds: number;
  privacyLevel: "access" | "private";
  socksPort: number;
  relayPreference: "oxy" | "community" | "any";
  identityKeyPath: string;
  relayPort: number;
  relayLocation: string;
  relayMaxConnections: number;
  relayAuthToken: string;
  autoConnect: boolean;
  killSwitch: boolean;
  publicDnsIp: string;
}

export function configDir(): string {
  switch (process.platform) {
    case "darwin":
      return "/usr/local/etc/tnp";
    case "win32":
      return join(process.env.PROGRAMDATA || "C:\\ProgramData", "tnp");
    default:
      return "/etc/tnp";
  }
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function dataDir(): string {
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "tnp");
    case "win32":
      return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "tnp");
    default:
      return "/var/lib/tnp";
  }
}

export function logPath(): string {
  switch (process.platform) {
    case "win32":
      return join(dataDir(), "tnp-resolver.log");
    default:
      return "/var/log/tnp-resolver.log";
  }
}

const DEFAULT_CONFIG: TnpConfig = {
  listenAddr: "127.0.0.1",
  listenPort: 5354,
  apiBaseUrl: "https://api.tnp.network",
  upstreamDns: "1.1.1.1",
  cacheTtlSeconds: 300,
  privacyLevel: "access",
  socksPort: 1080,
  relayPreference: "oxy",
  identityKeyPath: join(dataDir(), "identity.key"),
  relayPort: 8080,
  relayLocation: "",
  relayMaxConnections: 100,
  relayAuthToken: "",
  autoConnect: false,
  killSwitch: false,
  publicDnsIp: TNP_PUBLIC_DNS,
};

export function loadConfig(): TnpConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = readFileSync(path, "utf-8");
  let saved: Partial<TnpConfig>;
  try {
    saved = JSON.parse(raw) as Partial<TnpConfig>;
  } catch (err) {
    console.warn(
      `[tnp] failed to parse config at ${path}, using defaults: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { ...DEFAULT_CONFIG };
  }
  return { ...DEFAULT_CONFIG, ...saved };
}

export function saveConfig(cfg: TnpConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}
