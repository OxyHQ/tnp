/**
 * `loadNameFacts` against a real registry, through `decideResolution` — the
 * exact pair `/dns/resolve` runs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { dnsRecords, serviceNodes, tlds } from "../src/db/schema/index.js";
import {
  decideParkingPage,
  decideResolution,
  loadNameFacts,
  type ResolutionSettings,
} from "../src/registry/resolve.js";
import { daysFrom, seedDomain, seedTld } from "./fixtures.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";

const PARKING = "203.0.113.10";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  await seedTld(t.db, "ox");
  // A reserved TLD left active by an old seed must still never be answered.
  await t.db.insert(tlds).values({ name: "com", status: "active" });

  const now = new Date();
  const site = await seedDomain(t.db, { name: "site" });
  await t.db.insert(dnsRecords).values([
    { domainId: site.id, type: "A", name: "@", value: "192.0.2.1", ttl: 60 },
    { domainId: site.id, type: "CNAME", name: "www", value: "host.example.ox", ttl: 120 },
    { domainId: site.id, type: "TXT", name: "txt", value: "only text", ttl: 60 },
    { domainId: site.id, type: "A", name: "deep.b", value: "192.0.2.3", ttl: 60 },
    // Stored fully qualified, as older rows were.
    { domainId: site.id, type: "A", name: "old.site.ox", value: "192.0.2.4", ttl: 60 },
  ]);

  await seedDomain(t.db, { name: "empty" });

  const offline = await seedDomain(t.db, { name: "offline" });
  await t.db.insert(serviceNodes).values({
    domainId: offline.id,
    oxyUserId: offline.oxyUserId,
    publicKey: "b2ZmbGluZQ==",
    status: "offline",
  });

  const stale = await seedDomain(t.db, { name: "stale" });
  await t.db.insert(serviceNodes).values({
    domainId: stale.id,
    oxyUserId: stale.oxyUserId,
    publicKey: "c3RhbGU=",
    status: "online",
    lastSeen: sql`now() - interval '10 minutes'`,
  });

  const live = await seedDomain(t.db, { name: "live" });
  await t.db.insert(serviceNodes).values({
    domainId: live.id,
    oxyUserId: live.oxyUserId,
    publicKey: "bGl2ZQ==",
    connectedRelay: "wss://relay.example.test",
    status: "online",
  });

  const lapsed = await seedDomain(t.db, { name: "lapsed", expiresAt: daysFrom(now, -60) });
  await t.db.insert(dnsRecords).values({ domainId: lapsed.id, type: "A", name: "@", value: "192.0.2.9", ttl: 60 });

});

afterAll(async () => {
  await t.drop();
});

function settings(overrides: Partial<ResolutionSettings> = {}): ResolutionSettings {
  return { parkingIp: PARKING, expiryEnforced: false, now: new Date(), ...overrides };
}

async function resolve(name: string, qtype: string, overrides: Partial<ResolutionSettings> = {}) {
  return decideResolution(await loadNameFacts(t.db, name), qtype, settings(overrides));
}

describe("registry answers", () => {
  test("A record at the apex", async () => {
    expect(await resolve("site.ox", "A")).toEqual({
      name: "site.ox",
      type: "A",
      answers: [{ name: "site.ox", type: "A", value: "192.0.2.1", ttl: 60 }],
      rcode: "NOERROR",
    });
  });

  test("CNAME: an A query on a CNAME-only name gets the CNAME, not parking", async () => {
    expect(await resolve("WWW.site.ox.", "A")).toEqual({
      name: "www.site.ox",
      type: "A",
      answers: [{ name: "www.site.ox", type: "CNAME", value: "host.example.ox", ttl: 120 }],
      rcode: "NOERROR",
    });
  });

  test("NODATA: a name with only TXT answers an A query with nothing, NOERROR", async () => {
    expect(await resolve("txt.site.ox", "A")).toMatchObject({ answers: [], rcode: "NOERROR" });
  });

  test("NXDOMAIN: an unknown label under a registered name, without parking", async () => {
    expect(await resolve("nothing.site.ox", "A", { parkingIp: "" })).toMatchObject({
      answers: [],
      rcode: "NXDOMAIN",
    });
    // An empty non-terminal is not NXDOMAIN.
    expect(await resolve("b.site.ox", "A", { parkingIp: "" })).toMatchObject({ rcode: "NOERROR" });
    expect((await resolve("deep.b.site.ox", "A")).answers[0]?.value).toBe("192.0.2.3");
  });

  test("records stored under the full name still resolve", async () => {
    expect((await resolve("old.site.ox", "A")).answers[0]?.value).toBe("192.0.2.4");
  });

  test("NXDOMAIN: reserved TLDs even with an active row, single labels, unknown TLDs", async () => {
    for (const name of ["site.com", "localhost", "site.unknowntld"]) {
      expect(await resolve(name, "A")).toMatchObject({ answers: [], rcode: "NXDOMAIN" });
    }
  });

  test("parking: an unregistered native name and a registered name with nothing", async () => {
    for (const name of ["unregistered.ox", "empty.ox"]) {
      expect(await resolve(name, "A")).toMatchObject({
        answers: [{ name, type: "A", value: PARKING, ttl: 300 }],
        rcode: "NOERROR",
      });
    }
  });

  test("offline node: marked offline, or online with a stale heartbeat, parks and offers no overlay", async () => {
    for (const name of ["offline.ox", "stale.ox"]) {
      const response = await resolve(name, "A");
      expect(response.overlay).toBeUndefined();
      expect(response.answers[0]?.value).toBe(PARKING);
      expect(decideParkingPage(await loadNameFacts(t.db, name), settings())).toBe("registered");
    }
  });

  test("online node: overlay, no parking, and the parking page steps aside", async () => {
    const response = await resolve("live.ox", "A");
    expect(response).toEqual({
      name: "live.ox",
      type: "A",
      answers: [],
      rcode: "NOERROR",
      overlay: { serviceNodePubKey: "bGl2ZQ==", relay: "wss://relay.example.test", available: true },
    });
    expect(decideParkingPage(await loadNameFacts(t.db, "live.ox"), settings())).toBeNull();
  });

  test("expiry: served while enforcement is off, held when it is on", async () => {
    expect((await resolve("lapsed.ox", "A")).answers[0]?.value).toBe("192.0.2.9");

    const held = await resolve("lapsed.ox", "A", { expiryEnforced: true });
    expect(held.answers).toEqual([{ name: "lapsed.ox", type: "A", value: PARKING, ttl: 300 }]);
    expect(decideParkingPage(await loadNameFacts(t.db, "lapsed.ox"), settings({ expiryEnforced: true }))).toBe(
      "held",
    );
    expect(decideParkingPage(await loadNameFacts(t.db, "unregistered.ox"), settings())).toBe("available");
  });
});
