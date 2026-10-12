import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

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
export const TNP_PUBLIC_DNS = process.env.TNP_PUBLIC_DNS?.trim() ?? '';

/** Path to the kill switch marker file. Presence means firewall rules are active. */
export const KILLSWITCH_MARKER_PATH = join(tmpdir(), 'tnp-killswitch-active');

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
   * order. An entry is an RFC 8484 DoH URL (`https://1.1.1.1/dns-query`) or a
   * plaintext address (`1.1.1.1:53`, `[2606:4700::1111]`). See
   * `DEFAULT_UPSTREAM_DNS`.
   */
  upstreamDns: string;
  /**
   * Where the last TLD policy table fetched from the registry is kept, so a
   * restart without network still classifies every native TLD it has seen.
   * Unset means "do not persist" (tests). Built-in native TLDs never depend on
   * this file.
   */
  tldCachePath?: string;
  /**
   * Per-source response rate limit for the UDP listener. Loopback sources are
   * exempt. `null` disables it; unset uses the default.
   */
  rateLimit?: { perSecond: number; burst: number } | null;
  /** Concurrent TCP client connections. Further connections are closed at once. */
  maxTcpConnections?: number;
  /**
   * Queries being resolved at once (upstream or registry). A query beyond the
   * limit gets SERVFAIL immediately instead of opening yet another socket.
   */
  maxInflight?: number;
}

/**
 * Default upstream resolvers for public names: DNS-over-HTTPS, two operators.
 *
 * Encrypted because the plaintext default this replaces (`1.1.1.1` over UDP)
 * handed every public name the device looked up to anyone on the path, who
 * could also answer in Cloudflare's place. Addressed by IP literal, not
 * hostname, so reaching the upstream needs no plaintext bootstrap lookup and
 * sends no SNI naming it, and so the resolver can never loop through itself.
 * Both certificates carry the IP as a subject alternative name.
 *
 * Cloudflare first, Google as a different-operator fallback. Quad9 was the
 * natural second choice but its DoH endpoint requires HTTP/2 and answers
 * Bun's HTTP/1.1 `fetch` with 505, so it cannot work here today.
 */
export const DEFAULT_UPSTREAM_DNS = 'https://1.1.1.1/dns-query,https://8.8.8.8/dns-query';

/**
 * The upstream value earlier releases wrote into every saved config.
 *
 * `saveConfig` writes the whole object, so a config file holding exactly this
 * string almost always means "never chosen" rather than "chose plaintext". It
 * is migrated to the encrypted default; a user who really wants plaintext
 * Cloudflare can say so unambiguously with `1.1.1.1:53`.
 */
export const LEGACY_DEFAULT_UPSTREAM_DNS = '1.1.1.1';

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
export type PrivacyLevel = 'access';

/** Levels that are specified but not implemented, with the issue that lands each. */
const PLANNED_PRIVACY_LEVELS: Record<string, string> = {
  private: 'multi-hop onion routing is not implemented yet (see #22)',
};

export type PrivacyLevelResult = { ok: true; level: PrivacyLevel } | { ok: false; error: string };

/**
 * Resolve a user-supplied privacy level.
 *
 * Separated from both the CLI flag parser and the config loader so a level that
 * TNP cannot actually provide is rejected identically wherever it is named —
 * command line, interactive settings editor, or a stored config file.
 */
export function parsePrivacyLevel(value: string): PrivacyLevelResult {
  if (value === 'access') return { ok: true, level: 'access' };

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
  /**
   * Stored and shown, but no longer consulted when `tnp serve` picks a relay
   * on its own: only an Oxy-operated relay is ever chosen automatically, and a
   * community relay must be named with `--relay` (relay-select.ts).
   */
  relayPreference: 'oxy' | 'community' | 'any';
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
    case 'darwin':
      return '/usr/local/etc/tnp';
    case 'win32':
      return join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'tnp');
    default:
      return '/etc/tnp';
  }
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

export function dataDir(): string {
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'tnp');
    case 'win32':
      return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'tnp');
    default:
      return '/var/lib/tnp';
  }
}

export function logPath(): string {
  switch (process.platform) {
    case 'win32':
      return join(dataDir(), 'tnp-resolver.log');
    default:
      return '/var/log/tnp-resolver.log';
  }
}

const DEFAULT_CONFIG: TnpConfig = {
  listenAddr: '127.0.0.1',
  listenPort: 5354,
  apiBaseUrl: 'https://api.tnp.network',
  upstreamDns: DEFAULT_UPSTREAM_DNS,
  cacheMaxEntries: 10_000,
  tldCachePath: join(dataDir(), 'tlds.json'),
  privacyLevel: 'access',
  socksPort: 1080,
  relayPreference: 'oxy',
  identityKeyPath: join(dataDir(), 'identity.key'),
  relayPort: 8080,
  relayEndpoint: '',
  relayLocation: '',
  relayMaxConnections: 100,
  relayBandwidth: 0,
  relayAuthToken: '',
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
    console.warn(`[tnp] stored ${privacy.error} Falling back to "${DEFAULT_CONFIG.privacyLevel}".`);
    merged.privacyLevel = DEFAULT_CONFIG.privacyLevel;
  }

  if (typeof merged.upstreamDns !== 'string' || merged.upstreamDns.trim() === '') {
    merged.upstreamDns = DEFAULT_CONFIG.upstreamDns;
  } else if (merged.upstreamDns.trim() === LEGACY_DEFAULT_UPSTREAM_DNS) {
    console.warn(
      `[tnp] upstream DNS was the old plaintext default (${LEGACY_DEFAULT_UPSTREAM_DNS}); ` +
        `now using encrypted DNS-over-HTTPS (${DEFAULT_UPSTREAM_DNS}). ` +
        `Set upstreamDns to "${LEGACY_DEFAULT_UPSTREAM_DNS}:53" to keep plaintext on purpose.`,
    );
    merged.upstreamDns = DEFAULT_CONFIG.upstreamDns;
  }

  return merged;
}

export function loadConfig(): TnpConfig {
  const path = configPath();
  if (!existsSync(path)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = readFileSync(path, 'utf-8');
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
  writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
}

/** Regex to validate network interface names, preventing command injection. */
export const VALID_IFACE_RE = /^[a-zA-Z0-9_.-]+$/;

/**
 * Parse `ip route show default` to get the active network interface name.
 * Returns the validated interface name, or null if detection fails.
 */
export function getDefaultInterface(): string | null {
  try {
    const { execSync } = require('node:child_process');
    const route = execSync('ip route show default', {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    const iface = route.split(/\s+/)[4];
    if (!iface || !VALID_IFACE_RE.test(iface)) {
      return null;
    }
    return iface;
  } catch (err) {
    console.warn(
      `[tnp] failed to detect default network interface: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
