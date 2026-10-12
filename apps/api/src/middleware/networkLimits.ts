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
 * - `register` — creating names, TLD proposals, relays and service nodes: rare
 *   for a person, the thing a squatter or spammer does in bulk.
 * - `write` — everything else that changes state.
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
import { rateLimit, TokenBucketLimiter, type RateLimitRule } from './rateLimit.js';

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

  const perAddress = rateLimit(
    (req) => {
      const kind = classifyRequest(req.method, fullPath(req));
      return kind ? (addressRules[kind] ?? null) : null;
    },
    (req) => {
      const address = clientAddress(req, ipSettings);
      if (address === '' || addressIn(exempt.set, address)) return null;
      return addressKey(address);
    },
  );

  const perUser = rateLimit(
    (req) => {
      const kind = classifyRequest(req.method, fullPath(req));
      return kind ? (userRules[kind] ?? null) : null;
    },
    (req) => getOxyUserId(req) ?? null,
  );

  return {
    perAddress,
    perUser,
    invalidEntries: [...cloudflare.invalid, ...exempt.invalid],
  };
}
