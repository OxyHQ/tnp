/**
 * Tables of the optional services layer (docs/architecture/services.md §4).
 *
 * Nothing in the native registry references these tables and no native query
 * reads them: a public domain is a row here, never in `domains`, and never a
 * TLD in `tlds`. They are split by lifecycle — an order, the operation that
 * fulfils it and the domain it produces change at different times for
 * different reasons — not by the shape of any provider's API.
 *
 * Money is `bigint` minor units with a currency beside it. postgres.js decodes
 * int8 as a string on raw queries; `mode: "bigint"` makes the query builder
 * return `bigint`, and raw SQL in this layer casts explicitly.
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./index.js";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const providerEnvironment = pgEnum("provider_environment", ["sandbox", "production"]);
/** New sales only. Existing resources keep being renewed and supported. */
export const providerSalesState = pgEnum("provider_sales_state", ["enabled", "sales_disabled"]);
export const providerManagementMode = pgEnum("provider_management_mode", [
  "active",
  "read_only",
  "disabled",
]);

export const publicDomainLifecycle = pgEnum("public_domain_lifecycle", [
  "pending",
  "active",
  "expired",
  "redemption",
  "transferring_in",
  "transferred_out",
  "locked_by_registry",
  "failed",
  "unknown",
]);
/** Exactly one party executes a renewal, so a period is never renewed twice. */
export const renewalOwner = pgEnum("renewal_owner", ["none", "tnp", "provider"]);
export const contactRole = pgEnum("contact_role", ["registrant", "admin", "tech", "billing"]);

export const dnsAuthority = pgEnum("dns_authority", ["provider", "external"]);
export const dnsZoneState = pgEnum("dns_zone_state", [
  "unmanaged",
  "in_sync",
  "pending",
  "conflict",
  "unknown",
]);
export const zoneSnapshotSource = pgEnum("zone_snapshot_source", ["observed", "applied"]);

export const quoteOperation = pgEnum("quote_operation", ["register", "renew", "transfer_in"]);
export const orderState = pgEnum("order_state", [
  "awaiting_payment",
  "paid",
  "fulfilling",
  "completed",
  "partially_completed",
  "failed",
  "cancelled",
]);
/** Separate from the order state: a captured payment does not prove fulfilment. */
export const paymentState = pgEnum("payment_state", [
  "none",
  "authorized",
  "captured",
  "refunded",
  "failed",
]);
export const orderLineState = pgEnum("order_line_state", [
  "pending",
  "fulfilling",
  "succeeded",
  "failed",
  "unknown",
  "manual_review",
]);

export const operationStatus = pgEnum("operation_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "unknown",
  "manual_review",
]);

export const auditActorKind = pgEnum("audit_actor_kind", ["user", "system", "support"]);
export const rateWindowKind = pgEnum("rate_window_kind", ["minute", "hour", "day"]);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const money = (name: string) => bigint(name, { mode: "bigint" });

// ---------------------------------------------------------------------------
// Provider accounts
// ---------------------------------------------------------------------------

/**
 * TNP's credentials for one adapter in one environment.
 *
 * `secretRef` is a pointer (`env:NAME`) resolved at call time; a secret value
 * in this table would be readable by anyone with read access to the database.
 * `config` holds only non-secret adapter settings.
 */
export const providerAccounts = pgTable(
  "provider_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adapter: text("adapter").notNull(),
    environment: providerEnvironment("environment").notNull(),
    label: text("label").notNull(),
    salesState: providerSalesState("sales_state").notNull().default("sales_disabled"),
    managementMode: providerManagementMode("management_mode").notNull().default("read_only"),
    secretRef: text("secret_ref"),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("provider_accounts_adapter_env_label_key").on(table.adapter, table.environment, table.label),
    check("provider_accounts_secret_ref_scheme", sql`${table.secretRef} is null or ${table.secretRef} ~ '^env:[A-Z][A-Z0-9_]*$'`),
  ],
);

// ---------------------------------------------------------------------------
// Public domains
// ---------------------------------------------------------------------------

export const publicDomains = pgTable(
  "public_domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Canonical ASCII (Punycode), lower case, no trailing dot. The identity. */
    asciiName: text("ascii_name").notNull(),
    /** For display only. */
    unicodeName: text("unicode_name").notNull(),
    suffix: text("suffix").notNull(),
    providerAccountId: uuid("provider_account_id")
      .notNull()
      .references(() => providerAccounts.id, { onDelete: "restrict" }),
    remoteId: text("remote_id"),
    lifecycle: publicDomainLifecycle("lifecycle").notNull().default("pending"),
    /** The registrar's own status text, kept verbatim beside the normalized one. */
    registrarStatus: text("registrar_status"),
    registeredAt: timestamp("registered_at", { withTimezone: true }),
    /** From the registrar. Never computed locally. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    locked: boolean("locked"),
    privacy: boolean("privacy"),
    renewalOwner: renewalOwner("renewal_owner").notNull().default("none"),
    renewalConsentAt: timestamp("renewal_consent_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("public_domains_account_name_key").on(table.providerAccountId, table.asciiName),
    index("public_domains_owner_idx").on(table.ownerId, table.createdAt),
    index("public_domains_expiry_idx").on(table.expiresAt),
    check(
      "public_domains_ascii_canonical",
      sql`${table.asciiName} = lower(${table.asciiName}) and ${table.asciiName} not like '%.'`,
    ),
    check(
      "public_domains_renewal_consent",
      sql`${table.renewalOwner} <> 'tnp' or ${table.renewalConsentAt} is not null`,
    ),
  ],
);

/**
 * Contacts submitted to the registrar for one domain.
 *
 * Personal data: never serialized into a public DTO, never logged, and read
 * only by the owner's own routes and the fulfilment handlers.
 */
export const domainContacts = pgTable(
  "domain_contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicDomainId: uuid("public_domain_id")
      .notNull()
      .references(() => publicDomains.id, { onDelete: "cascade" }),
    role: contactRole("role").notNull(),
    data: jsonb("data").$type<Record<string, string>>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique("domain_contacts_domain_role_key").on(table.publicDomainId, table.role)],
);

// ---------------------------------------------------------------------------
// DNS zones
// ---------------------------------------------------------------------------

export const dnsZones = pgTable(
  "dns_zones",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    publicDomainId: uuid("public_domain_id")
      .notNull()
      .references(() => publicDomains.id, { onDelete: "cascade" }),
    authority: dnsAuthority("authority").notNull(),
    providerAccountId: uuid("provider_account_id").references(() => providerAccounts.id, {
      onDelete: "restrict",
    }),
    state: dnsZoneState("state").notNull().default("unmanaged"),
    /** Hash of the remote zone the last time TNP read it. */
    observedHash: text("observed_hash"),
    observedAt: timestamp("observed_at", { withTimezone: true }),
    /** Bumped on every accepted change request; `appliedVersion` catches up. */
    desiredVersion: integer("desired_version").notNull().default(0),
    appliedVersion: integer("applied_version").notNull().default(0),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("dns_zones_public_domain_key").on(table.publicDomainId),
    check(
      "dns_zones_provider_authority_has_account",
      sql`${table.authority} <> 'provider' or ${table.providerAccountId} is not null`,
    ),
  ],
);

export const dnsZoneSnapshots = pgTable(
  "dns_zone_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    zoneId: uuid("zone_id")
      .notNull()
      .references(() => dnsZones.id, { onDelete: "cascade" }),
    source: zoneSnapshotSource("source").notNull(),
    hash: text("hash").notNull(),
    zone: jsonb("zone").$type<Record<string, unknown>>().notNull(),
    operationId: uuid("operation_id"),
    createdAt: createdAt(),
  },
  (table) => [index("dns_zone_snapshots_zone_idx").on(table.zoneId, table.createdAt)],
);

// ---------------------------------------------------------------------------
// Quotes and orders
// ---------------------------------------------------------------------------

export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    providerAccountId: uuid("provider_account_id")
      .notNull()
      .references(() => providerAccounts.id, { onDelete: "restrict" }),
    operation: quoteOperation("operation").notNull(),
    asciiName: text("ascii_name").notNull(),
    unicodeName: text("unicode_name").notNull(),
    suffix: text("suffix").notNull(),
    years: integer("years").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    costMinor: money("cost_minor").notNull(),
    feesMinor: money("fees_minor").notNull().default(sql`0`),
    priceMinor: money("price_minor").notNull(),
    renewalPriceMinor: money("renewal_price_minor"),
    premium: boolean("premium").notNull().default(false),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("quotes_owner_idx").on(table.ownerId, table.createdAt),
    check("quotes_years_range", sql`${table.years} between 1 and 10`),
    check(
      "quotes_amounts_non_negative",
      sql`${table.costMinor} >= 0 and ${table.feesMinor} >= 0 and ${table.priceMinor} >= 0`,
    ),
  ],
);

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    state: orderState("state").notNull().default("awaiting_payment"),
    paymentState: paymentState("payment_state").notNull().default("none"),
    /** Reference to the approved payment system's authorization. Never card data. */
    paymentReference: text("payment_reference"),
    currency: char("currency", { length: 3 }).notNull(),
    totalMinor: money("total_minor").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    intentHash: text("intent_hash").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("orders_owner_idempotency_key").on(table.ownerId, table.idempotencyKey),
    index("orders_owner_idx").on(table.ownerId, table.createdAt),
    check("orders_total_non_negative", sql`${table.totalMinor} >= 0`),
  ],
);

export const orderLines = pgTable(
  "order_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    quoteId: uuid("quote_id")
      .notNull()
      .references(() => quotes.id, { onDelete: "restrict" }),
    state: orderLineState("state").notNull().default("pending"),
    priceMinor: money("price_minor").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    publicDomainId: uuid("public_domain_id").references(() => publicDomains.id, {
      onDelete: "set null",
    }),
    operationId: uuid("operation_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // A quote is consumed by exactly one line, so it cannot be charged twice.
    unique("order_lines_quote_key").on(table.quoteId),
    index("order_lines_order_idx").on(table.orderId),
  ],
);

// ---------------------------------------------------------------------------
// Operations — the outbox
// ---------------------------------------------------------------------------

/**
 * A durable intent to change (or read) something at a provider.
 *
 * `submittedAt` is committed before a mutating request is sent. An operation
 * whose lease expired with `submittedAt` set is reconciled, never re-executed:
 * the provider may already have done it.
 */
export const operations = pgTable(
  "operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    /** `user:<uuid>` or `system`. Idempotency keys are unique within a scope. */
    idempotencyScope: text("idempotency_scope").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    intentHash: text("intent_hash").notNull(),
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "restrict" }),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id").notNull(),
    providerAccountId: uuid("provider_account_id").references(() => providerAccounts.id, {
      onDelete: "restrict",
    }),
    /** The intent. Never secrets, never contact data, never EPP codes. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: operationStatus("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    /** How many times a proven-absent mutating operation was sent again. At most once. */
    resubmissions: integer("resubmissions").notNull().default(0),
    reconcileAttempts: integer("reconcile_attempts").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    errorCode: text("error_code"),
    /** Safe text only: the normalized error's `safeMessage`. */
    errorMessage: text("error_message"),
    correlationId: uuid("correlation_id").notNull().defaultRandom(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    unique("operations_idempotency_key").on(table.idempotencyScope, table.idempotencyKey),
    index("operations_claim_idx").on(table.status, table.nextRunAt),
    index("operations_resource_idx").on(table.resourceType, table.resourceId, table.createdAt),
    check("operations_attempts_non_negative", sql`${table.attempts} >= 0`),
    check(
      "operations_lease_consistent",
      sql`(${table.status} = 'running') = (${table.leaseOwner} is not null and ${table.leaseExpiresAt} is not null)`,
    ),
  ],
);

/**
 * At most one running operation per resource, across every worker replica.
 *
 * A unique row rather than an advisory lock: the lease must outlive the
 * claiming transaction (the provider call happens after it commits), and a
 * session-level advisory lock on a pooled connection is released or leaked at
 * the pool's discretion. An expired row is taken over by the next claimer.
 */
export const operationResourceLeases = pgTable("operation_resource_leases", {
  resourceKey: text("resource_key").primaryKey(),
  operationId: uuid("operation_id")
    .notNull()
    .references(() => operations.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

// ---------------------------------------------------------------------------
// Provider quota windows
// ---------------------------------------------------------------------------

export const providerRateWindows = pgTable(
  "provider_rate_windows",
  {
    providerAccountId: uuid("provider_account_id").notNull(),
    window: rateWindowKind("window").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (table) => [
    uniqueIndex("provider_rate_windows_key").on(table.providerAccountId, table.window, table.windowStart),
    // Named explicitly: the derived name is 65 characters and PostgreSQL would
    // silently truncate it, leaving the migration snapshot naming a constraint
    // that does not exist.
    foreignKey({
      name: "provider_rate_windows_account_fk",
      columns: [table.providerAccountId],
      foreignColumns: [providerAccounts.id],
    }).onDelete("cascade"),
  ],
);

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorKind: auditActorKind("actor_kind").notNull(),
    actorOxyUserId: text("actor_oxy_user_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: uuid("resource_id"),
    correlationId: uuid("correlation_id"),
    outcome: text("outcome").notNull(),
    /** Minimized: ids and states, never contact data, codes or payloads. */
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (table) => [
    index("audit_events_resource_idx").on(table.resourceType, table.resourceId, table.createdAt),
    check(
      "audit_events_user_actor_named",
      sql`${table.actorKind} = 'system' or ${table.actorOxyUserId} is not null`,
    ),
  ],
);
