/**
 * In-memory token-bucket rate limiting.
 *
 * Per process, like the services layer's per-user budget, and for the same
 * reason: what it protects is this task's 10-connection database pool, which
 * is per process too. Nothing here is shared between tasks, so the effective
 * limit across the fleet is the per-task limit times the number of tasks —
 * acceptable for a guard whose job is keeping one client from starving the
 * pool, not metering anyone.
 *
 * Memory is bounded: each limiter holds at most `maxKeys` buckets and evicts
 * the least recently used. Eviction can only ever hand a key a full bucket
 * early — under a flood of distinct keys the limiter gets more lenient, never
 * stricter, and never grows without bound.
 *
 * The buckets hold only a key (an address, a /64 or an Oxy user id), a token
 * count and a timestamp, are never written anywhere, and age out by
 * eviction — this is not a log of who called what.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface TokenBucketOptions {
  /** Burst size: how many requests a fresh key may make at once. */
  readonly capacity: number;
  /** Sustained rate: tokens added per second. */
  readonly refillPerSecond: number;
  /** Most keys held at once; the least recently used is evicted beyond it. */
  readonly maxKeys: number;
  readonly now?: () => number;
}

export type TakeResult = { ok: true } | { ok: false; retryAfterSeconds: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(private readonly options: TokenBucketOptions) {
    if (options.capacity < 1 || options.refillPerSecond <= 0 || options.maxKeys < 1) {
      throw new Error('a token bucket needs capacity >= 1, refill > 0 and maxKeys >= 1');
    }
    this.now = options.now ?? Date.now;
  }

  /** Spend one token for `key`, or say how long until one is available. */
  take(key: string): TakeResult {
    const { capacity, refillPerSecond, maxKeys } = this.options;
    const now = this.now();
    const existing = this.buckets.get(key);

    let tokens = capacity;
    if (existing) {
      const elapsedSeconds = Math.max(0, now - existing.updatedAt) / 1000;
      tokens = Math.min(capacity, existing.tokens + elapsedSeconds * refillPerSecond);
      // Re-inserted below, which moves it to the most-recently-used end.
      this.buckets.delete(key);
    }

    const allowed = tokens >= 1;
    this.buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, updatedAt: now });

    while (this.buckets.size > maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }

    if (allowed) return { ok: true };
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / refillPerSecond)) };
  }

  get size(): number {
    return this.buckets.size;
  }
}

export interface RateLimitRule {
  /** Short label, for the response body. */
  readonly name: string;
  readonly limiter: TokenBucketLimiter;
}

/**
 * A middleware that spends a token from the rule `select` picks for this
 * request, keyed by `key`. Either returning null lets the request through
 * unmetered — no rule applies, or there is nothing to key it on.
 */
export function rateLimit(
  select: (req: Request) => RateLimitRule | null,
  key: (req: Request) => string | null,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const rule = select(req);
    if (!rule) return next();
    const k = key(req);
    if (k === null) return next();

    const result = rule.limiter.take(k);
    if (result.ok) return next();

    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    res.status(429).json({
      error: 'rate_limited',
      limit: rule.name,
      message: 'Too many requests. Try again later.',
      retryAfter: result.retryAfterSeconds,
    });
  };
}
