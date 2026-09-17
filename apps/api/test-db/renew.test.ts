import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { nextNativeExpiry } from "@tnp/namespace";
import { domains } from "../src/db/schema/index.js";
import { renewNativeDomain, type RenewalOutcome } from "../src/registry/domains.js";
import { backendPid, daysFrom, seedDomain, waitUntilBlockedBy } from "./fixtures.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.drop();
});

async function expiryOf(id: string): Promise<Date | null> {
  const [row] = await t.db.select({ expiresAt: domains.expiresAt }).from(domains).where(eq(domains.id, id));
  return row.expiresAt;
}

describe("renewNativeDomain", () => {
  test("renews a name inside its window by one term from its current expiry", async () => {
    const now = new Date();
    const expiresAt = daysFrom(now, 20);
    const domain = await seedDomain(t.db, { name: "window", expiresAt });

    const outcome = await renewNativeDomain(t.db, { domainId: domain.id, oxyUserId: domain.oxyUserId, now });
    expect(outcome.ok).toBe(true);
    expect((await expiryOf(domain.id))?.toISOString()).toBe(nextNativeExpiry(expiresAt, now).toISOString());
  });

  test("renews a lapsed name from now", async () => {
    const now = new Date();
    const domain = await seedDomain(t.db, { name: "lapsed", expiresAt: daysFrom(now, -200) });

    expect((await renewNativeDomain(t.db, { domainId: domain.id, oxyUserId: domain.oxyUserId, now })).ok).toBe(true);
    expect((await expiryOf(domain.id))?.toISOString()).toBe(nextNativeExpiry(now, now).toISOString());
  });

  test("refuses an active name, a name without expiry, another owner and a reserved-TLD row", async () => {
    const now = new Date();
    const active = await seedDomain(t.db, { name: "active", expiresAt: daysFrom(now, 200) });
    const forever = await seedDomain(t.db, { name: "forever", expiresAt: null });
    const theirs = await seedDomain(t.db, { name: "theirs", expiresAt: daysFrom(now, 5), oxyUserId: "someone-else" });
    const legacy = await seedDomain(t.db, { name: "legacy", tld: "com", expiresAt: daysFrom(now, 5) });

    const codes = async (id: string, oxyUserId: string) => {
      const outcome = await renewNativeDomain(t.db, { domainId: id, oxyUserId, now });
      return outcome.ok ? "ok" : outcome.code;
    };

    expect(await codes(active.id, active.oxyUserId)).toBe("not_renewable");
    expect(await codes(forever.id, forever.oxyUserId)).toBe("no_expiry");
    expect(await codes(theirs.id, "owner-under-test")).toBe("forbidden");
    expect(await codes(legacy.id, legacy.oxyUserId)).toBe("not_native");
    expect(await codes(crypto.randomUUID(), "owner-under-test")).toBe("not_found");

    // Nothing was written by any refusal.
    expect((await expiryOf(active.id))?.getTime()).toBe(daysFrom(now, 200).getTime());
    expect((await expiryOf(theirs.id))?.getTime()).toBe(daysFrom(now, 5).getTime());
  });

  test("two interleaved renewals extend the name once and report one conflict", async () => {
    const now = new Date();
    const expiresAt = daysFrom(now, 10);
    const domain = await seedDomain(t.db, { name: "race", expiresAt });
    const params = { domainId: domain.id, oxyUserId: domain.oxyUserId, now };

    // A holder object, not a `let`: assigned inside the callback, a `let`
    // would be narrowed back to its initial value by the type checker.
    const race: { contender?: Promise<RenewalOutcome> } = {};

    await t.db.transaction(async (tx) => {
      // Hold the row so the contender's UPDATE has to wait behind this one.
      await tx.select({ id: domains.id }).from(domains).where(eq(domains.id, domain.id)).for("update");
      const pid = await backendPid(tx);

      // The contender reads the original expiry (a plain read is not blocked)
      // and then blocks on its UPDATE.
      race.contender = renewNativeDomain(t.db, params);
      await waitUntilBlockedBy(t.sql, pid);

      const first = await renewNativeDomain(tx, params);
      expect(first.ok).toBe(true);
    });

    if (!race.contender) throw new Error("contender never started");
    const second = await race.contender;
    expect(second.ok).toBe(false);
    expect(second.ok ? "ok" : second.code).toBe("conflict");

    expect((await expiryOf(domain.id))?.toISOString()).toBe(nextNativeExpiry(expiresAt, now).toISOString());
  });

  test("a microsecond-precision expiry written by SQL can still be renewed", async () => {
    const now = new Date();
    const domain = await seedDomain(t.db, { name: "micro", expiresAt: daysFrom(now, 3) });
    await t.sql`update domains set expires_at = expires_at + interval '123 microseconds' where id = ${domain.id}`;

    expect((await renewNativeDomain(t.db, { domainId: domain.id, oxyUserId: domain.oxyUserId, now })).ok).toBe(true);
  });
});
