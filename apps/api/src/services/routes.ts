/**
 * `/services` — the optional public-domain and DNS routes.
 *
 * Mounted unconditionally so a client can ask `/services/status`, but every
 * action checks its own flag, and nothing provider-related is constructed
 * until a flagged route actually needs it: with every flag off, starting the
 * API never touches an adapter, a secret or a provider account.
 *
 * Authorization is per resource: a domain id in the path is only ever looked
 * up together with the caller's own user id. Provider account ids, remote ids
 * and prices are never taken from the request.
 */

import { Router, type Request, type Response } from "express";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { getRequiredOxyUserId, requireOxyAuth } from "@oxy.so/core/server";
import {
  parseAvailabilityNames,
  parsePlaceOrderRequest,
  parseQuoteRequest,
  parseZoneApplyRequest,
  parseZoneChanges,
  type OperationDto,
  type OwnedPublicDomain,
  type OwnedPublicDomainPage,
  type PublicAvailabilityResponse,
  type QuoteDto,
  type ServicesStatus,
  type ZoneApplyResponse,
  type ZonePreviewResponse,
  type ZoneRecordDto,
} from "@tnp/shared-types";
import type { Database } from "../db/postgres.js";
import { dnsZones, operations, providerAccounts, publicDomains, users } from "../db/schema/index.js";
import { Catalog, readOnlyCall } from "./catalog.js";
import type { ServicesConfig } from "./config.js";
import { diffZones, hashZone, mergeZoneChanges, type ZoneChange } from "./dns/zone.js";
import { toMoneyDto } from "./money.js";
import { domainName, OPERATION_KINDS } from "./operations/handlers.js";
import { canonicalJson, IdempotencyConflictError, isValidIdempotencyKey } from "./operations/intent.js";
import { enqueueOperation, type Operation } from "./operations/store.js";
import {
  PaymentsNotConfiguredError,
  placeOrder,
  QuoteUnusableError,
  unconfiguredPayments,
  type PaymentAuthorizer,
  type QuoteRow,
} from "./orders.js";
import { assertAccountUsable, loadProviderAccount, selectSellingAccount, toAccountConfig } from "./providers/accounts.js";
import type { Zone, ZoneRecord } from "./providers/contracts.js";
import { isProviderError, ProviderError, type ProviderErrorCode } from "./providers/errors.js";
import { createProductionRegistry } from "./providers/production.js";
import type { ProviderRegistry } from "./providers/registry.js";

export interface ServicesRouterOptions {
  readonly config: ServicesConfig;
  readonly getDb: () => Database;
  /** Built on first use, never at startup. */
  readonly registry: () => ProviderRegistry;
  readonly payments: PaymentAuthorizer;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_BY_CODE: Readonly<Record<ProviderErrorCode, number>> = {
  validation: 400,
  not_available: 409,
  unsupported: 422,
  credentials: 503,
  rate_limited: 429,
  insufficient_funds: 503,
  conflict: 409,
  not_found: 404,
  permanent: 502,
  provider_unavailable: 503,
  unknown_outcome: 502,
};

function sendError(res: Response, err: unknown, context: string): void {
  if (isProviderError(err)) {
    if (err.code === "credentials" || err.code === "insufficient_funds") {
      // Operator problems: logged in full, shown to the customer as unavailability.
      console.error(`[services] ${context}: ${err.code}: ${err.message}`);
    }
    res.status(STATUS_BY_CODE[err.code]).json({ error: err.code, message: err.safeMessage });
    return;
  }
  if (err instanceof IdempotencyConflictError) {
    res.status(409).json({ error: "idempotency_conflict", message: "This request key was already used for a different request." });
    return;
  }
  if (err instanceof QuoteUnusableError) {
    res.status(409).json({ error: `quote_${err.reason}`, message: "The quote can no longer be ordered. Request a new one." });
    return;
  }
  if (err instanceof PaymentsNotConfiguredError) {
    res.status(503).json({ error: "payments_not_configured", message: "Purchases are not available yet." });
    return;
  }
  console.error(`[services] ${context}:`, err);
  res.status(500).json({ error: "internal", message: "Something went wrong." });
}

function disabled(res: Response, feature: string): void {
  res.status(403).json({ error: "feature_disabled", message: `${feature} is not enabled.` });
}

/**
 * A crude per-process, per-user budget for provider-backed reads. The shared
 * provider quota is the real limit; this only stops one account from spending
 * it all.
 */
function createUserBudget(perMinute: number) {
  const hits = new Map<string, number[]>();
  return (userId: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(userId) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) {
      hits.set(userId, recent);
      return false;
    }
    recent.push(now);
    hits.set(userId, recent);
    if (hits.size > 10_000) hits.clear();
    return true;
  };
}

async function ownerIdFor(db: Database, oxyUserId: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ oxyUserId })
    .onConflictDoUpdate({ target: users.oxyUserId, set: { updatedAt: sql`now()` } })
    .returning({ id: users.id });
  return row.id;
}

export function serializeOperation(op: Operation): OperationDto {
  return {
    id: op.id,
    kind: op.kind,
    status: op.status,
    attempts: op.attempts,
    errorCode: op.errorCode,
    errorMessage: op.errorMessage,
    createdAt: op.createdAt.toISOString(),
    updatedAt: op.updatedAt.toISOString(),
    completedAt: op.completedAt?.toISOString() ?? null,
  };
}

export function serializeQuote(quote: QuoteRow): QuoteDto {
  return {
    id: quote.id,
    name: quote.asciiName,
    displayName: quote.unicodeName,
    operation: quote.operation,
    years: quote.years,
    price: toMoneyDto({ currency: quote.currency, minor: quote.priceMinor }),
    fees: toMoneyDto({ currency: quote.currency, minor: quote.feesMinor }),
    renewalPrice:
      quote.renewalPriceMinor === null ? null : toMoneyDto({ currency: quote.currency, minor: quote.renewalPriceMinor }),
    premium: quote.premium,
    expiresAt: quote.expiresAt.toISOString(),
  };
}

function toRecordDto(record: ZoneRecord): ZoneRecordDto {
  return { host: record.host, type: record.type, value: record.value, ttl: record.ttl, priority: record.priority };
}

function idempotencyKey(req: Request): string | null {
  const key = req.header("Idempotency-Key");
  return isValidIdempotencyKey(key) ? key : null;
}

/**
 * The router `index.ts` mounts: production adapters, built lazily, and the
 * refusing payment authorizer until a payment mechanism is approved.
 */
export function createProductionServicesRouter(config: ServicesConfig, getDb: () => Database): Router {
  let registry: ProviderRegistry | null = null;
  return createServicesRouter({
    config,
    getDb,
    registry: () => (registry ??= createProductionRegistry(getDb())),
    payments: unconfiguredPayments,
  });
}

export function createServicesRouter(options: ServicesRouterOptions): Router {
  const { config } = options;
  const router = Router();
  const searchBudget = createUserBudget(20);
  let catalog: Catalog | null = null;
  const getCatalog = () => (catalog ??= new Catalog(options.getDb(), options.registry()));

  router.get("/status", (_req, res) => {
    const status: ServicesStatus = {
      catalog: config.catalog,
      dnsWrite: config.dnsWrite,
      renewals: config.renewals,
      // No payment mechanism is approved (services.md §8), so nothing is
      // purchasable regardless of the sales flag.
      purchasable: false,
      purchaseBlockedReason: config.sales ? "payments_not_configured" : "sales_disabled",
    };
    res.json(status);
  });

  router.get("/domains/availability", requireOxyAuth, async (req, res) => {
    if (!config.catalog) return disabled(res, "Domain search");
    const names = parseAvailabilityNames(req.query.name);
    if (!names.ok) {
      res.status(400).json({ error: "validation", message: names.error });
      return;
    }
    try {
      if (!searchBudget(getRequiredOxyUserId(req))) {
        res.status(429).json({ error: "rate_limited", message: "Too many searches. Try again in a minute." });
        return;
      }
      const db = options.getDb();
      const account = await selectSellingAccount(db, config.environment);
      if (!account) {
        const response: PublicAvailabilityResponse = {
          results: names.value.map((input) => ({ input, name: null, displayName: null, status: "unsupported", premium: false, detail: "No provider is selling domains right now." })),
          notice: "availability_is_not_a_reservation",
        };
        res.json(response);
        return;
      }
      const answers = await getCatalog().checkAvailability(account, names.value, readOnlyCall(crypto.randomUUID()));
      const response: PublicAvailabilityResponse = {
        results: answers.map((a) => ({
          input: a.input,
          name: a.name?.ascii ?? null,
          displayName: a.name?.unicode ?? null,
          status: a.status,
          premium: a.premium,
          detail: a.detail ?? null,
        })),
        notice: "availability_is_not_a_reservation",
      };
      res.json(response);
    } catch (err) {
      sendError(res, err, "availability");
    }
  });

  router.post("/quotes", requireOxyAuth, async (req, res) => {
    if (!config.catalog) return disabled(res, "Quotes");
    const parsed = parseQuoteRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: "validation", message: parsed.error });
      return;
    }
    try {
      const db = options.getDb();
      const account = await selectSellingAccount(db, config.environment);
      if (!account) throw new ProviderError("not_available", "no selling account", { safeMessage: "No provider is selling domains right now." });
      const ownerId = await ownerIdFor(db, getRequiredOxyUserId(req));
      const quote = await getCatalog().quoteRegistration(account, ownerId, parsed.value.name, parsed.value.years, readOnlyCall(crypto.randomUUID()));
      res.status(201).json(serializeQuote(quote));
    } catch (err) {
      sendError(res, err, "quote");
    }
  });

  router.post("/orders", requireOxyAuth, async (req, res) => {
    if (!config.sales) return disabled(res, "Purchasing");
    const key = idempotencyKey(req);
    if (!key) {
      res.status(400).json({ error: "validation", message: "An Idempotency-Key header (8–128 characters) is required." });
      return;
    }
    const parsed = parsePlaceOrderRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: "validation", message: parsed.error });
      return;
    }
    try {
      const db = options.getDb();
      const ownerId = await ownerIdFor(db, getRequiredOxyUserId(req));
      const contact = parsed.value.contact;
      const placed = await placeOrder(db, options.payments, {
        ownerId,
        quoteIds: parsed.value.quoteIds,
        idempotencyKey: key,
        contacts: { registrant: contact, admin: contact, tech: contact, billing: contact },
        privacy: parsed.value.privacy,
      });
      res.status(placed.created ? 201 : 200).json({ id: placed.order.id, state: placed.order.state });
    } catch (err) {
      sendError(res, err, "order");
    }
  });

  router.get("/domains", requireOxyAuth, async (req, res) => {
    try {
      const db = options.getDb();
      const page = Math.max(1, Number.parseInt(String(req.query.page), 10) || 1);
      const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit), 10) || 25));
      const ownerId = await ownerIdFor(db, getRequiredOxyUserId(req));

      const [rows, [{ total }]] = await Promise.all([
        db
          .select({ domain: publicDomains, account: providerAccounts, zone: dnsZones })
          .from(publicDomains)
          .innerJoin(providerAccounts, eq(providerAccounts.id, publicDomains.providerAccountId))
          .leftJoin(dnsZones, eq(dnsZones.publicDomainId, publicDomains.id))
          .where(eq(publicDomains.ownerId, ownerId))
          .orderBy(desc(publicDomains.createdAt))
          .limit(limit)
          .offset((page - 1) * limit),
        db.select({ total: count() }).from(publicDomains).where(eq(publicDomains.ownerId, ownerId)),
      ]);

      const body: OwnedPublicDomainPage = {
        domains: rows.map(({ domain, account, zone }) => serializeOwnedDomain(domain, account, zone)),
        total,
        page,
        pages: Math.ceil(total / limit),
      };
      res.json(body);
    } catch (err) {
      sendError(res, err, "inventory");
    }
  });

  async function ownedDomain(req: Request<{ id: string }>, res: Response) {
    if (!UUID_RE.test(req.params.id)) {
      res.status(404).json({ error: "not_found", message: "Domain not found." });
      return null;
    }
    const db = options.getDb();
    const ownerId = await ownerIdFor(db, getRequiredOxyUserId(req));
    const [row] = await db
      .select({ domain: publicDomains, account: providerAccounts, zone: dnsZones })
      .from(publicDomains)
      .innerJoin(providerAccounts, eq(providerAccounts.id, publicDomains.providerAccountId))
      .leftJoin(dnsZones, eq(dnsZones.publicDomainId, publicDomains.id))
      // Owner in the predicate: another user's id is indistinguishable from a missing one.
      .where(and(eq(publicDomains.id, req.params.id), eq(publicDomains.ownerId, ownerId)))
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "not_found", message: "Domain not found." });
      return null;
    }
    return { db, ownerId, ...row };
  }

  router.get("/domains/:id", requireOxyAuth, async (req: Request<{ id: string }>, res) => {
    try {
      const owned = await ownedDomain(req, res);
      if (!owned) return;
      res.json(serializeOwnedDomain(owned.domain, owned.account, owned.zone));
    } catch (err) {
      sendError(res, err, "domain");
    }
  });

  router.get("/domains/:id/operations", requireOxyAuth, async (req: Request<{ id: string }>, res) => {
    try {
      const owned = await ownedDomain(req, res);
      if (!owned) return;
      const resourceIds = [owned.domain.id, ...(owned.zone ? [owned.zone.id] : [])];
      const rows = await owned.db
        .select()
        .from(operations)
        .where(sql`${operations.resourceId} in (${sql.join(resourceIds.map((id) => sql`${id}::uuid`), sql`, `)})`)
        .orderBy(desc(operations.createdAt))
        .limit(50);
      res.json(rows.map(serializeOperation));
    } catch (err) {
      sendError(res, err, "operations");
    }
  });

  async function zoneContext(req: Request<{ id: string }>, res: Response) {
    const owned = await ownedDomain(req, res);
    if (!owned) return null;
    if (!owned.zone || owned.zone.authority !== "provider" || !owned.zone.providerAccountId) {
      res.status(422).json({ error: "unsupported", message: "This zone is managed outside TNP. Edit it where it is hosted." });
      return null;
    }
    const account = await loadProviderAccount(owned.db, owned.zone.providerAccountId);
    assertAccountUsable(account, "write");
    const dns = options.registry().dns(toAccountConfig(account));
    return { ...owned, zone: owned.zone, account, dns };
  }

  router.post("/domains/:id/zone/preview", requireOxyAuth, async (req: Request<{ id: string }>, res) => {
    if (!config.dnsWrite) return disabled(res, "DNS editing");
    const changes = parseZoneChanges(req.body);
    if (!changes.ok) {
      res.status(400).json({ error: "validation", message: changes.error });
      return;
    }
    try {
      const ctx = await zoneContext(req, res);
      if (!ctx) return;
      const remote: Zone = await ctx.dns.readZone(readOnlyCall(crypto.randomUUID()), domainName(ctx.domain));
      const merged = mergeZoneChanges(remote, changes.value as ZoneChange[], ctx.dns.supportedRecordTypes);
      if (!merged.ok) {
        res.status(400).json({ error: "validation", message: merged.error });
        return;
      }
      const diff = diffZones(remote, merged.zone);
      const body: ZonePreviewResponse = {
        baseHash: hashZone(remote),
        current: remote.records.map(toRecordDto),
        proposed: merged.zone.records.map(toRecordDto),
        added: diff.added.map(toRecordDto),
        removed: diff.removed.map(toRecordDto),
        notice: "provider_panel_edits_can_race",
      };
      res.json(body);
    } catch (err) {
      sendError(res, err, "zone preview");
    }
  });

  router.post("/domains/:id/zone/changes", requireOxyAuth, async (req: Request<{ id: string }>, res) => {
    if (!config.dnsWrite) return disabled(res, "DNS editing");
    const key = idempotencyKey(req);
    if (!key) {
      res.status(400).json({ error: "validation", message: "An Idempotency-Key header (8–128 characters) is required." });
      return;
    }
    const parsed = parseZoneApplyRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: "validation", message: parsed.error });
      return;
    }
    try {
      const ctx = await zoneContext(req, res);
      if (!ctx) return;
      const scope = `user:${ctx.ownerId}`;
      const operation = await ctx.db.transaction(async (tx) => {
        // A retry of the same request returns the original operation. Checked
        // before the version bump, because the bumped version is part of the
        // intent and would make a genuine retry look like a new request.
        const [original] = await tx
          .select()
          .from(operations)
          .where(and(eq(operations.idempotencyScope, scope), eq(operations.idempotencyKey, key)))
          .limit(1);
        if (original) {
          const same =
            original.kind === OPERATION_KINDS.dnsApply &&
            original.resourceId === ctx.zone.id &&
            original.payload.baseHash === parsed.value.baseHash &&
            canonicalJson(original.payload.changes) === canonicalJson(parsed.value.changes);
          if (!same) throw new IdempotencyConflictError(key);
          return original;
        }

        const [zone] = await tx
          .update(dnsZones)
          .set({ desiredVersion: sql`${dnsZones.desiredVersion} + 1`, state: "pending", updatedAt: sql`now()` })
          .where(eq(dnsZones.id, ctx.zone.id))
          .returning({ desiredVersion: dnsZones.desiredVersion });
        const { operation: op } = await enqueueOperation(tx, {
          kind: OPERATION_KINDS.dnsApply,
          scope,
          idempotencyKey: key,
          ownerId: ctx.ownerId,
          resourceType: "dns_zone",
          resourceId: ctx.zone.id,
          providerAccountId: ctx.account.id,
          payload: {
            zoneId: ctx.zone.id,
            baseHash: parsed.value.baseHash,
            changes: parsed.value.changes,
            environment: ctx.account.environment,
            desiredVersion: zone.desiredVersion,
          },
        });
        return op;
      });
      const body: ZoneApplyResponse = { operation: serializeOperation(operation) };
      res.status(202).json(body);
    } catch (err) {
      sendError(res, err, "zone apply");
    }
  });

  return router;
}

function serializeOwnedDomain(
  domain: typeof publicDomains.$inferSelect,
  account: typeof providerAccounts.$inferSelect,
  zone: typeof dnsZones.$inferSelect | null,
): OwnedPublicDomain {
  return {
    id: domain.id,
    name: domain.asciiName,
    displayName: domain.unicodeName,
    namespace: "public-dns",
    provider: { adapter: account.adapter, environment: account.environment },
    lifecycle: domain.lifecycle,
    expiresAt: domain.expiresAt?.toISOString() ?? null,
    locked: domain.locked,
    renewalOwner: domain.renewalOwner,
    lastSyncedAt: domain.lastSyncedAt?.toISOString() ?? null,
    zone: zone
      ? { authority: zone.authority, state: zone.state, lastVerifiedAt: zone.lastVerifiedAt?.toISOString() ?? null }
      : null,
    createdAt: domain.createdAt.toISOString(),
  };
}
