// `.env` is loaded by Bun itself (every entry point runs on Bun) before any
// module runs; a variable the shell already set wins.

// Public DNS / parking IP for TNP domains. MUST be provided via TNP_PARKING_IP.
// This is the address clients are pointed at and the A record we hand out for
// parked/custom TLDs — i.e. a security-critical value for a DNS product. There
// is intentionally NO hardcoded fallback: a stale literal (e.g. a retired host)
// would silently route every TNP query to a dead-or-attacker-controlled IP.
// When unset, parking answers are simply omitted (see routes/dns.ts) rather
// than pointing traffic at a wrong host.
//
// DEPLOY REQUIREMENT: set TNP_PARKING_IP to the AWS NLB Elastic IP once the
// dns-server NLB is provisioned (oxy-infra app-tnp.tf is pending).
const parkingIp = process.env.TNP_PARKING_IP?.trim() ?? '';
if (!parkingIp) {
  console.warn(
    '[tnp-api] TNP_PARKING_IP is not set — parking/custom-TLD A records will be omitted. ' +
      'Set it to the TNP public DNS NLB Elastic IP before serving production traffic.',
  );
}

/**
 * Whether expired native names stop being served (docs/architecture/naming.md
 * §4). Off unless set to exactly `true`: turning it on retroactively applies
 * expiry to registrations whose owners were never told their names expire,
 * which issue #62 forbids without an approved communication first. With it off
 * the policy is still computed, shown to owners and renewable — only the
 * resolver and parking page ignore it.
 */
export function parseExpiryEnforced(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true';
}

/**
 * A comma- or whitespace-separated list from an env var, trimmed, empties dropped.
 */
export function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/** A non-negative integer env var, or `fallback` when unset or malformed. */
export function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value?.trim());
  return value?.trim() && Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** `true` or `false` (any case), or `fallback` for anything else, including unset. */
export function parseFlag(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

const production = process.env.NODE_ENV === 'production';

/**
 * Browser origins allowed to call the API with credentials. The local web dev
 * server is allowed only outside production: in production it would let any
 * page served from a visitor's own `localhost:8170` — anything they happen to
 * be running — make credentialed requests as them.
 */
export function corsOriginsFor(isProduction: boolean): string[] {
  const origins = ['https://tnp.network', 'https://www.tnp.network', 'https://tnp-9uk.pages.dev'];
  return isProduction ? origins : ['http://localhost:8170', ...origins];
}

export const config = {
  production,
  // Local dev default only — ECS injects PORT explicitly (oxy-infra
  // terraform-uswest2/app-tnp.tf sets it to 8080). 4170 is TNP's slot in the
  // per-app port map so several Oxy backends can run side by side.
  port: parseInt(process.env.PORT || '4170', 10),
  /**
   * PostgreSQL connection string. No default: a wrong database is worse than a
   * missing one, and every other Oxy backend fails fast on this too.
   */
  databaseUrl: process.env.DATABASE_URL ?? '',
  postgresMaxPoolSize: parseInt(process.env.POSTGRES_MAX_POOL_SIZE || '10', 10),
  /**
   * Server-side cap on any one statement. With a 10-connection pool, a few
   * slow queries are enough to queue every request behind them; this bounds
   * how long one can hold a connection. 0 disables it.
   */
  postgresStatementTimeoutMs: parseNonNegativeInt(process.env.POSTGRES_STATEMENT_TIMEOUT_MS, 5000),
  /**
   * How long a request may run before the API answers 503 on its behalf, so a
   * slow database turns into fast failures instead of a pile of open
   * connections. 0 disables it.
   */
  requestTimeoutMs: parseNonNegativeInt(process.env.TNP_REQUEST_TIMEOUT_MS, 10_000),
  oxyApiUrl: process.env.OXY_API_URL || 'https://api.oxy.so',
  parkingIp,
  nativeExpiryEnforced: parseExpiryEnforced(process.env.TNP_NATIVE_EXPIRY_ENFORCED),
  corsOrigins: corsOriginsFor(production),
  /**
   * Oxy user ids whose relays the directory publishes as `oxy`. Everyone else
   * is `community`, whatever their relay claims. Empty by default, so no relay
   * is Oxy-operated until an operator is named here (docs/architecture/relays.md).
   */
  oxyRelayOperators: new Set(parseList(process.env.TNP_OXY_RELAY_OPERATORS)) as ReadonlySet<string>,
  /**
   * Proxy hop count: how many proxies in front of the API
   * append to `X-Forwarded-For`. Production is Cloudflare → ALB → task and only
   * the ALB is trusted by default, because it is the only hop whose append
   * cannot be forged by a client that reaches it directly. See
   * `middleware/clientIp.ts`.
   */
  trustProxyHops: parseNonNegativeInt(process.env.TNP_TRUST_PROXY_HOPS, production ? 1 : 0),
  /**
   * Take the client address from `CF-Connecting-IP` — but only on requests
   * whose peer (as `trustProxyHops` determines it) is a Cloudflare address, so
   * a client that reaches the ALB without Cloudflare cannot forge it.
   *
   * On by default in production: off, every client behind the same Cloudflare
   * edge address would share one rate-limit bucket, and a busy edge would
   * throttle strangers together. `false` turns it off.
   */
  trustCloudflareHeader: parseFlag(process.env.TNP_TRUST_CF_CONNECTING_IP, production),
  /** Overrides the built-in Cloudflare ranges (`middleware/clientIp.ts`) when set. */
  cloudflareIpRanges: parseList(process.env.TNP_CLOUDFLARE_IP_RANGES),
  /**
   * Client addresses or CIDRs the per-IP rate limits do not apply to — meant
   * for TNP's own public DNS server, which resolves every query it receives
   * through `/dns/resolve` from one address.
   */
  rateLimitExempt: parseList(process.env.TNP_RATE_LIMIT_EXEMPT),
};
