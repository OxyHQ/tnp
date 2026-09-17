import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { MAX_DNS_RECORDS_PER_DOMAIN, type DnsRecordInput } from "@tnp/shared-types";
import { dnsRecords, domains } from "../src/db/schema/index.js";
import {
  createDnsRecord,
  deleteDnsRecord,
  updateDnsRecord,
  type RecordMutationResult,
} from "../src/registry/records.js";
import { backendPid, seedDomain, waitUntilBlockedBy } from "./fixtures.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.drop();
});

function a(name: string, value = "192.0.2.1"): DnsRecordInput {
  return { type: "A", name, value, ttl: 3600 };
}

function codeOf<T>(result: RecordMutationResult<T>): string {
  return result.ok ? "ok" : result.code;
}

async function recordsAt(domainId: string, name: string) {
  return t.db
    .select()
    .from(dnsRecords)
    .where(and(eq(dnsRecords.domainId, domainId), eq(dnsRecords.name, name)));
}

describe("createDnsRecord", () => {
  test("stores the record under its relative name", async () => {
    const domain = await seedDomain(t.db, { name: "create" });
    const result = await createDnsRecord(t.db, domain.id, a("www.create.ox"));
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.name).toBe("www");
  });

  test("CNAME exclusivity is enforced in both directions, and exact duplicates are refused", async () => {
    const domain = await seedDomain(t.db, { name: "cname" });
    expect(codeOf(await createDnsRecord(t.db, domain.id, a("@")))).toBe("ok");
    expect(codeOf(await createDnsRecord(t.db, domain.id, a("@")))).toBe("duplicate");
    expect(
      codeOf(await createDnsRecord(t.db, domain.id, { type: "CNAME", name: "@", value: "x.example.ox", ttl: 60 })),
    ).toBe("cname_conflict");

    expect(
      codeOf(await createDnsRecord(t.db, domain.id, { type: "CNAME", name: "www", value: "x.example.ox", ttl: 60 })),
    ).toBe("ok");
    expect(codeOf(await createDnsRecord(t.db, domain.id, a("www")))).toBe("cname_conflict");
    expect(await recordsAt(domain.id, "www")).toHaveLength(1);
  });

  test("a legacy fully-qualified record name still counts for the conflict rules", async () => {
    const domain = await seedDomain(t.db, { name: "legacy" });
    await t.db
      .insert(dnsRecords)
      .values({ domainId: domain.id, type: "CNAME", name: "www.legacy.ox", value: "x.example.ox" });
    expect(codeOf(await createDnsRecord(t.db, domain.id, a("www")))).toBe("cname_conflict");
  });

  test("a domain holds at most the record cap", async () => {
    const domain = await seedDomain(t.db, { name: "capped" });
    await t.db.insert(dnsRecords).values(
      Array.from({ length: MAX_DNS_RECORDS_PER_DOMAIN }, (_, i) => ({
        domainId: domain.id,
        type: "TXT" as const,
        name: "@",
        value: `record-${i}`,
      })),
    );
    expect(codeOf(await createDnsRecord(t.db, domain.id, a("over")))).toBe("record_limit");
    const [{ count }] = await t.sql<{ count: number }[]>`
      select count(*)::int as count from dns_records where domain_id = ${domain.id}
    `;
    expect(count).toBe(MAX_DNS_RECORDS_PER_DOMAIN);
  });

  test("an unknown domain is not found", async () => {
    expect(codeOf(await createDnsRecord(t.db, crypto.randomUUID(), a("@")))).toBe("domain_not_found");
  });

  test("a concurrent writer waits for the domain lock and then sees the CNAME it must not join", async () => {
    const domain = await seedDomain(t.db, { name: "interleaved" });
    const race: { contender?: Promise<RecordMutationResult<unknown>> } = {};

    await t.db.transaction(async (tx) => {
      await tx.select({ id: domains.id }).from(domains).where(eq(domains.id, domain.id)).for("update");
      const pid = await backendPid(tx);

      // Without the lock the contender would read an empty name, pass its
      // check and insert next to the CNAME below.
      race.contender = createDnsRecord(t.db, domain.id, a("www"));
      await waitUntilBlockedBy(t.sql, pid);

      await tx
        .insert(dnsRecords)
        .values({ domainId: domain.id, type: "CNAME", name: "www", value: "host.example.ox" });
    });

    if (!race.contender) throw new Error("contender never started");
    expect(codeOf(await race.contender)).toBe("cname_conflict");
    const atWww = await recordsAt(domain.id, "www");
    expect(atWww.map((r) => r.type)).toEqual(["CNAME"]);
  });
});

describe("updateDnsRecord", () => {
  test("validates the merged record, not the patch", async () => {
    const domain = await seedDomain(t.db, { name: "update" });
    const created = await createDnsRecord(t.db, domain.id, a("@"));
    if (!created.ok) throw new Error("setup failed");

    const bad = await updateDnsRecord(t.db, domain.id, created.value.id, { type: "CNAME" });
    expect(codeOf(bad)).toBe("hostname_invalid");
    expect(bad.ok ? 0 : bad.status).toBe(400);

    const good = await updateDnsRecord(t.db, domain.id, created.value.id, { type: "CNAME", value: "h.example.ox" });
    expect(good.ok && good.value.type).toBe("CNAME");
  });

  test("an MX priority-only update keeps the stored host", async () => {
    const domain = await seedDomain(t.db, { name: "mx" });
    const created = await createDnsRecord(t.db, domain.id, { type: "MX", name: "@", value: "10 mail.example.ox", ttl: 3600 });
    if (!created.ok) throw new Error("setup failed");
    const updated = await updateDnsRecord(t.db, domain.id, created.value.id, { priority: 20 });
    expect(updated.ok && updated.value.value).toBe("20 mail.example.ox");
  });

  test("the conflict rules apply to the updated record, ignoring its old self", async () => {
    const domain = await seedDomain(t.db, { name: "movecname" });
    const cname = await createDnsRecord(t.db, domain.id, { type: "CNAME", name: "www", value: "h.example.ox", ttl: 60 });
    const apex = await createDnsRecord(t.db, domain.id, a("@"));
    if (!cname.ok || !apex.ok) throw new Error("setup failed");

    expect(codeOf(await updateDnsRecord(t.db, domain.id, cname.value.id, { value: "other.example.ox" }))).toBe("ok");
    expect(codeOf(await updateDnsRecord(t.db, domain.id, apex.value.id, { name: "www" }))).toBe("cname_conflict");
  });

  test("a record of another domain is not found through this one", async () => {
    const mine = await seedDomain(t.db, { name: "mine" });
    const other = await seedDomain(t.db, { name: "other", oxyUserId: "someone-else" });
    const theirs = await createDnsRecord(t.db, other.id, a("@"));
    if (!theirs.ok) throw new Error("setup failed");

    expect(codeOf(await updateDnsRecord(t.db, mine.id, theirs.value.id, { ttl: 60 }))).toBe("record_not_found");
    expect(codeOf(await deleteDnsRecord(t.db, mine.id, theirs.value.id))).toBe("record_not_found");
    expect(await recordsAt(other.id, "@")).toHaveLength(1);
  });
});
