/**
 * `/services` over real HTTP, real PostgreSQL and the in-memory provider.
 * Authentication is stubbed to a header so two users can be exercised.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import type { OxyAuthRequest } from "@oxy.so/core/server";
import type { Database } from "../src/db/postgres.js";
import { dnsZones, orders, providerAccounts, publicDomains, users } from "../src/db/schema/index.js";
import type {
  OperationDto,
  OwnedPublicDomainPage,
  PublicAvailabilityResponse,
  QuoteDto,
  ServicesStatus,
  ZoneApplyResponse,
  ZonePreviewResponse,
} from "@tnp/shared-types";
import { readServicesConfig, type ServicesConfig } from "../src/services/config.js";
import { unconfiguredPayments } from "../src/services/orders.js";
import { createServicesRouter } from "../src/services/routes.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";
import { CONTACT, CONTACTS, createAccount, MemoryProviderState, memoryRegistry } from "./servicesFixtures.js";

let t: TestDatabase;
let db: Database;
const servers: Server[] = [];
const state = new MemoryProviderState();

async function serve(config: ServicesConfig): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = req.header("x-test-user");
    if (user) (req as OxyAuthRequest).userId = user;
    next();
  });
  const registry = memoryRegistry(state);
  app.use("/services", createServicesRouter({ config, getDb: () => db, registry: () => registry, payments: unconfiguredPayments }));
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}/services`;
}

async function call(base: string, path: string, init: { method?: string; user?: string; body?: unknown; key?: string } = {}) {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(init.user ? { "x-test-user": init.user } : {}),
      ...(init.key ? { "Idempotency-Key": init.key } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body: unknown = await res.json().catch(() => null);
  // Typed by the caller: each assertion names the contract it expects back.
  return { status: res.status, json: <T,>() => body as T, body: body as { error?: string; message?: string } };
}

const allOff = readServicesConfig({});
const allOn: ServicesConfig = { ...allOff, catalog: true, sales: true, dnsWrite: true, worker: true };

let off: string;
let on: string;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  await createAccount(db, { label: "selling" });
  off = await serve(allOff);
  on = await serve(allOn);
});

afterAll(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  await t.drop();
});

describe("with every flag off", () => {
  test("status says so and nothing is purchasable", async () => {
    const res = await call(off, "/status");
    expect(res.json<ServicesStatus>()).toEqual({ catalog: false, dnsWrite: false, purchasable: false, purchaseBlockedReason: "sales_disabled" });
  });

  test("search, quotes, orders and zone edits are refused without touching the provider", async () => {
    const before = state.calls.length;
    expect((await call(off, "/domains/availability?name=a.com", { user: "u-off" })).status).toBe(403);
    expect((await call(off, "/quotes", { method: "POST", user: "u-off", body: { name: "a.com" } })).status).toBe(403);
    expect((await call(off, "/orders", { method: "POST", user: "u-off", key: "off-order-key", body: {} })).status).toBe(403);
    expect(state.calls.length).toBe(before);
  });

  test("unauthenticated requests are refused", async () => {
    expect((await call(on, "/domains")).status).toBe(401);
  });
});

describe("with flags on", () => {
  test("availability is honest about each name", async () => {
    const res = await call(on, "/domains/availability?name=fresh.com,nope.org,bad..x", { user: "u-search" });
    expect(res.status).toBe(200);
    const body = res.json<PublicAvailabilityResponse>();
    expect(body.notice).toBe("availability_is_not_a_reservation");
    expect(body.results.map((r) => r.status)).toEqual(["available", "unsupported", "invalid"]);
  });

  test("a quote is returned with money as integer minor-unit strings", async () => {
    const res = await call(on, "/quotes", { method: "POST", user: "u-quote", body: { name: "quoted.com", years: 1 } });
    expect(res.status).toBe(201);
    expect(res.json<QuoteDto>().price).toEqual({ currency: "USD", amountMinor: "1119" });
    expect(res.json<QuoteDto>().renewalPrice).toEqual({ currency: "USD", amountMinor: "1299" });
  });

  test("ordering is refused while payments are not configured, and writes nothing", async () => {
    const quote = await call(on, "/quotes", { method: "POST", user: "u-order", body: { name: "unpaid.com", years: 1 } });
    const res = await call(on, "/orders", {
      method: "POST",
      user: "u-order",
      key: "u-order-key-1",
      body: { quoteIds: [quote.json<QuoteDto>().id], contact: CONTACT, acceptedTerms: true },
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("payments_not_configured");
    const [owner] = await db.select().from(users).where(eq(users.oxyUserId, "u-order"));
    expect(await db.select().from(orders).where(eq(orders.ownerId, owner.id))).toHaveLength(0);
  });

  test("an order needs an idempotency key", async () => {
    const res = await call(on, "/orders", { method: "POST", user: "u-order", body: {} });
    expect(res.status).toBe(400);
  });
});

describe("owned domains and zones", () => {
  let domainId: string;

  beforeAll(async () => {
    const [account] = await db.select().from(providerAccounts).limit(1);
    const [owner] = await db.insert(users).values({ oxyUserId: "u-owner" }).returning();
    const [domain] = await db
      .insert(publicDomains)
      .values({ ownerId: owner.id, asciiName: "owned.com", unicodeName: "owned.com", suffix: "com", providerAccountId: account.id, lifecycle: "active" })
      .returning();
    await db.insert(dnsZones).values({ publicDomainId: domain.id, authority: "provider", providerAccountId: account.id, state: "in_sync" });
    domainId = domain.id;
    state.domains.set("owned.com", {
      remoteId: "mem-owned",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
      locked: true,
      contacts: CONTACTS,
      zone: { records: [{ host: "@", type: "MX", value: "mx.example", ttl: 1800, priority: 10 }], settings: {}, servedByProvider: true },
    });
  });

  test("the owner sees the domain, labelled public DNS, without contacts", async () => {
    const res = await call(on, "/domains", { user: "u-owner" });
    const page = res.json<OwnedPublicDomainPage>();
    expect(page.total).toBe(1);
    expect(page.domains[0].namespace).toBe("public-dns");
    expect(JSON.stringify(page)).not.toContain(CONTACT.email);
  });

  test("another user cannot tell the domain exists", async () => {
    expect((await call(on, `/domains/${domainId}`, { user: "u-intruder" })).status).toBe(404);
    expect((await call(on, `/domains/${domainId}/zone/preview`, { method: "POST", user: "u-intruder", body: { changes: [{ action: "delete", match: { host: "@", type: "MX", value: "mx.example" } }] } })).status).toBe(404);
  });

  test("preview then apply enqueues one operation; a retry returns it; a different body under the key conflicts", async () => {
    const changes = [{ action: "add", record: { host: "www", type: "A", value: "192.0.2.1", ttl: 1800 } }];
    const preview = await call(on, `/domains/${domainId}/zone/preview`, { method: "POST", user: "u-owner", body: { changes } });
    expect(preview.status).toBe(200);
    const previewed = preview.json<ZonePreviewResponse>();
    expect(previewed.added).toHaveLength(1);
    expect(previewed.removed).toHaveLength(0);
    expect(previewed.proposed).toHaveLength(2);

    const apply = { changes, baseHash: previewed.baseHash };
    const first = await call(on, `/domains/${domainId}/zone/changes`, { method: "POST", user: "u-owner", key: "zone-apply-key-1", body: apply });
    const retry = await call(on, `/domains/${domainId}/zone/changes`, { method: "POST", user: "u-owner", key: "zone-apply-key-1", body: apply });
    expect(first.status).toBe(202);
    expect(retry.json<ZoneApplyResponse>().operation.id).toBe(first.json<ZoneApplyResponse>().operation.id);

    const [zone] = await db.select().from(dnsZones).where(eq(dnsZones.publicDomainId, domainId));
    expect(zone.desiredVersion).toBe(1);

    const different = await call(on, `/domains/${domainId}/zone/changes`, {
      method: "POST",
      user: "u-owner",
      key: "zone-apply-key-1",
      body: { ...apply, changes: [{ action: "add", record: { host: "api", type: "A", value: "192.0.2.2", ttl: 1800 } }] },
    });
    expect(different.status).toBe(409);

    // Two identical retries racing each other both get the one operation.
    const racing = { changes: [{ action: "add", record: { host: "race", type: "A", value: "192.0.2.3", ttl: 1800 } }], baseHash: previewed.baseHash };
    const [r1, r2] = await Promise.all([
      call(on, `/domains/${domainId}/zone/changes`, { method: "POST", user: "u-owner", key: "zone-apply-key-2", body: racing }),
      call(on, `/domains/${domainId}/zone/changes`, { method: "POST", user: "u-owner", key: "zone-apply-key-2", body: racing }),
    ]);
    expect([r1.status, r2.status]).toEqual([202, 202]);
    expect(r1.json<ZoneApplyResponse>().operation.id).toBe(r2.json<ZoneApplyResponse>().operation.id);
    const [afterRace] = await db.select().from(dnsZones).where(eq(dnsZones.publicDomainId, domainId));
    expect(afterRace.desiredVersion).toBe(2);

    const ops = await call(on, `/domains/${domainId}/operations`, { user: "u-owner" });
    const list = ops.json<OperationDto[]>();
    expect(list).toHaveLength(2);
    expect(list[0].kind).toBe("dns.apply");
  });
});
