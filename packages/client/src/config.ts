import { chmodSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { restrictWindowsAcl, writeFileAtomic } from './secure-fs';

/**
 * True for a bare IPv4 or IPv6 literal and nothing else.
 *
 * Addresses from config and the environment end up in firewall rules and
 * system commands, so this is the gate that keeps them from carrying anything
 * else: zone IDs (`fe80::1%eth0`) and CIDR suffixes are refused too.
 */
export function isIpLiteral(value: string): boolean {
  return value.length > 0 && !value.includes('%') && isIP(value) !== 0;
}

function envPublicDns(): string {
  const raw = process.env.TNP_PUBLIC_DNS?.trim() ?? '';
  if (raw === '' || isIpLiteral(raw)) return raw;
  console.warn(`[tnp] ignoring TNP_PUBLIC_DNS="${raw}": not an IP address`);
  return '';
}

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
export const TNP_PUBLIC_DNS = envPublicDns();

/**
 * Where releases up to 0.2.0 recorded an active kill switch: a world-writable
 * temporary directory (audit S10). Only ever deleted now, never written — its
 * presence still means an older client may have left rules behind.
 */
export const LEGACY_KILLSWITCH_MARKER_PATH = join(tmpdir(), 'tnp-killswitch-active');

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

/**
 * Machine-wide state that only root/Administrators may write: the kill-switch
 * record, and on Linux the identity key.
 *
 * Never a temporary directory and never a directory the resolver daemon's
 * unprivileged service user owns, because root writes here: a directory another
 * principal controls is a directory where a planted symlink redirects root's
 * write.
 */
export function systemStateDir(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'darwin':
      return '/Library/Application Support/tnp';
    case 'win32':
      return join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'tnp');
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

  // These two reach firewall rules and system commands. Anything that is not a
  // plain IP literal is refused here, once, so no later caller has to trust it.
  if (!isIpLiteral(String(merged.listenAddr))) {
    console.warn(
      `[tnp] stored listenAddr "${String(merged.listenAddr)}" is not an IP address. Falling back to "${DEFAULT_CONFIG.listenAddr}".`,
    );
    merged.listenAddr = DEFAULT_CONFIG.listenAddr;
  }
  if (merged.publicDnsIp !== '' && !isIpLiteral(String(merged.publicDnsIp))) {
    console.warn(
      `[tnp] stored publicDnsIp "${String(merged.publicDnsIp)}" is not an IP address. Ignoring it.`,
    );
    merged.publicDnsIp = DEFAULT_CONFIG.publicDnsIp;
  }

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

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(
        `cannot read ${path}: permission denied. It can hold auth tokens, so only root/Administrators may read it; rerun with sudo or as Administrator.`,
      );
    }
    throw err;
  }
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

/**
 * The resolver daemon's own config: only what `tnp run` consumes, and no
 * secret. On Linux the sandboxed daemon (user `tnp`) reads this through its
 * group; it never gets read access to `config.json`, which can hold the relay
 * auth token.
 */
export function resolverConfigPath(): string {
  return join(configDir(), 'resolver.json');
}

/** The secret-free subset of a config the resolver needs. */
export function resolverSubset(cfg: DnsProxyConfig): DnsProxyConfig {
  return {
    listenAddr: cfg.listenAddr,
    listenPort: cfg.listenPort,
    apiBaseUrl: cfg.apiBaseUrl,
    upstreamDns: cfg.upstreamDns,
    ...(cfg.cacheMaxEntries === undefined ? {} : { cacheMaxEntries: cfg.cacheMaxEntries }),
    ...(cfg.rateLimit === undefined ? {} : { rateLimit: cfg.rateLimit }),
    ...(cfg.maxTcpConnections === undefined ? {} : { maxTcpConnections: cfg.maxTcpConnections }),
    ...(cfg.maxInflight === undefined ? {} : { maxInflight: cfg.maxInflight }),
  };
}

/**
 * The Linux resolver service's own writable state: systemd creates it from the
 * unit's `StateDirectory=tnp-resolver`, owned by the `tnp` user. Separate from
 * root's `/var/lib/tnp`, so a compromised daemon can neither plant files where
 * root writes nor poison the TLD cache root's `tnp connect` reads.
 */
export const RESOLVER_STATE_DIR = '/var/lib/tnp-resolver';
export const RESOLVER_TLD_CACHE = join(RESOLVER_STATE_DIR, 'tlds.json');

/**
 * Config for `tnp run`: `config.json` when this process can read it (root),
 * otherwise the group-readable `resolver.json` the sandboxed daemon is given.
 */
export function loadResolverConfig(): DnsProxyConfig {
  try {
    return loadConfig();
  } catch (err) {
    if (!existsSync(resolverConfigPath())) throw err;
    try {
      const saved = JSON.parse(readFileSync(resolverConfigPath(), 'utf-8')) as Partial<TnpConfig>;
      // The sandboxed daemon keeps its TLD cache in its own systemd
      // StateDirectory, never in root's /var/lib/tnp; the path is fixed here
      // rather than read from the file.
      return { ...resolverSubset(applyStoredConfig(saved)), tldCachePath: RESOLVER_TLD_CACHE };
    } catch {
      throw err;
    }
  }
}

/**
 * Write the config so only root/Administrators can read it.
 *
 * It can hold the relay auth token, so the mode is enforced on every save, not
 * only when the file is first created — `writeFileSync`'s `mode` is ignored for
 * a file that already exists, which is how a config written by an older build
 * stayed at whatever the umask gave it.
 *
 * On Linux `tnp install` makes `/etc/tnp` root:tnp 0750. In a config dir root
 * owns with a non-root group, the secret-free `resolver.json` is also written,
 * root:<group> 0640, for the sandboxed resolver; `config.json` stays 0600. On
 * Windows the directory ACL is reset to SYSTEM and Administrators, because
 * `%ProgramData%` children otherwise inherit Users:Read.
 */
export function saveConfig(cfg: TnpConfig): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(cfg, null, 2)}\n`;

  if (process.platform === 'win32') {
    restrictWindowsAcl(dir, 'admin-only');
    writeFileAtomic(configPath(), body);
    return;
  }

  const st = statSync(dir);
  if ((st.mode & 0o007) !== 0) chmodSync(dir, st.mode & 0o770);
  writeFileAtomic(configPath(), body, { mode: 0o600 });

  // Linux only: on macOS a new directory inherits its parent's group (often
  // `admin`), so a non-root group there says nothing about who should read.
  const serviceGroup =
    process.platform === 'linux' && st.uid === 0 && st.gid !== 0 && process.geteuid?.() === 0
      ? st.gid
      : undefined;
  if (serviceGroup !== undefined) {
    writeFileAtomic(resolverConfigPath(), `${JSON.stringify(resolverSubset(cfg), null, 2)}\n`, {
      mode: 0o640,
      gid: serviceGroup,
    });
  }
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
