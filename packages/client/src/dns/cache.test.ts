import { describe, expect, test } from "bun:test";
import { DnsCache, type CachedRecord } from "./cache";

/** Controllable clock, so expiry is tested without sleeping. */
function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance(seconds: number) {
      t += seconds * 1000;
    },
  };
}

function record(ttl: number, value = "203.0.113.1"): CachedRecord {
  return { name: "e.ox", type: "A", value, ttl };
}

describe("TTL handling", () => {
  test("expires with the record's own TTL, not a fixed lifetime", () => {
    // The bug: every entry was stamped with `config.cacheTtlSeconds` (300s),
    // so a 60s record was served for 300s and a 86400s record was re-fetched
    // every 5 minutes (audit S9).
    const c = clock();
    const cache = new DnsCache({ now: c.now });

    cache.set("e.ox", "A", [record(60)]);
    c.advance(59);
    expect(cache.get("e.ox", "A")).not.toBeNull();
    c.advance(2);
    expect(cache.get("e.ox", "A")).toBeNull();
  });

  test("a long TTL is honoured well past the old fixed 300s", () => {
    const c = clock();
    const cache = new DnsCache({ now: c.now });

    cache.set("e.ox", "A", [record(3600)]);
    c.advance(1800);
    expect(cache.get("e.ox", "A")).not.toBeNull();
  });

  test("expires with the SHORTEST record in a set", () => {
    // Keeping the set past its earliest expiry would serve a stale member.
    const c = clock();
    const cache = new DnsCache({ now: c.now });

    cache.set("e.ox", "A", [record(3600, "a"), record(60, "b")]);
    c.advance(61);
    expect(cache.get("e.ox", "A")).toBeNull();
  });

  test("decrements the served TTL by the time held", () => {
    // Serving the original TTL is what lets a record outlive it: each
    // downstream cache re-arms the full lifetime on every hop.
    const c = clock();
    const cache = new DnsCache({ now: c.now });

    cache.set("e.ox", "A", [record(300)]);
    c.advance(100);

    const hit = cache.get("e.ox", "A");
    expect(hit?.records[0].ttl).toBe(200);
  });

  test("never serves a TTL below the floor", () => {
    const c = clock();
    const cache = new DnsCache({ now: c.now });

    cache.set("e.ox", "A", [record(10)]);
    c.advance(9);
    expect(cache.get("e.ox", "A")?.records[0].ttl).toBeGreaterThanOrEqual(1);
  });

  test("clamps an absurd TTL rather than pinning the entry for years", () => {
    const c = clock();
    const cache = new DnsCache({ now: c.now });

    cache.set("e.ox", "A", [record(999_999_999)]);
    c.advance(86_401);
    expect(cache.get("e.ox", "A")).toBeNull();
  });

  test("survives a non-finite TTL", () => {
    const c = clock();
    const cache = new DnsCache({ now: c.now });

    cache.set("e.ox", "A", [record(Number.NaN)]);
    // Clamped to the floor rather than producing an entry that never expires.
    c.advance(2);
    expect(cache.get("e.ox", "A")).toBeNull();
  });
});

describe("negative caching", () => {
  test("a cached NXDOMAIN is distinguishable from a cached empty set", () => {
    // Without this the two are the same shape, which is exactly the confusion
    // the hardcoded-NOERROR bug produced on the wire.
    const c = clock();
    const cache = new DnsCache({ now: c.now });

    cache.setNegative("gone.ox", "A", 120);
    const hit = cache.get("gone.ox", "A");

    expect(hit).not.toBeNull();
    expect(hit?.negative).toBe(true);
    expect(hit?.records).toEqual([]);
  });

  test("a miss and a cached negative are different states", () => {
    const c = clock();
    const cache = new DnsCache({ now: c.now });

    expect(cache.get("never-asked.ox", "A")).toBeNull();
    cache.setNegative("gone.ox", "A", 120);
    expect(cache.get("gone.ox", "A")).not.toBeNull();
  });

  test("honours the SOA minimum", () => {
    const c = clock();
    const cache = new DnsCache({ now: c.now });

    cache.setNegative("gone.ox", "A", 120);
    c.advance(119);
    expect(cache.get("gone.ox", "A")).not.toBeNull();
    c.advance(2);
    expect(cache.get("gone.ox", "A")).toBeNull();
  });

  test("falls back to a bounded default with no SOA", () => {
    const c = clock();
    const cache = new DnsCache({ now: c.now });

    cache.setNegative("gone.ox", "A");
    c.advance(59);
    expect(cache.get("gone.ox", "A")).not.toBeNull();
    c.advance(2);
    expect(cache.get("gone.ox", "A")).toBeNull();
  });

  test("caps a negative TTL at one hour, however large the SOA claims", () => {
    const c = clock();
    const cache = new DnsCache({ now: c.now });

    cache.setNegative("gone.ox", "A", 999_999);
    c.advance(3_601);
    expect(cache.get("gone.ox", "A")).toBeNull();
  });
});

describe("bounds", () => {
  test("never exceeds maxEntries", () => {
    // An unbounded Map is a memory-exhaustion path for anyone who can send
    // queries — one query per unique name is all it takes.
    const c = clock();
    const cache = new DnsCache({ maxEntries: 50, now: c.now });

    for (let i = 0; i < 500; i++) {
      cache.set(`name-${i}.ox`, "A", [record(300)]);
    }
    expect(cache.size).toBeLessThanOrEqual(50);
  });

  test("evicts expired entries before live ones", () => {
    const c = clock();
    const cache = new DnsCache({ maxEntries: 3, now: c.now });

    cache.set("short-a.ox", "A", [record(10)]);
    cache.set("short-b.ox", "A", [record(10)]);
    c.advance(20); // both now expired
    cache.set("live-1.ox", "A", [record(3600)]);
    cache.set("live-2.ox", "A", [record(3600)]);
    cache.set("live-3.ox", "A", [record(3600)]);

    expect(cache.size).toBeLessThanOrEqual(3);
    expect(cache.get("live-1.ox", "A")).not.toBeNull();
    expect(cache.get("live-2.ox", "A")).not.toBeNull();
    expect(cache.get("live-3.ox", "A")).not.toBeNull();
  });

  test("re-setting a key refreshes it rather than aging it out", () => {
    const c = clock();
    const cache = new DnsCache({ maxEntries: 2, now: c.now });

    cache.set("a.ox", "A", [record(3600)]);
    cache.set("b.ox", "A", [record(3600)]);
    cache.set("a.ox", "A", [record(3600)]); // refresh; a is now the newest
    cache.set("c.ox", "A", [record(3600)]); // forces one eviction

    expect(cache.get("a.ox", "A")).not.toBeNull();
    expect(cache.get("c.ox", "A")).not.toBeNull();
  });
});

describe("keys", () => {
  test("name and type are both part of the key", () => {
    const c = clock();
    const cache = new DnsCache({ now: c.now });

    cache.set("e.ox", "A", [record(300, "1.2.3.4")]);
    cache.set("e.ox", "AAAA", [{ name: "e.ox", type: "AAAA", value: "::1", ttl: 300 }]);

    expect(cache.get("e.ox", "A")?.records[0].value).toBe("1.2.3.4");
    expect(cache.get("e.ox", "AAAA")?.records[0].value).toBe("::1");
    expect(cache.get("e.ox", "MX")).toBeNull();
  });

  test("is case-insensitive on both name and type", () => {
    const c = clock();
    const cache = new DnsCache({ now: c.now });

    cache.set("E.OX", "a", [record(300)]);
    expect(cache.get("e.ox", "A")).not.toBeNull();
  });

  test("clear empties the cache", () => {
    const c = clock();
    const cache = new DnsCache({ now: c.now });

    cache.set("e.ox", "A", [record(300)]);
    cache.clear();
    expect(cache.get("e.ox", "A")).toBeNull();
    expect(cache.size).toBe(0);
  });
});
