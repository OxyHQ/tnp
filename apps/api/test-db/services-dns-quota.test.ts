import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "../src/db/postgres.js";
import { dnsZones, dnsZoneSnapshots, operations, providerAccounts, publicDomains } from "../src/db/schema/index.js";
import { hashZone, type ZoneChange } from "../src/services/dns/zone.js";
import { OPERATION_KINDS } from "../src/services/operations/handlers.js";
import { enqueueOperation } from "../src/services/operations/store.js";
import type { Zone } from "../src/services/providers/contracts.js";
import { ProviderError } from "../src/services/providers/errors.js";
import { createPostgresQuotaGate } from "../src/services/providers/rateLimit.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";
import { CONTACTS, createAccount, createUser, engineFor, loadOperation, makeDue, MemoryProviderState } from "./servicesFixtures.js";

let t: TestDatabase;
let db: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
});

afterAll(async () => {
  await t.drop();
});

describe("dns.apply", () => {
  let state: MemoryProviderState;
  let ownerId: string;
  let account: typeof providerAccounts.$inferSelect;
  let zoneId: string;
  const name = "zone.com";
  const initial: Zone = {
    records: [
      { host: "@", type: "MX", value: "mail.provider.example", ttl: 1800, priority: 10 },
      { host: "@", type: "TXT", value: "google-site-verification=abc", ttl: 1800, priority: null },
      { host: "legacy", type: "SRV", value: "0 5 5060 sip.example", ttl: 1800, priority: null },
    ],
    settings: { EmailType: "MX" },
    servedByProvider: true,
  };

  beforeEach(async () => {
    await db.update(operations).set({ status: "failed", leaseOwner: null, leaseExpiresAt: null }).where(inArray(operations.status, ["queued", "unknown", "running"]));
    state = new MemoryProviderState();
    ownerId = await createUser(db);
    account = await createAccount(db);
    const [domain] = await db
      .insert(publicDomains)
      .values({ ownerId, asciiName: name, unicodeName: name, suffix: "com", providerAccountId: account.id, lifecycle: "active" })
      .returning();
    const [zone] = await db
      .insert(dnsZones)
      .values({ publicDomainId: domain.id, authority: "provider", providerAccountId: account.id, state: "in_sync" })
      .returning();
    zoneId = zone.id;
    state.domains.set(name, {
      remoteId: "mem-zone",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 365 * 86_400_000),
      locked: true,
      contacts: CONTACTS,
      zone: structuredClone(initial),
    });
  });

  async function enqueueApply(changes: ZoneChange[], baseHash: string) {
    const [zone] = await db
      .update(dnsZones)
      .set({ desiredVersion: 1, state: "pending" })
      .where(eq(dnsZones.id, zoneId))
      .returning();
    const { operation } = await enqueueOperation(db, {
      kind: OPERATION_KINDS.dnsApply,
      scope: `user:${ownerId}`,
      idempotencyKey: `dns-${crypto.randomUUID()}`,
      ownerId,
      resourceType: "dns_zone",
      resourceId: zoneId,
      providerAccountId: account.id,
      payload: { zoneId, baseHash, changes, environment: "sandbox", desiredVersion: zone.desiredVersion },
    });
    return operation.id;
  }

  const addA: ZoneChange = { action: "add", record: { host: "www", type: "A", value: "192.0.2.10", ttl: 1800, priority: null } };

  test("adding a record sends the whole zone: MX, verification TXT and unsupported-type records survive", async () => {
    const operationId = await enqueueApply([addA], hashZone(initial));
    await engineFor(db, state).runOnce();

    expect((await loadOperation(db, operationId)).status).toBe("succeeded");
    const remote = state.domains.get(name)?.zone;
    expect(remote?.records).toHaveLength(4);
    expect(remote?.records.some((r) => r.type === "MX" && r.value === "mail.provider.example")).toBe(true);
    expect(remote?.records.some((r) => r.type === "TXT")).toBe(true);
    expect(remote?.records.some((r) => r.type === "SRV")).toBe(true);
    expect(remote?.settings).toEqual({ EmailType: "MX" });

    const [zone] = await db.select().from(dnsZones).where(eq(dnsZones.id, zoneId));
    expect(zone.state).toBe("in_sync");
    expect(zone.appliedVersion).toBe(1);
    const snapshots = await db.select().from(dnsZoneSnapshots).where(eq(dnsZoneSnapshots.zoneId, zoneId));
    expect(snapshots.map((s) => s.source).sort()).toEqual(["applied", "observed"]);
  });

  test("an edit made at the provider since the preview is a conflict, and nothing is written", async () => {
    const baseHash = hashZone(initial);
    const stored = state.domains.get(name);
    if (!stored) throw new Error("fixture domain missing");
    // Someone edits the zone in the provider's own panel after the preview.
    stored.zone = { ...stored.zone, records: [...stored.zone.records, { host: "panel", type: "A", value: "198.51.100.7", ttl: 1800, priority: null }] };

    const operationId = await enqueueApply([addA], baseHash);
    await engineFor(db, state).runOnce();

    const op = await loadOperation(db, operationId);
    expect(op.status).toBe("failed");
    expect(op.errorCode).toBe("conflict");
    expect(state.calls.filter((c) => c.method === "replaceZone")).toHaveLength(0);
    const [row] = await db.select().from(dnsZones).where(eq(dnsZones.id, zoneId));
    expect(row.state).toBe("conflict");
  });

  test("replaced but the response was lost: reconciled from the zone itself, not sent twice", async () => {
    const operationId = await enqueueApply([addA], hashZone(initial));
    state.failNext("replaceZone", { mode: "apply_then_timeout" });
    const engine = engineFor(db, state);
    await engine.runOnce();
    expect((await loadOperation(db, operationId)).status).toBe("unknown");

    await makeDue(db, operationId);
    await engine.runOnce();
    expect((await loadOperation(db, operationId)).status).toBe("succeeded");
    expect(state.calls.filter((c) => c.method === "replaceZone")).toHaveLength(1);
  });

  test("a re-read refused after the zone was replaced is an unknown outcome, not a retry", async () => {
    const operationId = await enqueueApply([addA], hashZone(initial));
    // First read succeeds; the verification read after the replace is refused
    // before sending, as the shared quota gate would.
    state.failNext("readZone", { mode: "none" });
    state.failNext("readZone", { mode: "refuse", code: "rate_limited" });
    const engine = engineFor(db, state);

    await engine.runOnce();
    const op = await loadOperation(db, operationId);
    expect(op.status).toBe("unknown");
    expect(op.submittedAt).not.toBeNull();

    await makeDue(db, operationId);
    await engine.runOnce();
    expect((await loadOperation(db, operationId)).status).toBe("succeeded");
    expect(state.calls.filter((c) => c.method === "replaceZone")).toHaveLength(1);
    const [zone] = await db.select().from(dnsZones).where(eq(dnsZones.id, zoneId));
    expect(zone.state).toBe("in_sync");
  });

  test("while one change is in doubt, the next change to the same zone waits", async () => {
    const first = await enqueueApply([addA], hashZone(initial));
    state.failNext("replaceZone", { mode: "timeout_without_apply" });
    const engine = engineFor(db, state, { settleMs: 3_600_000 });
    await engine.runOnce();
    expect((await loadOperation(db, first)).status).toBe("unknown");

    const second = await enqueueApply(
      [{ action: "add", record: { host: "api", type: "A", value: "192.0.2.11", ttl: 1800, priority: null } }],
      hashZone(initial),
    );
    // The first is not due yet and the second targets the same zone: nothing runs.
    expect(await engine.runOnce()).toBe(false);
    expect((await loadOperation(db, second)).status).toBe("queued");
    expect(state.calls.filter((c) => c.method === "replaceZone")).toHaveLength(1);
  });

  test("a backlog on one zone does not starve other resources", async () => {
    const holder = await enqueueApply([addA], hashZone(initial));
    state.failNext("replaceZone", { mode: "timeout_without_apply" });
    const engine = engineFor(db, state, { settleMs: 3_600_000 });
    await engine.runOnce();
    expect((await loadOperation(db, holder)).status).toBe("unknown");
    for (let i = 0; i < 15; i++) {
      await enqueueApply([{ action: "add", record: { host: `h${i}`, type: "A", value: "192.0.2.20", ttl: 1800, priority: null } }], hashZone(initial));
    }
    const other = crypto.randomUUID();
    const { operation } = await enqueueOperation(db, {
      kind: OPERATION_KINDS.sync,
      scope: "system",
      idempotencyKey: `sync-other-${other}`,
      ownerId,
      resourceType: "public_domain",
      resourceId: other,
      providerAccountId: account.id,
      payload: { publicDomainId: other, environment: "sandbox" },
      runAt: new Date(Date.now() + 1_000),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await engine.runOnce()).toBe(true);
    // It ran (and failed on the missing domain) instead of waiting behind the backlog.
    expect((await loadOperation(db, operation.id)).status).not.toBe("queued");
  });

  test("a change that would put a CNAME beside other records is refused before submission", async () => {
    const operationId = await enqueueApply(
      [{ action: "add", record: { host: "@", type: "CNAME", value: "elsewhere.example", ttl: 1800, priority: null } }],
      hashZone(initial),
    );
    await engineFor(db, state).runOnce();
    const op = await loadOperation(db, operationId);
    expect(op.status).toBe("failed");
    expect(op.errorCode).toBe("validation");
    expect(op.submittedAt).toBeNull();
  });
});

describe("shared provider quota", () => {
  const limits = { memory: { perMinute: 10, perHour: 100, perDay: 1000, criticalReserve: 0.2 } };

  test("interactive calls stop at the unreserved share; critical calls use the reserve; then everything stops", async () => {
    const account = await createAccount(db);
    const gate = createPostgresQuotaGate(db, limits);

    for (let i = 0; i < 8; i++) await gate.acquire(account.id, "interactive");
    await expect(gate.acquire(account.id, "interactive")).rejects.toMatchObject({ code: "rate_limited", submitted: false });
    await gate.acquire(account.id, "critical");
    await gate.acquire(account.id, "critical");
    const refused = await gate.acquire(account.id, "critical").catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(ProviderError);
  });

  test("replicas contending for the last slots admit exactly the capacity", async () => {
    const account = await createAccount(db);
    // Separate gates over separate pools model separate replicas.
    const replicas = [createPostgresQuotaGate(db, limits), createPostgresQuotaGate(db, limits)];
    const attempts = Array.from({ length: 30 }, (_, i) => replicas[i % 2].acquire(account.id, "critical").then(() => true, () => false));
    const admitted = (await Promise.all(attempts)).filter(Boolean).length;
    expect(admitted).toBe(10);
  });
});
