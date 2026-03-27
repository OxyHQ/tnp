import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface TnpConfig {
  listenAddr: string;
  listenPort: number;
  apiBaseUrl: string;
  upstreamDns: string;
  cacheTtlSeconds: number;
}

const DEFAULT_CONFIG: TnpConfig = {
  listenAddr: "127.0.0.1",
  listenPort: 5354,
  apiBaseUrl: "https://tnp.network/api",
  upstreamDns: "1.1.1.1",
  cacheTtlSeconds: 300,
};

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

export function loadConfig(): TnpConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = readFileSync(path, "utf-8");
  const saved = JSON.parse(raw) as Partial<TnpConfig>;
  return { ...DEFAULT_CONFIG, ...saved };
}

export function saveConfig(cfg: TnpConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n");
}
