/**
 * Operation handlers for public domains and their zones.
 *
 * Each handler reads its intent from the operation payload and its data from
 * the database at execution time, calls the adapter bound to the resource's
 * own provider account (never another one), and writes back only what the
 * provider reported. Reconciliation looks for positive evidence; "I could not
 * tell" is `undetermined`, never `absent`.
 */

import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../db/postgres.js";
import {
  dnsZones,
  dnsZoneSnapshots,
  domainContacts,
  orderLines,
  publicDomains,
} from "../../db/schema/index.js";
import { hashZone, mergeZoneChanges, type ZoneChange } from "../dns/zone.js";
import type { Money } from "../money.js";
import type { PublicDomainName } from "../publicNames.js";
import { assertAccountUsable, loadProviderAccount, toAccountConfig } from "../providers/accounts.js";
import type {
  Contact,
  ContactSet,
  ProviderEnvironment,
  RemoteDomainInfo,
  Zone,
} from "../providers/contracts.js";
import { isProviderError, ProviderError } from "../providers/errors.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { HandlerContext, OperationHandler, ReconcileOutcome } from "./engine.js";
import { enqueueOperation } from "./store.js";

export const OPERATION_KINDS = {
  register: "domain.register",
  renew: "domain.renew",
  sync: "domain.sync",
  dnsApply: "dns.apply",
} as const;

type PublicDomainRow = typeof publicDomains.$inferSelect;

// ---------------------------------------------------------------------------
// Payload parsing — payloads are JSON from our own writers, but a row written
// by an older release must fail loudly rather than be half-read.
// ---------------------------------------------------------------------------

function field<T>(payload: Record<string, unknown>, key: string, guard: (v: unknown) => v is T): T {
  const value = payload[key];
  if (!guard(value)) throw new ProviderError("validation", `operation payload field ${key} is malformed`);
  return value;
}
const isString = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isEnv = (v: unknown): v is ProviderEnvironment => v === "sandbox" || v === "production";
const isNullableString = (v: unknown): v is string | null => v === null || typeof v === "string";

function maxCost(payload: Record<string, unknown>): Money | null {
  const minor = field(payload, "maxCostMinor", isNullableString);
  const currency = field(payload, "currency", isNullableString);
  return minor === null || currency === null ? null : { currency, minor: BigInt(minor) };
}

// ---------------------------------------------------------------------------
// Shared loading
// ---------------------------------------------------------------------------

async function loadDomain(db: Database, id: string): Promise<PublicDomainRow> {
  const [row] = await db.select().from(publicDomains).where(eq(publicDomains.id, id)).limit(1);
  if (!row) throw new ProviderError("validation", `public domain ${id} does not exist`);
  return row;
}

export function domainName(row: Pick<PublicDomainRow, "asciiName" | "unicodeName" | "suffix">): PublicDomainName {
  return {
    ascii: row.asciiName,
    unicode: row.unicodeName,
    sld: row.asciiName.slice(0, row.asciiName.length - row.suffix.length - 1),
    suffix: row.suffix,
  };
}

/**
 * The adapter for the account a resource is bound to, after the environment
 * guard: an operation written for sandbox never acts through a production
 * account, or the reverse, whatever the row now says.
 */
async function boundAccount(
  ctx: HandlerContext,
  accountId: string,
  use: "read" | "write",
) {
  const expected = field(ctx.operation.payload, "environment", isEnv);
  const row = await loadProviderAccount(ctx.db, accountId);
  if (row.environment !== expected) {
    throw new ProviderError("credentials", `operation for ${expected} bound to a ${row.environment} account`, {
      safeMessage: "This operation targets a different provider environment.",
    });
  }
  assertAccountUsable(row, use);
  return toAccountConfig(row);
}

function applyRemoteInfo(info: RemoteDomainInfo): Partial<typeof publicDomains.$inferInsert> {
  return {
    remoteId: info.remoteId,
    lifecycle: info.lifecycle,
    registrarStatus: info.rawStatus,
    registeredAt: info.createdAt,
    expiresAt: info.expiresAt,
    locked: info.locked,
    privacy: info.privacy,
    lastSyncedAt: new Date(),
    updatedAt: new Date(),
  };
}

async function setLineState(
  db: Database,
  operationId: string,
  state: (typeof orderLines.$inferSelect)["state"],
): Promise<void> {
  const [line] = await db
    .update(orderLines)
    .set({ state, updatedAt: sql`now()` })
    .where(eq(orderLines.operationId, operationId))
    .returning({ orderId: orderLines.orderId });
  if (line) await rollUpOrderState(db, line.orderId);
}

/**
 * Derive the order's state from its lines. An order stays `fulfilling` while
 * any line is unresolved — `unknown` and `manual_review` included, because
 * neither is an outcome yet — and one failed line never undoes a succeeded one.
 */
export async function rollUpOrderState(db: Database, orderId: string): Promise<void> {
  await db.execute(sql`
    update orders set
      state = (
        select case
          when bool_or(l.state in ('pending', 'fulfilling', 'unknown', 'manual_review')) then 'fulfilling'
          when bool_and(l.state = 'succeeded') then 'completed'
          when bool_or(l.state = 'succeeded') then 'partially_completed'
          else 'failed'
        end::order_state
        from order_lines l where l.order_id = ${orderId}
      ),
      updated_at = now()
    where id = ${orderId} and exists (select 1 from order_lines l where l.order_id = ${orderId})
  `);
}

async function loadContacts(db: Database, publicDomainId: string): Promise<ContactSet> {
  const rows = await db.select().from(domainContacts).where(eq(domainContacts.publicDomainId, publicDomainId));
  const byRole = new Map(rows.map((r) => [r.role, r.data]));
  const pick = (role: "registrant" | "admin" | "tech" | "billing"): Contact => {
    const data = byRole.get(role);
    if (!data) throw new ProviderError("validation", `domain ${publicDomainId} has no ${role} contact`);
    return data as unknown as Contact;
  };
  return { registrant: pick("registrant"), admin: pick("admin"), tech: pick("tech"), billing: pick("billing") };
}

async function scheduleSync(ctx: HandlerContext, domain: PublicDomainRow, reason: string): Promise<void> {
  await enqueueOperation(ctx.db, {
    kind: OPERATION_KINDS.sync,
    scope: "system",
    idempotencyKey: `sync:${reason}:${ctx.operation.id}`,
    ownerId: domain.ownerId,
    resourceType: "public_domain",
    resourceId: domain.id,
    providerAccountId: domain.providerAccountId,
    payload: { publicDomainId: domain.id, environment: field(ctx.operation.payload, "environment", isEnv) },
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function createOperationHandlers(registry: ProviderRegistry): OperationHandler[] {
  const register: OperationHandler = {
    kind: OPERATION_KINDS.register,
    mutating: true,
    async execute(ctx) {
      const payload = ctx.operation.payload;
      const domain = await loadDomain(ctx.db, field(payload, "publicDomainId", isString));
      const account = await boundAccount(ctx, domain.providerAccountId, "write");
      const registrar = registry.registrar(account);

      await setLineState(ctx.db, ctx.operation.id, "fulfilling");
      const result = await registrar.register(ctx.call, {
        name: domainName(domain),
        years: field(payload, "years", isInt),
        contacts: await loadContacts(ctx.db, domain.id),
        nameservers: [],
        privacy: payload.privacy === true,
        maxCost: maxCost(payload),
      });

      // Registered. Dates come from the registrar on the follow-up sync, never
      // from `now + years` here.
      await ctx.db
        .update(publicDomains)
        .set({ remoteId: result.remoteId, lifecycle: "active", updatedAt: sql`now()` })
        .where(eq(publicDomains.id, domain.id));
      await setLineState(ctx.db, ctx.operation.id, "succeeded");
      await scheduleSync(ctx, domain, "registered");
      return {
        kind: "succeeded",
        result: {
          remoteId: result.remoteId,
          remoteOrderId: result.remoteOrderId,
          chargedMinor: result.charged?.minor.toString() ?? null,
          currency: result.charged?.currency ?? null,
        },
      };
    },
    async reconcile(ctx): Promise<ReconcileOutcome> {
      const domain = await loadDomain(ctx.db, field(ctx.operation.payload, "publicDomainId", isString));
      const account = await boundAccount(ctx, domain.providerAccountId, "read");
      try {
        const info = await registry.registrar(account).getInfo(ctx.call, domainName(domain));
        await ctx.db.update(publicDomains).set(applyRemoteInfo(info)).where(eq(publicDomains.id, domain.id));
        await setLineState(ctx.db, ctx.operation.id, "succeeded");
        return { kind: "succeeded", result: { reconciled: true, remoteId: info.remoteId } };
      } catch (err) {
        // Only this account's explicit "you do not hold it" is evidence of
        // absence. Anything else leaves the question open.
        if (isProviderError(err) && err.code === "not_found") return { kind: "absent" };
        throw err;
      }
    },
    async onGiveUp(ctx, status) {
      const id = field(ctx.operation.payload, "publicDomainId", isString);
      await ctx.db
        .update(publicDomains)
        .set({ lifecycle: status === "failed" ? "failed" : "unknown", updatedAt: sql`now()` })
        .where(and(eq(publicDomains.id, id), eq(publicDomains.lifecycle, "pending")));
      await setLineState(ctx.db, ctx.operation.id, status === "failed" ? "failed" : "manual_review");
    },
  };

  const renew: OperationHandler = {
    kind: OPERATION_KINDS.renew,
    mutating: true,
    async execute(ctx) {
      const payload = ctx.operation.payload;
      const domain = await loadDomain(ctx.db, field(payload, "publicDomainId", isString));
      const account = await boundAccount(ctx, domain.providerAccountId, "write");
      const result = await registry.registrar(account).renew(ctx.call, {
        name: domainName(domain),
        years: field(payload, "years", isInt),
        maxCost: maxCost(payload),
      });
      if (result.expiresAt) {
        await ctx.db
          .update(publicDomains)
          .set({ expiresAt: result.expiresAt, updatedAt: sql`now()` })
          .where(eq(publicDomains.id, domain.id));
      }
      await setLineState(ctx.db, ctx.operation.id, "succeeded");
      await scheduleSync(ctx, domain, "renewed");
      return { kind: "succeeded", result: { expiresAt: result.expiresAt?.toISOString() ?? null } };
    },
    async reconcile(ctx) {
      const payload = ctx.operation.payload;
      const domain = await loadDomain(ctx.db, field(payload, "publicDomainId", isString));
      const previous = field(payload, "previousExpiresAt", isNullableString);
      if (previous === null) {
        return { kind: "undetermined", message: "No prior expiry to compare against." };
      }
      const account = await boundAccount(ctx, domain.providerAccountId, "read");
      const info = await registry.registrar(account).getInfo(ctx.call, domainName(domain));
      await ctx.db.update(publicDomains).set(applyRemoteInfo(info)).where(eq(publicDomains.id, domain.id));
      if (!info.expiresAt) return { kind: "undetermined", message: "The registrar reported no expiry." };
      const before = new Date(previous).getTime();
      if (info.expiresAt.getTime() > before) {
        await setLineState(ctx.db, ctx.operation.id, "succeeded");
        return { kind: "succeeded", result: { reconciled: true, expiresAt: info.expiresAt.toISOString() } };
      }
      return info.expiresAt.getTime() === before
        ? { kind: "absent" }
        : { kind: "conflict", message: "The registrar reports an earlier expiry than before the renewal." };
    },
    async onGiveUp(ctx, status) {
      await setLineState(ctx.db, ctx.operation.id, status === "failed" ? "failed" : "manual_review");
    },
  };

  const sync: OperationHandler = {
    kind: OPERATION_KINDS.sync,
    mutating: false,
    async execute(ctx) {
      const domain = await loadDomain(ctx.db, field(ctx.operation.payload, "publicDomainId", isString));
      const account = await boundAccount(ctx, domain.providerAccountId, "read");
      try {
        const info = await registry.registrar(account).getInfo(ctx.call, domainName(domain));
        await ctx.db.update(publicDomains).set(applyRemoteInfo(info)).where(eq(publicDomains.id, domain.id));
        return { kind: "succeeded", result: { lifecycle: info.lifecycle } };
      } catch (err) {
        if (!isProviderError(err) || err.code !== "not_found") throw err;
        // The account no longer holds it. That may be a transfer out or a
        // deletion; which one is not something to guess.
        await ctx.db
          .update(publicDomains)
          .set({ lifecycle: "unknown", registrarStatus: "not_in_account", lastSyncedAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(publicDomains.id, domain.id));
        return { kind: "manual_review", code: "not_in_account", message: "The provider account no longer holds this domain." };
      }
    },
  };

  const dnsApply: OperationHandler = {
    kind: OPERATION_KINDS.dnsApply,
    mutating: true,
    async execute(ctx) {
      const payload = ctx.operation.payload;
      const { zone, domain, dns } = await loadZone(ctx, registry, field(payload, "zoneId", isString), "write");
      const baseHash = field(payload, "baseHash", isString);
      const changes = field(payload, "changes", Array.isArray) as ZoneChange[];
      const name = domainName(domain);

      const remote = await dns.readZone(ctx.call, name);
      const remoteHash = hashZone(remote);
      await recordSnapshot(ctx, zone.id, "observed", remote);
      if (remoteHash !== baseHash) {
        await ctx.db
          .update(dnsZones)
          .set({ state: "conflict", observedHash: remoteHash, observedAt: sql`now()`, updatedAt: sql`now()` })
          .where(eq(dnsZones.id, zone.id));
        return { kind: "failed", code: "conflict", message: "The zone changed since it was previewed. Review it again." };
      }
      if (!remote.servedByProvider) {
        return { kind: "failed", code: "unsupported", message: "This provider is not serving the zone, so changes would not be published." };
      }

      const merged = mergeZoneChanges(remote, changes, dns.supportedRecordTypes);
      if (!merged.ok) return { kind: "failed", code: "validation", message: merged.error };

      await dns.replaceZone(ctx.call, name, merged.zone);

      const after = await dns.readZone(ctx.call, name);
      const afterHash = hashZone(after);
      if (afterHash !== hashZone(merged.zone)) {
        return { kind: "unknown", message: "The provider's zone does not match what was sent." };
      }
      await markApplied(ctx, zone.id, after, afterHash, field(payload, "desiredVersion", isInt));
      return { kind: "succeeded", result: { hash: afterHash } };
    },
    async reconcile(ctx) {
      const payload = ctx.operation.payload;
      const { zone, domain, dns } = await loadZone(ctx, registry, field(payload, "zoneId", isString), "read");
      const remote = await dns.readZone(ctx.call, domainName(domain));
      const remoteHash = hashZone(remote);
      const changes = field(payload, "changes", Array.isArray) as ZoneChange[];

      // What the zone would be had our write applied on top of the base we
      // previewed. Recomputed from the base snapshot, not trusted from memory.
      const [base] = await ctx.db
        .select()
        .from(dnsZoneSnapshots)
        .where(and(eq(dnsZoneSnapshots.zoneId, zone.id), eq(dnsZoneSnapshots.hash, field(payload, "baseHash", isString))))
        .limit(1);
      if (!base) return { kind: "undetermined", message: "The previewed zone snapshot is missing." };
      const intended = mergeZoneChanges(base.zone as unknown as Zone, changes, dns.supportedRecordTypes);
      if (!intended.ok) return { kind: "conflict", message: intended.error };

      if (remoteHash === hashZone(intended.zone)) {
        await markApplied(ctx, zone.id, remote, remoteHash, field(payload, "desiredVersion", isInt));
        return { kind: "succeeded", result: { hash: remoteHash, reconciled: true } };
      }
      if (remoteHash === base.hash) return { kind: "absent" };
      await ctx.db
        .update(dnsZones)
        .set({ state: "conflict", observedHash: remoteHash, observedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(dnsZones.id, zone.id));
      return { kind: "conflict", message: "The zone matches neither the previous nor the requested version." };
    },
    async onGiveUp(ctx, status, code) {
      const zoneId = field(ctx.operation.payload, "zoneId", isString);
      await ctx.db
        .update(dnsZones)
        .set({ state: code === "conflict" ? "conflict" : status === "manual_review" ? "unknown" : "in_sync", updatedAt: sql`now()` })
        .where(and(eq(dnsZones.id, zoneId), eq(dnsZones.state, "pending")));
    },
  };

  return [register, renew, sync, dnsApply];
}

async function loadZone(ctx: HandlerContext, registry: ProviderRegistry, zoneId: string, use: "read" | "write") {
  const [zone] = await ctx.db.select().from(dnsZones).where(eq(dnsZones.id, zoneId)).limit(1);
  if (!zone) throw new ProviderError("validation", `zone ${zoneId} does not exist`);
  if (zone.authority !== "provider" || !zone.providerAccountId) {
    throw new ProviderError("unsupported", `zone ${zoneId} is not hosted by an integrated provider`, {
      safeMessage: "This zone is managed outside TNP.",
    });
  }
  const domain = await loadDomain(ctx.db, zone.publicDomainId);
  const account = await boundAccount(ctx, zone.providerAccountId, use);
  return { zone, domain, dns: registry.dns(account) };
}

async function recordSnapshot(ctx: HandlerContext, zoneId: string, source: "observed" | "applied", zone: Zone) {
  await ctx.db.insert(dnsZoneSnapshots).values({
    zoneId,
    source,
    hash: hashZone(zone),
    zone: zone as unknown as Record<string, unknown>,
    operationId: ctx.operation.id,
  });
}

async function markApplied(ctx: HandlerContext, zoneId: string, zone: Zone, hash: string, version: number) {
  await recordSnapshot(ctx, zoneId, "applied", zone);
  await ctx.db
    .update(dnsZones)
    .set({
      observedHash: hash,
      observedAt: sql`now()`,
      lastVerifiedAt: sql`now()`,
      appliedVersion: sql`greatest(${dnsZones.appliedVersion}, ${version})`,
      state: sql`case when ${dnsZones.desiredVersion} <= ${version} then 'in_sync'::dns_zone_state else ${dnsZones.state} end`,
      updatedAt: sql`now()`,
    })
    .where(eq(dnsZones.id, zoneId));
}
