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

// ---------------------------------------------------------------------------
// Exempt sources
// ---------------------------------------------------------------------------

interface Prefix {
  v6: boolean;
  network: bigint;
  bits: number;
}

/** An address as an integer: 32 bits for IPv4, 128 for IPv6. Null if not an address. */
function addressValue(address: string): { v6: boolean; value: bigint } | null {
  if (net.isIPv4(address)) {
    const value = address
      .split('.')
      .reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
    return { v6: false, value };
  }
  if (!net.isIPv6(address)) return null;
  let text = address.toLowerCase();
  let tail: bigint | null = null;
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const v4 = addressValue(dotted[2]);
    if (!v4) return null;
    tail = v4.value;
    text = `${dotted[1]}0:0`;
  }
  const groups = expandIPv6(text);
  if (groups.length !== 8) return null;
  let value = groups.reduce((acc, group) => (acc << 16n) | BigInt(Number.parseInt(group, 16)), 0n);
  if (tail !== null) value = (value & ~0xffffffffn) | tail;
  return { v6: true, value };
}

export type SourceListResult =
  | { ok: true; prefixes: readonly Prefix[] }
  | { ok: false; invalid: string[] };

/**
 * Parse a list of IP addresses and CIDR prefixes, strictly: every entry must
 * be an address, or an address with a prefix length in range whose host bits
 * are all zero (`10.0.0.5/24` is refused — it is ambiguous whether the
 * operator meant the host or the network). Any invalid entry fails the whole
 * list, and the result names every invalid entry.
 */
export function parseSourceList(value: string | undefined): SourceListResult {
  const entries = (value ?? '')
    .split(/[\s,]+/)
    .map((e) => e.trim())
    .filter((e) => e !== '');
  const prefixes: Prefix[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    const slash = entry.indexOf('/');
    const addressText = slash === -1 ? entry : entry.slice(0, slash);
    const lengthText = slash === -1 ? null : entry.slice(slash + 1);
    const address = addressValue(addressText);
    if (!address || addressText.includes('%')) {
      invalid.push(entry);
      continue;
    }
    const width = address.v6 ? 128 : 32;
    let bits = width;
    if (lengthText !== null) {
      if (!/^(0|[1-9][0-9]{0,2})$/.test(lengthText) || Number(lengthText) > width) {
        invalid.push(entry);
        continue;
      }
      bits = Number(lengthText);
    }
    const hostMask = (1n << BigInt(width - bits)) - 1n;
    if ((address.value & hostMask) !== 0n) {
      invalid.push(entry);
      continue;
    }
    prefixes.push({ v6: address.v6, network: address.value, bits });
  }
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, prefixes };
}

/** A set of addresses and prefixes a source can be tested against. */
export class SourceSet {
  private readonly prefixes: readonly Prefix[];

  /** Throws on any invalid entry: callers validate first with `parseSourceList`. */
  constructor(entries: readonly string[] = []) {
    const parsed = parseSourceList(entries.join(','));
    if (!parsed.ok) throw new Error(`invalid source entries: ${parsed.invalid.join(', ')}`);
    this.prefixes = parsed.prefixes;
  }

  get size(): number {
    return this.prefixes.length;
  }

  /** Whether `address` falls in the set. IPv4-mapped IPv6 sources match IPv4 entries. */
  has(address: string): boolean {
    if (this.prefixes.length === 0) return false;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    const value = addressValue(mapped ? mapped[1] : address);
    if (!value) return false;
    const width = value.v6 ? 128 : 32;
    return this.prefixes.some((p) => {
      if (p.v6 !== value.v6) return false;
      const shift = BigInt(width - p.bits);
      return value.value >> shift === p.network >> shift;
    });
  }
}

/**
 * Whether a UDP query from `source` may be answered normally under the
 * per-source limit. Loopback and exempt sources are never limited and spend
 * no token. This decides only the per-source limit: the global in-flight and
 * connection caps apply to every source, exempt or not.
 */
export function admitUdpSource(
  source: string,
  limiter: SourceRateLimiter | null,
  exempt: SourceSet,
): boolean {
  if (!limiter || isLoopback(source) || exempt.has(source)) return true;
  return limiter.allow(source);
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
