import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { domains, users } from "../src/db/schema/index.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.drop();
});

describe("migrations against a real server", () => {
  test("apply to an empty database and create the native registry tables", async () => {
    const rows = await t.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
    `;
    const names = rows.map((r) => r.table_name);
    // A floor, not only membership: an empty result would satisfy nothing below
    // by accident, but it would read as "no unexpected tables" to a later check.
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const table of ["users", "tlds", "domains", "dns_records", "service_nodes", "relays"]) {
      expect(names).toContain(table);
    }
  });

  test("the (name, tld) constraint decides between two concurrent registrations", async () => {
    const [owner] = await t.db.insert(users).values({ oxyUserId: "harness-owner" }).returning();

    const attempt = () =>
      t.db
        .insert(domains)
        .values({ name: "race", tld: "ox", ownerId: owner.id, oxyUserId: owner.oxyUserId })
        .onConflictDoNothing({ target: [domains.name, domains.tld] })
        .returning({ id: domains.id });

    const results = await Promise.all([attempt(), attempt(), attempt()]);
    expect(results.flat()).toHaveLength(1);
  });
});
