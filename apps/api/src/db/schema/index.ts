/**
 * TNP's relational schema.
 *
 * Ported from seven Mongoose models. The data was never document-shaped: every
 * relationship here was already a foreign key wearing an ObjectId, and the one
 * genuine document — a domain's DNS records — was the worst fit of the lot.
 *
 * Naming: columns are declared camelCase and drizzle derives snake_case from
 * `DATABASE_CASING`. See `../casing.ts`.
 */

import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums — values the Mongoose schemas enforced in application code
// ---------------------------------------------------------------------------

export const domainStatus = pgEnum("domain_status", ["active", "pending", "suspended"]);
export const tldStatus = pgEnum("tld_status", ["active", "proposed", "pending"]);
export const proposalStatus = pgEnum("proposal_status", ["open", "approved", "rejected"]);
export const nodeStatus = pgEnum("node_status", ["online", "offline"]);
export const relayStatus = pgEnum("relay_status", ["active", "degraded", "offline"]);
export const relayOperator = pgEnum("relay_operator", ["oxy", "community"]);
export const voteDirection = pgEnum("vote_direction", ["up", "down"]);
export const dnsRecordType = pgEnum("dns_record_type", [
  "A",
  "AAAA",
  "CNAME",
  "TXT",
  "MX",
  "NS",
]);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * A local row per Oxy identity.
 *
 * `oxyUserId` is an external identifier owned by Oxy — it stays a string and is
 * never treated as a local key. It is unique because the whole point of the
 * table is to be the local handle for one Oxy account.
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    oxyUserId: text("oxy_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("users_oxy_user_id_key").on(table.oxyUserId)],
);

// ---------------------------------------------------------------------------
// TLDs
// ---------------------------------------------------------------------------

export const tlds = pgTable(
  "tlds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    status: tldStatus("status").notNull().default("proposed"),
    /**
     * Vestigial. It used to distinguish a TNP-native TLD from one TNP mirrored
     * from the public root; reserved TLDs are now refused everywhere
     * (`@tnp/namespace`), so every row is native and this is always true. Kept
     * for one release so the web dashboard's reads do not break, and tracked
     * for removal in docs/architecture/migration.md.
     */
    custom: boolean("custom").notNull().default(true),
    proposedById: uuid("proposed_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("tlds_name_key").on(table.name)],
);

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export const domains = pgTable(
  "domains",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    tld: text("tld").notNull(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    oxyUserId: text("oxy_user_id").notNull(),
    status: domainStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (table) => [
    // A real constraint, where Mongoose had an application-level unique index.
    uniqueIndex("domains_name_tld_key").on(table.name, table.tld),
    index("domains_oxy_user_id_idx").on(table.oxyUserId),
    index("domains_owner_id_idx").on(table.ownerId),
  ],
);

/**
 * DNS records.
 *
 * This is the change that matters most in the port. Records were a Mongoose
 * subdocument array on the domain, so answering `GET /dns/resolve` meant
 * loading the whole domain and scanning its records in application code — on
 * the hot path of every TNP name lookup. As a table with a composite index,
 * the same question is an index lookup.
 *
 * `value` is deliberately untyped text: it holds an IPv4 literal, an IPv6
 * literal, a hostname or a TXT string depending on `type`, and the resolver
 * validates per type when it builds the wire answer.
 */
export const dnsRecords = pgTable(
  "dns_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    type: dnsRecordType("type").notNull(),
    /** Subdomain label, or `@` for the apex — the shape the resolver queries by. */
    name: text("name").notNull().default("@"),
    value: text("value").notNull(),
    ttl: integer("ttl").notNull().default(3600),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Covers the resolve path: records for a domain, filtered by label and type.
    index("dns_records_lookup_idx").on(table.domainId, table.name, table.type),
  ],
);

// ---------------------------------------------------------------------------
// Service nodes
// ---------------------------------------------------------------------------

/**
 * One service node per domain, so the foreign key is unique rather than the
 * 1:1-by-convention the Mongoose model relied on.
 */
export const serviceNodes = pgTable(
  "service_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    domainId: uuid("domain_id")
      .notNull()
      .references(() => domains.id, { onDelete: "cascade" }),
    oxyUserId: text("oxy_user_id").notNull(),
    publicKey: text("public_key").notNull(),
    connectedRelay: text("connected_relay").notNull().default(""),
    status: nodeStatus("status").notNull().default("offline"),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("service_nodes_domain_id_key").on(table.domainId),
    index("service_nodes_oxy_user_id_idx").on(table.oxyUserId),
  ],
);

// ---------------------------------------------------------------------------
// Relays
// ---------------------------------------------------------------------------

export const relays = pgTable(
  "relays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    endpoint: text("endpoint").notNull(),
    publicKey: text("public_key").notNull(),
    operator: relayOperator("operator").notNull(),
    operatorUserId: text("operator_user_id").notNull(),
    maxConnections: integer("max_connections").notNull(),
    bandwidth: integer("bandwidth").notNull(),
    location: text("location").notNull().default(""),
    status: relayStatus("status").notNull().default("offline"),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("relays_endpoint_key").on(table.endpoint),
    index("relays_operator_user_id_idx").on(table.operatorUserId),
  ],
);

// ---------------------------------------------------------------------------
// TLD proposals and votes
// ---------------------------------------------------------------------------

export const tldProposals = pgTable("tld_proposals", {
  id: uuid("id").primaryKey().defaultRandom(),
  tld: text("tld").notNull(),
  proposedById: uuid("proposed_by_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  status: proposalStatus("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One vote per user per proposal.
 *
 * The unique constraint replaces a `findOneAndUpdate(..., { upsert: true })`
 * that enforced the same rule in application code — where two concurrent votes
 * could both pass the check and both insert.
 */
export const votes = pgTable(
  "votes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => tldProposals.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    direction: voteDirection("direction").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("votes_proposal_user_key").on(table.proposalId, table.userId),
    index("votes_proposal_id_idx").on(table.proposalId),
  ],
);

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  domains: many(domains),
  proposals: many(tldProposals),
  votes: many(votes),
}));

export const domainsRelations = relations(domains, ({ one, many }) => ({
  owner: one(users, { fields: [domains.ownerId], references: [users.id] }),
  records: many(dnsRecords),
  serviceNode: one(serviceNodes),
}));

export const dnsRecordsRelations = relations(dnsRecords, ({ one }) => ({
  domain: one(domains, { fields: [dnsRecords.domainId], references: [domains.id] }),
}));

export const serviceNodesRelations = relations(serviceNodes, ({ one }) => ({
  domain: one(domains, { fields: [serviceNodes.domainId], references: [domains.id] }),
}));

export const tldProposalsRelations = relations(tldProposals, ({ one, many }) => ({
  proposedBy: one(users, { fields: [tldProposals.proposedById], references: [users.id] }),
  votes: many(votes),
}));

export const votesRelations = relations(votes, ({ one }) => ({
  proposal: one(tldProposals, { fields: [votes.proposalId], references: [tldProposals.id] }),
  user: one(users, { fields: [votes.userId], references: [users.id] }),
}));

/** `now()` at statement time, for explicit `updatedAt` bumps on update. */
export const now = sql`now()`;
