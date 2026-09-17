/**
 * End-to-end fulfilment against a real PostgreSQL and the in-memory provider:
 * quote → order → operation → provider → reconciliation, including every
 * failure the engine has to survive without buying or renewing twice.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import type { Database } from "../src/db/postgres.js";
import { auditEvents, operations, orderLines, orders, providerAccounts, publicDomains, quotes } from "../src/db/schema/index.js";
import { Catalog, readOnlyCall } from "../src/services/catalog.js";
import { OPERATION_KINDS } from "../src/services/operations/handlers.js";
import { IdempotencyConflictError } from "../src/services/operations/intent.js";
import { enqueueOperation } from "../src/services/operations/store.js";
import {
  isUniqueViolation,
  PaymentsNotConfiguredError,
  placeOrder,
  QuoteUnusableError,
  sandboxNoCharge,
  unconfiguredPayments,
} from "../src/services/orders.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";
import {
  CONTACTS,
  createAccount,
  createUser,
  engineFor,
  loadOperation,
  makeDue,
  MemoryProviderState,
  memoryRegistry,
} from "./servicesFixtures.js";

let t: TestDatabase;
let db: Database;
let state: MemoryProviderState;
let ownerId: string;
let account: typeof providerAccounts.$inferSelect;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  // This file owns its database. Operations left runnable by an earlier test
  // would otherwise be claimed here against a fresh provider state.
  await db
    .update(operations)
    .set({ status: "failed", leaseOwner: null, leaseExpiresAt: null })
    .where(inArray(operations.status, ["queued", "unknown", "running"]));
  state = new MemoryProviderState();
  ownerId = await createUser(db);
  account = await createAccount(db);
});

async function orderDomain(name: string) {
  const catalog = new Catalog(db, memoryRegistry(state));
  const quote = await catalog.quoteRegistration(account, ownerId, name, 1, readOnlyCall("test"));
  const placed = await placeOrder(db, sandboxNoCharge, {
    ownerId,
    quoteIds: [quote.id],
    idempotencyKey: `order-${crypto.randomUUID()}`,
    contacts: CONTACTS,
    privacy: true,
    actor: { kind: "system" as const },
  });
  const [line] = await db.select().from(orderLines).where(eq(orderLines.orderId, placed.order.id));
  if (!line.operationId || !line.publicDomainId) throw new Error("order line was not wired to an operation");
  return { quote, order: placed.order, line, operationId: line.operationId, domainId: line.publicDomainId };
}

async function registerCalls(name: string) {
  return state.calls.filter((c) => c.method === "register").length;
}

describe("catalog", () => {
  test("availability distinguishes available, unavailable, unsupported and invalid — never guesses", async () => {
    state.taken.add("taken.com");
    const catalog = new Catalog(db, memoryRegistry(state));
    const answers = await catalog.checkAvailability(
      account,
      ["free.com", "taken.com", "name.co.uk", "www.example.com", "nope.org", "bad..name", "ejemplo.ox"],
      readOnlyCall("test"),
    );
    expect(answers.map((a) => [a.input, a.status])).toEqual([
      ["free.com", "available"],
      ["taken.com", "unavailable"],
      ["name.co.uk", "available"],
      ["www.example.com", "invalid"],
      ["nope.org", "unsupported"],
      ["bad..name", "invalid"],
      ["ejemplo.ox", "invalid"],
    ]);
    const coUk = answers.find((a) => a.input === "name.co.uk");
    expect(coUk?.name).toEqual({ ascii: "name.co.uk", unicode: "name.co.uk", sld: "name", suffix: "co.uk" });
  });

  test("a quote pins cost, itemized fees and renewal price in integer minor units", async () => {
    const catalog = new Catalog(db, memoryRegistry(state));
    const quote = await catalog.quoteRegistration(account, ownerId, "Pinned.COM.", 2, readOnlyCall("test"));
    expect(quote.asciiName).toBe("pinned.com");
    expect(quote.costMinor).toBe(2198n);
    expect(quote.feesMinor).toBe(20n);
    expect(quote.priceMinor).toBe(2218n);
    expect(quote.renewalPriceMinor).toBe(1299n);
    expect(quote.providerAccountId).toBe(account.id);
  });

  test("an extension needing extended attributes is refused rather than half-registered", async () => {
    const catalog = new Catalog(db, memoryRegistry(state));
    await expect(catalog.quoteRegistration(account, ownerId, "nexus.us", 1, readOnlyCall("test"))).rejects.toMatchObject({
      code: "unsupported",
    });
  });
});

describe("orders", () => {
  test("without an approved payment mechanism nothing is written", async () => {
    const catalog = new Catalog(db, memoryRegistry(state));
    const quote = await catalog.quoteRegistration(account, ownerId, "unpaid.com", 1, readOnlyCall("test"));
    await expect(
      placeOrder(db, unconfiguredPayments, { ownerId, quoteIds: [quote.id], idempotencyKey: "unpaid-order-1", contacts: CONTACTS, privacy: false, actor: { kind: "system" as const } }),
    ).rejects.toBeInstanceOf(PaymentsNotConfiguredError);
    expect(await db.select().from(orders).where(eq(orders.ownerId, ownerId))).toHaveLength(0);
    expect(await db.select().from(publicDomains).where(eq(publicDomains.ownerId, ownerId))).toHaveLength(0);
    const [unconsumed] = await db.select().from(quotes).where(eq(quotes.id, quote.id));
    expect(unconsumed.consumedAt).toBeNull();
  });

  test("the sandbox authorizer refuses a production account", async () => {
    const production = await createAccount(db, { environment: "production" });
    const catalog = new Catalog(db, memoryRegistry(state));
    const quote = await catalog.quoteRegistration(production, ownerId, "prod.com", 1, readOnlyCall("test"));
    await expect(
      placeOrder(db, sandboxNoCharge, { ownerId, quoteIds: [quote.id], idempotencyKey: "prod-order-01", contacts: CONTACTS, privacy: false, actor: { kind: "system" as const } }),
    ).rejects.toBeInstanceOf(PaymentsNotConfiguredError);
  });

  test("an order, its line, the pending domain and its operation are written together; a retry returns the same order", async () => {
    const catalog = new Catalog(db, memoryRegistry(state));
    const quote = await catalog.quoteRegistration(account, ownerId, "atomic.com", 1, readOnlyCall("test"));
    const request = { ownerId, quoteIds: [quote.id], idempotencyKey: "atomic-order-1", contacts: CONTACTS, privacy: false, actor: { kind: "system" as const } };

    const first = await placeOrder(db, sandboxNoCharge, request);
    const retry = await placeOrder(db, sandboxNoCharge, request);
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.order.id).toBe(first.order.id);

    const ops = await db.select().from(operations).where(eq(operations.ownerId, ownerId));
    expect(ops).toHaveLength(1);
    expect(ops[0].kind).toBe(OPERATION_KINDS.register);
    // The operation payload never carries contact data.
    expect(JSON.stringify(ops[0].payload)).not.toContain(CONTACTS.registrant.email);

    const other = await catalog.quoteRegistration(account, ownerId, "other.com", 1, readOnlyCall("test"));
    await expect(placeOrder(db, sandboxNoCharge, { ...request, quoteIds: [other.id] })).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  test("the live-name constraint is recognised on the real driver error, so a racing order maps to a conflict", async () => {
    const values = { ownerId, asciiName: "race-name.com", unicodeName: "race-name.com", suffix: "com", providerAccountId: account.id, lifecycle: "pending" as const };
    await db.insert(publicDomains).values(values);
    const err = await db.insert(publicDomains).values(values).catch((e: unknown) => e);
    expect(isUniqueViolation(err, "public_domains_account_name_live_key")).toBe(true);
    expect(isUniqueViolation(err, "some_other_constraint")).toBe(false);
    expect(isUniqueViolation(new Error("plain"), "public_domains_account_name_live_key")).toBe(false);
  });

  test("a consumed quote cannot be sold again under a different key", async () => {
    const catalog = new Catalog(db, memoryRegistry(state));
    const quote = await catalog.quoteRegistration(account, ownerId, "once.com", 1, readOnlyCall("test"));
    await placeOrder(db, sandboxNoCharge, { ownerId, quoteIds: [quote.id], idempotencyKey: "once-order-01", contacts: CONTACTS, privacy: false, actor: { kind: "system" as const } });
    await expect(
      placeOrder(db, sandboxNoCharge, { ownerId, quoteIds: [quote.id], idempotencyKey: "once-order-02", contacts: CONTACTS, privacy: false, actor: { kind: "system" as const } }),
    ).rejects.toBeInstanceOf(QuoteUnusableError);
  });
});

describe("registration fulfilment", () => {
  test("happy path: registered once, dates come from the registrar's sync, order completes", async () => {
    const { operationId, domainId, order } = await orderDomain("happy.com");
    const engine = engineFor(db, state);

    expect(await engine.runOnce()).toBe(true);
    expect((await loadOperation(db, operationId)).status).toBe("succeeded");
    const [afterRegister] = await db.select().from(publicDomains).where(eq(publicDomains.id, domainId));
    expect(afterRegister.lifecycle).toBe("active");
    expect(afterRegister.expiresAt).toBeNull();

    // The follow-up sync is what fills in the registrar's dates.
    expect(await engine.runOnce()).toBe(true);
    const [synced] = await db.select().from(publicDomains).where(eq(publicDomains.id, domainId));
    expect(synced.expiresAt?.getTime()).toBe(state.domains.get("happy.com")?.expiresAt.getTime());

    const [done] = await db.select().from(orders).where(eq(orders.id, order.id));
    expect(done.state).toBe("completed");
    expect(await registerCalls("happy.com")).toBe(1);

    // The trail names what happened, and carries no contact data.
    const trail = await db.select().from(auditEvents).where(inArray(auditEvents.resourceId, [order.id, domainId]));
    expect(trail.map((e) => [e.action, e.outcome]).sort()).toEqual([
      ["operation.domain.register", "succeeded"],
      ["operation.domain.sync", "succeeded"],
      ["order.place", "accepted"],
    ]);
    expect(JSON.stringify(trail)).not.toContain(CONTACTS.registrant.email);
  });

  test("applied then timed out: unknown, then reconciled to succeeded without a second registration", async () => {
    const { operationId, domainId } = await orderDomain("timeout.com");
    state.failNext("register", { mode: "apply_then_timeout" });
    const engine = engineFor(db, state);

    await engine.runOnce();
    const unknown = await loadOperation(db, operationId);
    expect(unknown.status).toBe("unknown");
    expect(unknown.submittedAt).not.toBeNull();

    await makeDue(db, operationId);
    await engine.runOnce();
    expect((await loadOperation(db, operationId)).status).toBe("succeeded");
    expect(await registerCalls("timeout.com")).toBe(1);
    const [domain] = await db.select().from(publicDomains).where(eq(publicDomains.id, domainId));
    expect(domain.remoteId).toBe(state.domains.get("timeout.com")?.remoteId ?? "missing");
  });

  test("a registration that is not visible yet is never sent again: it stays in doubt, then goes to review", async () => {
    const { operationId, line } = await orderDomain("notyet.com");
    state.failNext("register", { mode: "timeout_without_apply" });
    const engine = engineFor(db, state, { maxReconcileAttempts: 3 });

    await engine.runOnce(); // submitted, response lost → unknown
    for (let i = 0; i < 3; i++) {
      await makeDue(db, operationId);
      await engine.runOnce(); // getInfo says "not in this account": undetermined, not absent
    }
    const final = await loadOperation(db, operationId);
    expect(final.status).toBe("manual_review");
    expect(final.resubmissions).toBe(0);
    expect(await registerCalls("notyet.com")).toBe(1);
    const [reviewedLine] = await db.select().from(orderLines).where(eq(orderLines.id, line.id));
    expect(reviewedLine.state).toBe("manual_review");
  });

  test("refused before submission with a retryable error: requeued with backoff, nothing marked submitted", async () => {
    const { operationId } = await orderDomain("ratelimited.com");
    state.failNext("register", { mode: "refuse", code: "rate_limited" });
    const engine = engineFor(db, state);

    await engine.runOnce();
    const op = await loadOperation(db, operationId);
    expect(op.status).toBe("queued");
    expect(op.submittedAt).toBeNull();
    expect(op.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(await engine.runOnce()).toBe(false);
  });

  test("insufficient funds is an operator problem: manual review, domain not marked failed", async () => {
    const { operationId, domainId } = await orderDomain("broke.com");
    state.failNext("register", { mode: "refuse", code: "insufficient_funds" });
    await engineFor(db, state).runOnce();
    expect((await loadOperation(db, operationId)).status).toBe("manual_review");
    const [domain] = await db.select().from(publicDomains).where(eq(publicDomains.id, domainId));
    expect(domain.lifecycle).toBe("unknown");
  });

  test("a failed registration does not block ordering the same name again", async () => {
    const first = await orderDomain("retry-name.com");
    state.failNext("register", { mode: "refuse", code: "validation" });
    await engineFor(db, state).runOnce();
    const [failed] = await db.select().from(publicDomains).where(eq(publicDomains.id, first.domainId));
    expect(failed.lifecycle).toBe("failed");

    const second = await orderDomain("retry-name.com");
    expect(second.domainId).not.toBe(first.domainId);
  });

  test("an operation written for sandbox never acts through a production account", async () => {
    const { operationId } = await orderDomain("envguard.com");
    await db.update(providerAccounts).set({ environment: "production" }).where(eq(providerAccounts.id, account.id));
    await engineFor(db, state).runOnce();
    const op = await loadOperation(db, operationId);
    expect(op.status).toBe("manual_review");
    expect(op.errorCode).toBe("credentials");
    expect(await registerCalls("envguard.com")).toBe(0);
  });

  test("a read-only account keeps syncing but refuses to register", async () => {
    const { operationId } = await orderDomain("paused.com");
    await db.update(providerAccounts).set({ managementMode: "read_only" }).where(eq(providerAccounts.id, account.id));
    await engineFor(db, state).runOnce();
    expect((await loadOperation(db, operationId)).status).toBe("manual_review");
    expect(await registerCalls("paused.com")).toBe(0);
  });
});

describe("renewal reconciliation", () => {
  async function registeredDomainWithRenewal(name: string) {
    const { domainId } = await orderDomain(name);
    const engine = engineFor(db, state);
    await engine.runOnce(); // register
    await engine.runOnce(); // sync
    const [domain] = await db.select().from(publicDomains).where(eq(publicDomains.id, domainId));
    if (!domain.expiresAt) throw new Error("sync did not set an expiry");
    const { operation } = await enqueueOperation(db, {
      kind: OPERATION_KINDS.renew,
      scope: `user:${ownerId}`,
      idempotencyKey: `renew-${domainId}`,
      ownerId,
      resourceType: "public_domain",
      resourceId: domainId,
      providerAccountId: account.id,
      payload: { publicDomainId: domainId, years: 1, previousExpiresAt: domain.expiresAt.toISOString(), maxCostMinor: null, currency: null, environment: "sandbox" },
    });
    return { domainId, operationId: operation.id, previous: domain.expiresAt };
  }
  const renewCalls = () => state.calls.filter((c) => c.method === "renew").length;

  test("absence is not believed before the settle window", async () => {
    const { operationId } = await registeredDomainWithRenewal("settle.com");
    state.failNext("renew", { mode: "timeout_without_apply" });
    const engine = engineFor(db, state, { settleMs: 3_600_000 });

    await engine.runOnce();
    await makeDue(db, operationId);
    await engine.runOnce();
    const op = await loadOperation(db, operationId);
    expect(op.status).toBe("unknown");
    expect(op.resubmissions).toBe(0);
    expect(op.reconcileAttempts).toBe(1);
    expect(renewCalls()).toBe(1);
  });

  test("proven absent: resubmitted exactly once; absent again goes to manual review", async () => {
    const { operationId } = await registeredDomainWithRenewal("absent.com");
    state.failNext("renew", { mode: "timeout_without_apply" });
    state.failNext("renew", { mode: "timeout_without_apply" });
    const engine = engineFor(db, state);

    await engine.runOnce(); // submitted, lost → unknown
    await makeDue(db, operationId);
    await engine.runOnce(); // reconcile: expiry unchanged → queued, resubmissions = 1
    const requeued = await loadOperation(db, operationId);
    expect(requeued.status).toBe("queued");
    expect(requeued.submittedAt).toBeNull();
    expect(requeued.resubmissions).toBe(1);

    await engine.runOnce(); // second submission, lost again → unknown
    await makeDue(db, operationId);
    await engine.runOnce(); // absent again → manual review, never a third attempt
    expect((await loadOperation(db, operationId)).status).toBe("manual_review");
    expect(renewCalls()).toBe(2);
  });

  test("a renewal that applied but timed out is confirmed from the new expiry, not renewed again", async () => {
    const { domainId } = await orderDomain("renewme.com");
    const engine = engineFor(db, state);
    await engine.runOnce(); // register
    await engine.runOnce(); // sync
    const [domain] = await db.select().from(publicDomains).where(eq(publicDomains.id, domainId));
    const previous = domain.expiresAt;
    if (!previous) throw new Error("sync did not set an expiry");

    const { operation } = await enqueueOperation(db, {
      kind: OPERATION_KINDS.renew,
      scope: `user:${ownerId}`,
      idempotencyKey: `renew-${domainId}`,
      ownerId,
      resourceType: "public_domain",
      resourceId: domainId,
      providerAccountId: account.id,
      payload: { publicDomainId: domainId, years: 1, previousExpiresAt: previous.toISOString(), maxCostMinor: null, currency: null, environment: "sandbox" },
    });
    state.failNext("renew", { mode: "apply_then_timeout" });
    await engine.runOnce();
    expect((await loadOperation(db, operation.id)).status).toBe("unknown");
    await makeDue(db, operation.id);
    await engine.runOnce();
    expect((await loadOperation(db, operation.id)).status).toBe("succeeded");
    expect(state.calls.filter((c) => c.method === "renew")).toHaveLength(1);
    const [renewed] = await db.select().from(publicDomains).where(eq(publicDomains.id, domainId));
    expect(renewed.expiresAt?.getUTCFullYear()).toBe(previous.getUTCFullYear() + 1);
  });
});
