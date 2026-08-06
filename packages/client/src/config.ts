import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

/**
 * Default TNP public DNS resolver IP. Sourced from the TNP_PUBLIC_DNS env var at
 * build/run time. There is intentionally NO hardcoded fallback: this address is
 * what we point system DNS at and write into kill-switch firewall rules, so a
 * stale literal (e.g. a retired host) would silently route DNS to a
 * dead-or-attacker-controlled resolver. When empty, "change system DNS" /
 * kill-switch paths are skipped in favour of the local proxy (see cli.ts).
 *
 * DEPLOY REQUIREMENT: set TNP_PUBLIC_DNS to the AWS NLB Elastic IP when building
 * release binaries, once the dns-server NLB is provisioned (oxy-infra
 * app-tnp.tf is pending).
 */
export const TNP_PUBLIC_DNS = process.env.TNP_PUBLIC_DNS?.trim() ?? "";

/** Path to the kill switch marker file. Presence means firewall rules are active. */
export const KILLSWITCH_MARKER_PATH = join(tmpdir(), "tnp-killswitch-active");

/**
 * The subset of configuration the DNS resolver actually consumes.
 *
 * `apps/dns-server` runs the resolver without any of the client's proxy,
 * overlay, relay or service-node settings, so it configures this interface
 * rather than fabricating a `TnpConfig` it cannot meaningfully populate.
 */
export interface DnsProxyConfig {
  listenAddr: string;
  listenPort: number;
  apiBaseUrl: string;
  /**
   * Maximum cached answers. Bounds the memory a stream of unique queries can
   * cost; entries expire on their own record TTLs, not on a fixed lifetime.
   */
  cacheMaxEntries?: number;
  /**
   * Upstream resolvers for public-DNS names, comma-separated and tried in
   * order. An entry is an address (`1.1.1.1`, `1.1.1.1:5353`, `[2606:4700::1111]`)
   * or an RFC 8484 DoH URL (`https://cloudflare-dns.com/dns-query`).
   */
  upstreamDns: string;
}

/**
 * Privacy levels the client can actually provide.
 *
 * `"private"` — multi-hop onion routing — is specified in
 * `docs/architecture/onion-routing.md` and is NOT implemented: there is no
 * multi-hop code in the repository. It was previously accepted, stored,
 * reported back to the user as `privacy: private`, and then ignored, which gave
 * anyone who asked for private routing ordinary single-hop routing plus a
 * status line telling them otherwise.
 *
 * It stays out of this union until Phase 6 (#22) implements it. The type is the
 * statement of what exists; `parsePrivacyLevel` rejects the rest by name so the
 * failure is explicit rather than silent.
 */
export type PrivacyLevel = "access";

/** Levels that are specified but not implemented, with the issue that lands each. */
const PLANNED_PRIVACY_LEVELS: Record<string, string> = {
  private: "multi-hop onion routing is not implemented yet (see #22)",
};

export type PrivacyLevelResult =
  | { ok: true; level: PrivacyLevel }
  | { ok: false; error: string };

/**
 * Resolve a user-supplied privacy level.
 *
 * Separated from both the CLI flag parser and the config loader so a level that
 * TNP cannot actually provide is rejected identically wherever it is named —
 * command line, interactive settings editor, or a stored config file.
 */
export function parsePrivacyLevel(value: string): PrivacyLevelResult {
  if (value === "access") return { ok: true, level: "access" };

  // `Object.hasOwn`, not a plain index: a bare lookup resolves inherited keys,
  // so "constructor" and "toString" would each report as a planned level.
  if (Object.hasOwn(PLANNED_PRIVACY_LEVELS, value)) {
    const planned = PLANNED_PRIVACY_LEVELS[value];
    return { ok: false, error: `privacy level "${value}" is unavailable: ${planned}` };
  }

  return {
    ok: false,
    error: `unknown privacy level "${value}". The only available level is "access".`,
  };
}

export interface TnpConfig extends DnsProxyConfig {
  privacyLevel: PrivacyLevel;
  socksPort: number;
  relayPreference: "oxy" | "community" | "any";
  identityKeyPath: string;
  relayPort: number;
  /**
   * Public `ws://`/`wss://` URL this machine's relay is reachable at, published
   * in the relay directory. Empty until the operator sets it; `tnp relay`
   * refuses to register without it rather than publishing a guess derived from
   * a bind address.
   */
  relayEndpoint: string;
  relayLocation: string;
  relayMaxConnections: number;
  /** Advertised bandwidth ceiling in Mbit/s. 0 means the operator states none. */
  relayBandwidth: number;
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
  cacheMaxEntries: 10_000,
  privacyLevel: "access",
  socksPort: 1080,
  relayPreference: "oxy",
  identityKeyPath: join(dataDir(), "identity.key"),
  relayPort: 8080,
  relayEndpoint: "",
  relayLocation: "",
  relayMaxConnections: 100,
  relayBandwidth: 0,
  relayAuthToken: "",
  autoConnect: false,
  killSwitch: false,
  publicDnsIp: TNP_PUBLIC_DNS,
};

/**
 * Merge a stored config over the defaults.
 *
 * Split out from `loadConfig` so the merge — including the privacy-level
 * normalization below — is testable without touching the filesystem.
 *
 * A stored `privacyLevel` is re-validated rather than trusted: a config written
 * by an earlier build can name a level that never worked. Falling back silently
 * would put the caller back in the situation this normalization exists to end,
 * so the downgrade is announced.
 */
export function applyStoredConfig(saved: Partial<TnpConfig>): TnpConfig {
  const merged = { ...DEFAULT_CONFIG, ...saved };

  const privacy = parsePrivacyLevel(String(merged.privacyLevel));
  if (!privacy.ok) {
    console.warn(
      `[tnp] stored ${privacy.error} Falling back to "${DEFAULT_CONFIG.privacyLevel}".`,
    );
    merged.privacyLevel = DEFAULT_CONFIG.privacyLevel;
  }

  return merged;
}

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
  return applyStoredConfig(saved);
}

export function saveConfig(cfg: TnpConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

/** Regex to validate network interface names, preventing command injection. */
export const VALID_IFACE_RE = /^[a-zA-Z0-9_.-]+$/;

/**
 * Parse `ip route show default` to get the active network interface name.
 * Returns the validated interface name, or null if detection fails.
 */
export function getDefaultInterface(): string | null {
  try {
    const { execSync } = require("child_process");
    const route = execSync("ip route show default", {
      encoding: "utf-8",
      stdio: "pipe",
    }).trim();
    const iface = route.split(/\s+/)[4];
    if (!iface || !VALID_IFACE_RE.test(iface)) {
      return null;
    }
    return iface;
  } catch (err) {
    console.warn(`[tnp] failed to detect default network interface: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
