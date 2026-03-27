import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

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
  return process.platform === "darwin"
    ? "/usr/local/etc/tnp"
    : "/etc/tnp";
}

export function configPath(): string {
  return join(configDir(), "config.json");
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
