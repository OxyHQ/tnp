/**
 * The API's rate-limit policy: which requests are metered, how hard, and by
 * what key.
 *
 * Two layers, in this order in `index.ts`:
 *
 * 1. `perAddress`, before authentication: every route except `/health` is
 *    metered by client address (`clientIp.ts`). It runs before the optional
 *    Oxy auth on purpose — validating a bearer token is itself a call out, so
 *    it must not be free to repeat.
 * 2. `perUser`, after authentication, on writes only: an account that rotates
 *    addresses still has one budget.
 *
 * Request classes, by cost and by how a legitimate client behaves:
 *
 * - `resolve` — `/dns/resolve`: unauthenticated, 3-4 queries when not cached,
 *   and called by resolvers in bursts. Generous, because TNP's own DNS server
 *   calls it for every query it answers (exempt it with
 *   `TNP_RATE_LIMIT_EXEMPT`).
 * - `read` — other GETs.
 * - `heartbeat` — service nodes and relays check in every 30 seconds each, and
 *   one account may run many.
 * - `register` — creating names, TLD proposals, relays, service nodes and VPN devices: rare
 *   for a person, the thing a squatter or spammer does in bulk.
 * - `write` — everything else that changes state.
 *
 * TNP's own WireGuard exits (`TNP_VPN_EXIT_ADDRESSES`) put every VPN user
 * behind one address, so that address is never treated as one client — and
 * never exempt either:
 *
 * - A request from an exit address that carries a bearer token, to a route
 *   behind Oxy auth, is metered AFTER auth, against its account, with the
 *   ordinary per-address tiers: each VPN user gets what one address would.
 *   Before auth it spends only from a per-exit token-validation budget, which
 *   bounds the call-outs a flood of made-up tokens can cause; once that is
 *   spent, such requests are charged to the shared tier instead. If auth
 *   fails, it is charged to the exit's shared tier like any anonymous request.
 * - Every other request from an exit address spends from the exit's shared
 *   tier: twenty addresses' worth, for all its anonymous users together.
 *   That includes the exit's own resolver's `/dns/resolve` calls (native
 *   names only; exit-nodes.md §9.7), for which the shared `resolve` tier is
 *   ample. Exempting them would exempt every peer behind the exit too.
 */

import type { Request, RequestHandler } from 'express';
import { getOxyUserId } from '@oxy.so/core/server';
import {
  addressIn,
  addressKey,
  buildAddressSet,
  clientAddress,
  CLOUDFLARE_IP_RANGES,
} from './clientIp.js';
import { rateLimit, spend, TokenBucketLimiter, type RateLimitRule } from './rateLimit.js';

export type RequestClass = 'resolve' | 'read' | 'heartbeat' | 'register' | 'write';

interface Tier {
  capacity: number;
  refillPerSecond: number;
}

/** Per client address. */
export const ADDRESS_TIERS: Readonly<Record<RequestClass, Tier>> = {
  resolve: { capacity: 300, refillPerSecond: 50 },
  read: { capacity: 240, refillPerSecond: 10 },
  heartbeat: { capacity: 600, refillPerSecond: 20 },
  register: { capacity: 60, refillPerSecond: 1 },
  write: { capacity: 60, refillPerSecond: 1 },
};

/** How many addresses' worth an exit's anonymous users share. */
export const EXIT_SHARED_MULTIPLIER = 20;

function exitSharedTiers(
  tiers: Readonly<Record<RequestClass, Tier>>,
): Readonly<Record<RequestClass, Tier>> {
  return Object.fromEntries(
    Object.entries(tiers).map(([name, tier]) => [
      name,
      {
        capacity: tier.capacity * EXIT_SHARED_MULTIPLIER,
        refillPerSecond: tier.refillPerSecond * EXIT_SHARED_MULTIPLIER,
      },
    ]),
  ) as Record<RequestClass, Tier>;
}

/** Per WireGuard exit address, for its anonymous users together. */
export const EXIT_SHARED_TIERS = exitSharedTiers(ADDRESS_TIERS);

/** Per exit address: requests with a not-yet-validated bearer token. */
export const EXIT_AUTH_ATTEMPT_TIER: Tier = { capacity: 2000, refillPerSecond: 100 };

/**
 * The prefixes `app.ts` mounts behind the optional Oxy auth and `perUser`.
 * Only these may defer an exit request's metering until after auth: a public
 * route has no later stage to meter it in. `app.test.ts` checks the list.
 */
export const AUTHENTICATED_PREFIXES: readonly string[] = [
  '/tlds',
  '/domains',
  '/domain-keys',
  '/nodes',
  '/relays',
  '/me',
  '/services',
];

function isAuthenticatedPath(path: string): boolean {
  return AUTHENTICATED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

function hasBearer(req: Request): boolean {
  return /^Bearer \S+$/i.test(req.get('authorization') ?? '');
}

/** Per authenticated Oxy account, writes only. */
export const USER_TIERS: Readonly<Partial<Record<RequestClass, Tier>>> = {
  heartbeat: { capacity: 300, refillPerSecond: 5 },
  // Ten at once, then one a minute.
  register: { capacity: 10, refillPerSecond: 1 / 60 },
  write: { capacity: 60, refillPerSecond: 0.5 },
};

const REGISTER_PATHS = new Set([
  '/domains/register',
  '/tlds/propose',
  '/nodes/register',
  '/relays/register',
  '/me/vpn/devices',
]);
const HEARTBEAT_PATHS = new Set(['/nodes/heartbeat', '/relays/heartbeat']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Which class a request falls in, or null for one that is never metered. */
export function classifyRequest(method: string, path: string): RequestClass | null {
  if (path === '/health' || path.startsWith('/health/')) return null;
  if (path === '/dns/resolve') return 'resolve';
  if (READ_METHODS.has(method)) return 'read';
  if (REGISTER_PATHS.has(path)) return 'register';
  if (HEARTBEAT_PATHS.has(path)) return 'heartbeat';
  return 'write';
}

/** The full path whether the middleware is mounted on the app or under a prefix. */
const fullPath = (req: Request) => `${req.baseUrl}${req.path}`;

export interface NetworkLimitSettings {
  /** See `clientIp.ts`. */
  trustProxyHops: number;
  trustCloudflareHeader: boolean;
  /** Empty means the built-in `CLOUDFLARE_IP_RANGES`. */
  cloudflareIpRanges: readonly string[];
  /** Addresses or CIDRs exempt from the per-address limits. */
  exempt: readonly string[];
  /** TNP's WireGuard exit addresses (`TNP_VPN_EXIT_ADDRESSES`). Never exempt; see above. */
  vpnExitAddresses?: readonly string[];
  exitAuthAttemptTier?: Tier;
  /** Buckets held per limiter. */
  maxKeys?: number;
  addressTiers?: Readonly<Record<RequestClass, Tier>>;
  userTiers?: Readonly<Partial<Record<RequestClass, Tier>>>;
  now?: () => number;
}

export interface NetworkLimits {
  perAddress: RequestHandler;
  perUser: RequestHandler;
  /** Entries in the settings that did not parse, to be reported at startup. */
  invalidEntries: string[];
}

function rules(
  tiers: Readonly<Partial<Record<RequestClass, Tier>>>,
  scope: string,
  maxKeys: number,
  now: (() => number) | undefined,
): Partial<Record<RequestClass, RateLimitRule>> {
  const built: Partial<Record<RequestClass, RateLimitRule>> = {};
  for (const [name, tier] of Object.entries(tiers) as [RequestClass, Tier][]) {
    built[name] = {
      name: `${scope}:${name}`,
      limiter: new TokenBucketLimiter({ ...tier, maxKeys, now }),
    };
  }
  return built;
}

export function createNetworkLimits(settings: NetworkLimitSettings): NetworkLimits {
  const maxKeys = settings.maxKeys ?? 20_000;
  const cloudflare = buildAddressSet(
    settings.cloudflareIpRanges.length > 0 ? settings.cloudflareIpRanges : CLOUDFLARE_IP_RANGES,
  );
  const exempt = buildAddressSet(settings.exempt);
  const exits = buildAddressSet(settings.vpnExitAddresses ?? []);
  const exitSharedRules = rules(
    exitSharedTiers(settings.addressTiers ?? ADDRESS_TIERS),
    'vpn-exit',
    maxKeys,
    settings.now,
  );
  const exitAuthRule: RateLimitRule = {
    name: 'vpn-exit:auth',
    limiter: new TokenBucketLimiter({
      ...(settings.exitAuthAttemptTier ?? EXIT_AUTH_ATTEMPT_TIER),
      maxKeys,
      now: settings.now,
    }),
  };
  /** Exit requests whose metering waits for auth, by request object. */
  const deferred = new WeakSet<Request>();
  const addressRules = rules(
    settings.addressTiers ?? ADDRESS_TIERS,
    'address',
    maxKeys,
    settings.now,
  );
  const userRules = rules(settings.userTiers ?? USER_TIERS, 'account', maxKeys, settings.now);
  const ipSettings = {
    trustProxyHops: settings.trustProxyHops,
    trustCloudflareHeader: settings.trustCloudflareHeader,
    cloudflare: cloudflare.set,
  };

  const perAddress: RequestHandler = (req, res, next) => {
    const path = fullPath(req);
    const kind = classifyRequest(req.method, path);
    if (!kind) return next();
    const address = clientAddress(req, ipSettings);
    if (address === '' || addressIn(exempt.set, address)) return next();
    if (addressIn(exits.set, address)) {
      // With validation budget left, defer to per-account metering after
      // auth. Without it, fall through to the shared tier rather than refuse:
      // a flood of made-up tokens then costs the exit's anonymous budget, not
      // its signed-in users their access.
      if (
        hasBearer(req) &&
        isAuthenticatedPath(path) &&
        exitAuthRule.limiter.take(addressKey(address)).ok
      ) {
        deferred.add(req);
        return next();
      }
      const rule = exitSharedRules[kind];
      if (rule && !spend(rule, addressKey(address), res)) return;
      return next();
    }
    const rule = addressRules[kind];
    if (rule && !spend(rule, addressKey(address), res)) return;
    next();
  };

  const perUserLimit = rateLimit(
    (req) => {
      const kind = classifyRequest(req.method, fullPath(req));
      return kind ? (userRules[kind] ?? null) : null;
    },
    (req) => getOxyUserId(req) ?? null,
  );

  const perUser: RequestHandler = (req, res, next) => {
    if (deferred.has(req)) {
      deferred.delete(req);
      const kind = classifyRequest(req.method, fullPath(req));
      if (kind) {
        const user = getOxyUserId(req);
        const rule = user ? addressRules[kind] : exitSharedRules[kind];
        const key = user ? `vpn-user:${user}` : addressKey(clientAddress(req, ipSettings));
        if (rule && !spend(rule, key, res)) return;
      }
    }
    perUserLimit(req, res, next);
  };

  return {
    perAddress,
    perUser,
    invalidEntries: [...cloudflare.invalid, ...exempt.invalid, ...exits.invalid],
  };
}
