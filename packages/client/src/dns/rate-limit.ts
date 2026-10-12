/**
 * Per-source response rate limiting for the resolver's UDP listener.
 *
 * A resolver that answers anyone is an amplifier: a spoofed 40-byte query
 * makes it send a response of up to the UDP cap to the victim whose address
 * was forged. A token bucket per source caps what any one address (or IPv6
 * /64, since a single host can own billions of addresses in its prefix) can
 * make us send, and the table holding the buckets is bounded so a flood of
 * distinct spoofed sources cannot turn the limiter itself into a memory
 * exhaustion path.
 */

import net from 'node:net';

export interface RateLimitOptions {
  /** Sustained responses per second per source. */
  perSecond: number;
  /** Bucket size: how many back-to-back queries a source may burst. */
  burst: number;
  /** Most sources tracked at once. The least recently seen is dropped first. */
  maxEntries?: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class SourceRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perSecond: number;
  private readonly burst: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: RateLimitOptions) {
    if (!(options.perSecond > 0) || !(options.burst >= 1)) {
      throw new Error('rate limit needs perSecond > 0 and burst >= 1');
    }
    this.perSecond = options.perSecond;
    this.burst = options.burst;
    this.maxEntries = options.maxEntries ?? 50_000;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Spend one token for `source`. False means: do not answer normally. */
  allow(source: string): boolean {
    const key = rateLimitKey(source);
    const now = this.now();
    const existing = this.buckets.get(key);

    let bucket: Bucket;
    if (existing) {
      const elapsed = Math.max(0, now - existing.updatedAt) / 1000;
      bucket = {
        tokens: Math.min(this.burst, existing.tokens + elapsed * this.perSecond),
        updatedAt: now,
      };
      // Re-insert so Map order is least-recently-seen first.
      this.buckets.delete(key);
    } else {
      bucket = { tokens: this.burst, updatedAt: now };
      while (this.buckets.size >= this.maxEntries) {
        const oldest = this.buckets.keys().next().value;
        if (oldest === undefined) break;
        this.buckets.delete(oldest);
      }
    }

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return allowed;
  }
}

/**
 * The unit a source is limited as: an IPv4 address, or an IPv6 /64.
 * IPv4-mapped IPv6 addresses are folded to their IPv4 form.
 */
export function rateLimitKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1];
  if (!net.isIPv6(address)) return address;
  return `${expandIPv6(address).slice(0, 4).join(':')}::/64`;
}

/** Loopback sources are this device's own applications and are never limited. */
export function isLoopback(address: string): boolean {
  if (address === '::1') return true;
  const v4 = /^(?:::ffff:)?(\d+)\.\d+\.\d+\.\d+$/i.exec(address);
  return v4 !== null && v4[1] === '127';
}

function expandIPv6(address: string): string[] {
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = address.includes('::') ? 8 - left.length - right.length : 0;
  return [...left, ...Array<string>(Math.max(0, missing)).fill('0'), ...right].map((part) =>
    part.toLowerCase().padStart(4, '0'),
  );
}
