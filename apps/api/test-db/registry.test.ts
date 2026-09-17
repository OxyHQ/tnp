/**
 * Native availability, the owner's inventory, the public proposals list and
 * the readiness ping, against a real server.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import { dnsRecords, tldProposals, tlds, users, votes } from "../src/db/schema/index.js";
import { pingDatabase } from "../src/db/postgres.js";
import {
  checkNativeAvailability,
  listOwnedDomains,
  parseAvailabilityQuery,
} from "../src/registry/domains.js";
import { listTldProposals } from "../src/registry/tlds.js";
import { daysFrom, seedDomain, seedTld } from "./fixtures.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  await seedTld(t.db, "ox");
  await t.db.insert(tlds).values({ name: "later", status: "proposed" });
});

afterAll(async () => {
  await t.drop();
});

async function check(input: string) {
  const query = parseAvailabilityQuery(input);
  return query.ok ? checkNativeAvailability(t.db, query) : query.answer;
}

describe("native availability", () => {
  test("every reason, with the additive namespace field", async () => {
    await seedDomain(t.db, { name: "taken" });
    await seedDomain(t.db, { name: "lapsed", expiresAt: daysFrom(new Date(), -400) });

    expect(await check("Free.OX")).toEqual({ domain: "free.ox", available: true, namespace: "tnp-native" });
    expect(await check("taken.ox")).toEqual({
      domain: "taken.ox",
      available: false,
      reason: "registered",
      namespace: "tnp-native",
    });
    // An expired name is held, never offered.
    expect((await check("lapsed.ox")).reason).toBe("registered");
    expect((await check("x.later")).reason).toBe("tld_not_available");
    expect((await check("x.nope")).reason).toBe("tld_not_available");
    expect((await check("google.com")).reason).toBe("reserved");
    expect((await check("a.b.ox")).reason).toBe("invalid");
    expect((await check("-bad.ox")).reason).toBe("invalid");
  });
});

describe("listOwnedDomains", () => {
  test("pages the owner's domains with record counts and nobody else's", async () => {
    const owner = "inventory-owner";
    const now = new Date();
    const made = [];
    for (let i = 0; i < 5; i++) {
      made.push(await seedDomain(t.db, { name: `inv${i}`, oxyUserId: owner, expiresAt: daysFrom(now, 10) }));
    }
    await seedDomain(t.db, { name: "notmine", oxyUserId: "another-owner" });
    await t.db.insert(dnsRecords).values([
      { domainId: made[0].id, type: "A", name: "@", value: "192.0.2.1" },
      { domainId: made[0].id, type: "A", name: "www", value: "192.0.2.1" },
      { domainId: made[3].id, type: "TXT", name: "@", value: "x" },
    ]);

    const first = await listOwnedDomains(t.db, { oxyUserId: owner, page: 1, limit: 2 });
    const rest = await listOwnedDomains(t.db, { oxyUserId: owner, page: 2, limit: 10 });
    const all = await listOwnedDomains(t.db, { oxyUserId: owner, page: 1, limit: 10 });

    expect(first.total).toBe(5);
    expect(first.rows).toHaveLength(2);
    expect(all.rows).toHaveLength(5);
    expect(rest.rows).toHaveLength(0);
    expect(all.rows.every((row) => row.domain.oxyUserId === owner)).toBe(true);

    const counts = Object.fromEntries(all.rows.map((row) => [row.domain.name, row.recordCount]));
    expect(counts).toEqual({ inv0: 2, inv1: 0, inv2: 0, inv3: 1, inv4: 0 });
    // postgres.js decodes count(*) as a string unless cast; the ::int is load-bearing.
    expect(typeof all.rows[0].recordCount).toBe("number");
  });
});

describe("listTldProposals", () => {
  test("answers proposedByMe for the caller and publishes no proposer identity", async () => {
    const [alice] = await t.db.insert(users).values({ oxyUserId: "oxy-alice" }).returning();
    const [bob] = await t.db.insert(users).values({ oxyUserId: "oxy-bob" }).returning();
    const [byAlice] = await t.db
      .insert(tldProposals)
      .values({ tld: "alicetld", proposedById: alice.id, reason: "because" })
      .returning();
    await t.db.insert(tldProposals).values({ tld: "bobtld", proposedById: bob.id, reason: "why not" });
    await t.db.insert(votes).values({ proposalId: byAlice.id, userId: bob.id, direction: "up" });

    const asAlice = await listTldProposals(t.db, "oxy-alice");
    const asBob = await listTldProposals(t.db, "oxy-bob");
    const anonymous = await listTldProposals(t.db, null);

    expect(asAlice).toHaveLength(2);
    expect(asAlice.map((p) => [p.tld, p.proposedByMe])).toEqual([
      ["alicetld", true],
      ["bobtld", false],
    ]);
    expect(asBob.find((p) => p.tld === "alicetld")).toMatchObject({ proposedByMe: false, userVote: "up", score: 1 });
    expect(anonymous.every((p) => p.proposedByMe === false && p.userVote === null)).toBe(true);

    const wire = JSON.stringify([asAlice, asBob, anonymous]);
    for (const secret of ["oxy-alice", "oxy-bob", alice.id, bob.id]) {
      expect(wire).not.toContain(secret);
    }
    for (const entry of asAlice) {
      expect(Object.keys(entry).sort()).toEqual(
        ["_id", "createdAt", "proposedByMe", "reason", "score", "status", "tld", "userVote"].sort(),
      );
    }
  });
});

describe("pingDatabase", () => {
  test("is true against a live server", async () => {
    expect(await pingDatabase(t.sql, 2000)).toBe(true);
  });

  test("is false, within the timeout, when the server refuses connections", async () => {
    const url = new URL(t.url);
    url.port = "1"; // nothing listens on port 1
    const unreachable = postgres(url.toString(), { max: 1, connect_timeout: 10, onnotice: () => {} });
    try {
      const started = Date.now();
      expect(await pingDatabase(unreachable, 2000)).toBe(false);
      expect(Date.now() - started).toBeLessThan(2500);
    } finally {
      await unreachable.end({ timeout: 1 });
    }
  });
});
