/**
 * DNS answer cache.
 *
 * Replaces a `Map` that stamped every entry with one configured lifetime,
 * never cached a negative answer, and had no size bound (audit S9). Three
 * consequences, all of them real:
 *
 * - A record with a 60-second TTL was served for 300 seconds, and one with a
 *   86400-second TTL was re-fetched every 5 minutes. The publisher's TTL was
 *   simply discarded.
 * - Entries were handed out with their *original* TTL however long they had
 *   been held, so a downstream cache re-armed the full lifetime on every hop
 *   and a record could outlive its TTL indefinitely.
 * - Every lookup of a nonexistent name was a fresh round trip, which is the
 *   traffic pattern RFC 2308 negative caching exists to stop.
 */

/** TTL floor. Below this, caching costs more than it saves. */
const MIN_TTL_SECONDS = 1;

/** TTL ceiling, so a hostile or mistaken record cannot pin an entry for years. */
const MAX_TTL_SECONDS = 86_400;

/** Ceiling for negative answers, per RFC 2308 §5. */
const MAX_NEGATIVE_TTL_SECONDS = 3_600;

/** Applied when a negative answer carries no SOA to derive a TTL from. */
const DEFAULT_NEGATIVE_TTL_SECONDS = 60;

export interface CachedRecord {
  name: string;
  type: string;
  value: string;
  ttl: number;
}

export interface CacheEntry<T extends CachedRecord> {
  records: T[];
  /** True for a cached NXDOMAIN. Distinguishing the two is the point. */
  negative: boolean;
}

interface StoredEntry<T extends CachedRecord> {
  records: T[];
  negative: boolean;
  /** Monotonic ms, from the injected clock. */
  storedAt: number;
  expiresAt: number;
}

export interface DnsCacheOptions {
  /** Maximum entries retained. Oldest-inserted are evicted first. */
  maxEntries?: number;
  /** Injectable clock, so expiry is testable without sleeping. */
  now?: () => number;
}

export class DnsCache<T extends CachedRecord = CachedRecord> {
  private entries = new Map<string, StoredEntry<T>>();
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: DnsCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Read an entry, with every record's TTL reduced by the time it has been
   * held.
   *
   * Serving the original TTL is what lets a record outlive it: each downstream
   * cache re-arms the full lifetime, so a 300-second record chained through
   * three caches can live for 900 seconds or forever.
   */
  get(name: string, type: string): CacheEntry<T> | null {
    const key = cacheKey(name, type);
    const entry = this.entries.get(key);
    if (!entry) return null;

    const now = this.now();
    if (now >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }

    const elapsedSeconds = Math.floor((now - entry.storedAt) / 1000);
    return {
      negative: entry.negative,
      records: entry.records.map((record) => ({
        ...record,
        ttl: Math.max(MIN_TTL_SECONDS, record.ttl - elapsedSeconds),
      })),
    };
  }

  /**
   * Store a positive answer.
   *
   * The entry expires with its SHORTEST record: keeping a set past the earliest
   * expiry would serve a stale member of it.
   */
  set(name: string, type: string, records: T[]): void {
    if (records.length === 0) return;

    const ttl = clamp(
      Math.min(...records.map((record) => record.ttl)),
      MIN_TTL_SECONDS,
      MAX_TTL_SECONDS,
    );

    this.store(cacheKey(name, type), { records, negative: false }, ttl);
  }

  /**
   * Store a negative answer (RFC 2308).
   *
   * `soaMinimum` is the negative TTL from the authority section when present.
   */
  setNegative(name: string, type: string, soaMinimum?: number): void {
    const ttl = clamp(
      soaMinimum ?? DEFAULT_NEGATIVE_TTL_SECONDS,
      MIN_TTL_SECONDS,
      MAX_NEGATIVE_TTL_SECONDS,
    );

    this.store(cacheKey(name, type), { records: [], negative: true }, ttl);
  }

  /** Drop everything. Used when the TLD policy table changes under us. */
  clear(): void {
    this.entries.clear();
  }

  private store(key: string, entry: CacheEntry<T>, ttlSeconds: number): void {
    // Re-inserting moves the key to the end of the Map's iteration order, so
    // eviction below removes a genuinely old entry rather than a fresh one.
    this.entries.delete(key);

    const now = this.now();
    this.entries.set(key, {
      records: entry.records,
      negative: entry.negative,
      storedAt: now,
      expiresAt: now + ttlSeconds * 1000,
    });

    this.evictIfNeeded();
  }

  /**
   * Keep the cache bounded.
   *
   * Expired entries go first — they cost nothing to lose. Only if that is not
   * enough does the oldest live entry go, which is what stops an unbounded Map
   * from being a memory-exhaustion path for anyone who can send queries.
   */
  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxEntries) return;

    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) return;
      if (now >= entry.expiresAt) this.entries.delete(key);
    }

    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) return;
      this.entries.delete(key);
    }
  }
}

function cacheKey(name: string, type: string): string {
  return `${name.toLowerCase()}:${type.toUpperCase()}`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.floor(value), min), max);
}
