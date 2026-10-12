/**
 * A short-lived, size-capped cache of `/dns/resolve` answers.
 *
 * `/dns/resolve` is unauthenticated and costs three or four queries per call.
 * Repeating a name is the cheapest way to load the database, and resolvers
 * repeat names constantly, so identical questions are answered from memory for
 * a few seconds.
 *
 * - Positive answers live for the smallest record TTL, capped at
 *   `maxTtlSeconds`: never longer than the owner asked, never so long that an
 *   edit takes noticeably longer to appear than it already does through the
 *   client resolvers' own caches.
 * - NXDOMAIN, NODATA and synthesized parking answers live `negativeTtlSeconds`,
 *   so a name registered a moment ago starts resolving within seconds.
 * - Per process, with no invalidation on writes: the cap bounds how stale an
 *   answer can be, and keeping it short is what makes that acceptable.
 *
 * Everything cached here is a public answer anyone may ask for; no client
 * identity is stored with it.
 */

import type { DnsResolveResponse } from '@tnp/shared-types';

export interface ResolveCacheOptions {
  readonly maxEntries: number;
  readonly maxTtlSeconds: number;
  readonly negativeTtlSeconds: number;
  readonly now?: () => number;
}

interface Entry {
  response: DnsResolveResponse;
  storedAt: number;
  expiresAt: number;
}

/** Names longer than DNS allows, or query types that are not one, are never cached. */
const CACHEABLE_TYPE_RE = /^[A-Z0-9]{1,10}$/;
const MAX_NAME_LENGTH = 253;

export class ResolveCache {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(private readonly options: ResolveCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  private static key(name: string, qtype: string): string | null {
    if (name.length > MAX_NAME_LENGTH || !CACHEABLE_TYPE_RE.test(qtype)) return null;
    return `${qtype} ${name}`;
  }

  get(name: string, qtype: string): DnsResolveResponse | undefined {
    const key = ResolveCache.key(name, qtype);
    if (key === null) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    // Answer TTLs count down while cached, rounded so they never grow: a
    // resolver downstream must not keep a record longer than its owner asked
    // because it happened to be served from here.
    const elapsed = Math.ceil((now - entry.storedAt) / 1000);
    if (elapsed <= 0) return entry.response;
    return {
      ...entry.response,
      answers: entry.response.answers.map((answer) => ({
        ...answer,
        ttl: Math.max(0, answer.ttl - elapsed),
      })),
    };
  }

  /** Seconds `response` may be served from the cache; 0 means it is not cached. */
  ttlFor(response: DnsResolveResponse): number {
    const { maxTtlSeconds, negativeTtlSeconds } = this.options;
    if (response.rcode !== 'NOERROR' || response.answers.length === 0) {
      return Math.min(negativeTtlSeconds, maxTtlSeconds);
    }
    const smallest = Math.min(...response.answers.map((answer) => answer.ttl));
    return Math.max(0, Math.min(smallest, maxTtlSeconds));
  }

  /**
   * Cache `response`. `notAfter` (epoch ms) caps the entry further: an answer
   * that advertises a live service node must not outlive that node's
   * liveness, or it would keep routing clients to a node the registry now
   * counts as offline.
   */
  set(name: string, qtype: string, response: DnsResolveResponse, notAfter?: number): void {
    const key = ResolveCache.key(name, qtype);
    const ttl = this.ttlFor(response);
    if (key === null || ttl <= 0) return;

    const now = this.now();
    const expiresAt = Math.min(now + ttl * 1000, notAfter ?? Number.POSITIVE_INFINITY);
    if (expiresAt <= now) return;

    this.entries.delete(key);
    this.entries.set(key, { response, storedAt: now, expiresAt });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
