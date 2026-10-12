/**
 * Domain-key lookup for a relay: `GET /domain-keys/:name` on the registry,
 * cached briefly in a bounded table.
 *
 * A relay checks a service node's grant chain against the domain key the
 * registry publishes. This is a CHOICE with a stated cost (relays.md §2): a
 * compromised registry can make a relay accept an attacker's node for a
 * name. That buys the attacker routing, not plaintext — clients verify the
 * same chain against the key they pinned, so a pinned client refuses the
 * attacker's node and sees a denial of service. The registry cannot be removed
 * from this decision until names are published in a key-transparency log.
 */

import { parseDomainKeyRecord } from '@tnp/shared-types';
import type { DomainKeyLookup } from './core.js';

export interface ApiDomainKeyLookupOptions {
  /** Positive answers are reused this long. */
  ttlMs?: number;
  /** "No key" answers are reused this long. */
  negativeTtlMs?: number;
  maxEntries?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function apiDomainKeyLookup(
  apiBaseUrl: string,
  options: ApiDomainKeyLookupOptions = {},
): DomainKeyLookup {
  const ttl = options.ttlMs ?? 60_000;
  const negativeTtl = options.negativeTtlMs ?? 10_000;
  const maxEntries = options.maxEntries ?? 4096;
  const timeoutMs = options.timeoutMs ?? 5000;
  const doFetch = options.fetch ?? fetch;
  const base = apiBaseUrl.replace(/\/+$/, '');
  const cache = new Map<string, { key: string | null; expires: number }>();
  const inFlight = new Map<string, Promise<string | null>>();

  const fetchKey = async (name: string): Promise<string | null> => {
    const now = Date.now();
    const res = await doFetch(`${base}/domain-keys/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    let key: string | null = null;
    if (res.ok) {
      const parsed = parseDomainKeyRecord(await res.json());
      if (parsed.ok && parsed.value.name === name) key = parsed.value.domainKey;
    } else if (res.status !== 404) {
      // An error is not "no key": throw so the caller fails closed without caching it.
      throw new Error(`registry returned ${res.status}`);
    }

    if (cache.size >= maxEntries) {
      for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
    }
    cache.set(name, { key, expires: now + (key ? ttl : negativeTtl) });
    return key;
  };

  return (name) => {
    const hit = cache.get(name);
    if (hit && hit.expires > Date.now()) return Promise.resolve(hit.key);
    // Identical lookups in flight share one request.
    const pending = inFlight.get(name);
    if (pending) return pending;
    const request = fetchKey(name).finally(() => inFlight.delete(name));
    inFlight.set(name, request);
    return request;
  };
}
