/**
 * TNP's relational schema.
 *
 * The data is relational: every relationship is a foreign key, and a domain's
 * DNS records are their own table rather than a nested document.
 *
 * Naming: columns are declared camelCase and drizzle derives snake_case from
 * `DATABASE_CASING`. See `../casing.ts`.
 */

import { relations, sql } from 'drizzle-orm';
import type {
  DomainKeyRotation,
  Grant,
  KeyAgreementCertificate,
  ServiceRelayBinding,
} from '@tnp/crypto';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const domainStatus = pgEnum('domain_status', ['active', 'pending', 'suspended']);
export const tldStatus = pgEnum('tld_status', ['active', 'proposed', 'pending']);
export const proposalStatus = pgEnum('proposal_status', ['open', 'approved', 'rejected']);
export const nodeStatus = pgEnum('node_status', ['online', 'offline']);
export const relayStatus = pgEnum('relay_status', ['active', 'degraded', 'offline']);
export const relayOperator = pgEnum('relay_operator', ['oxy', 'community']);
export const voteDirection = pgEnum('vote_direction', ['up', 'down']);
export const dnsRecordType = pgEnum('dns_record_type', ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS']);

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
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    oxyUserId: text('oxy_user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_oxy_user_id_key').on(table.oxyUserId)],
);

// ---------------------------------------------------------------------------
// TLDs
// ---------------------------------------------------------------------------

export const tlds = pgTable(
  'tlds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    status: tldStatus('status').notNull().default('proposed'),
    /**
     * Vestigial. It used to distinguish a TNP-native TLD from one TNP mirrored
     * from the public root; reserved TLDs are now refused everywhere
     * (`@tnp/namespace`), so every row is native and this is always true. Kept
     * for one release so the web dashboard's reads do not break, and tracked
     * for removal in docs/architecture/migration.md.
     */
    custom: boolean('custom').notNull().default(true),
    proposedById: uuid('proposed_by_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('tlds_name_key').on(table.name)],
);

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export const domains = pgTable(
  'domains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    tld: text('tld').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    oxyUserId: text('oxy_user_id').notNull(),
    status: domainStatus('status').notNull().default('active'),
    /**
     * Owner-set: kept out of the public directory and search. Resolution and a
     * lookup by exact name are unaffected — this hides a name from browsing,
     * not from anyone who already knows it.
     */
    unlisted: boolean('unlisted').notNull().default(false),
    /**
     * The domain key (Ed25519, canonical base64): the root of every grant
     * chain for this name. Generated on the owner's device; the registry only
     * publishes it. Set once by the owner, and replaced afterwards only by a
     * rotation statement signed by the current key (registry/domainKeys.ts).
     * A name released and registered again inherits the released key through
     * `domain_key_tombstones`: only a rotation signed by that key, or a reset
     * after the hold, which is marked below. Whoever can write this column
     * directly can still change it; clients that pinned the old key refuse.
     */
    domainKey: text('domain_key'),
    /** Rotation statements, oldest first, at most MAX_DOMAIN_KEY_ROTATIONS. */
    domainKeyRotations: jsonb('domain_key_rotations')
      .$type<DomainKeyRotation[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * Set when the current key was accepted WITHOUT a rotation from the key
     * this name had before it was released: the fingerprint of that previous
     * key, and when the reset happened. Published as `keyReset`.
     */
    domainKeyResetFrom: text('domain_key_reset_from'),
    domainKeyResetAt: timestamp('domain_key_reset_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    // A real constraint, not an application-level check.
    uniqueIndex('domains_name_tld_key').on(table.name, table.tld),
    index('domains_oxy_user_id_idx').on(table.oxyUserId),
    index('domains_owner_id_idx').on(table.ownerId),
  ],
);

/**
 * The last domain key of every released name — never deleted.
 *
 * Releasing a name deletes its `domains` row, and with it the domain key. If
 * that were the end of it, an Oxy session (or anyone who compels one) could
 * release a name and register it again to get a "first" key accepted with no
 * signature from the old one: a reset by another route. The tombstone keeps
 * the released key so a re-registration of the same name needs a rotation
 * signed by it, or waits out the reset hold and is marked as a reset.
 */
export const domainKeyTombstones = pgTable(
  'domain_key_tombstones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    tld: text('tld').notNull(),
    domainKey: text('domain_key').notNull(),
    rotations: jsonb('rotations').$type<DomainKeyRotation[]>().notNull().default(sql`'[]'::jsonb`),
    releasedAt: timestamp('released_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('domain_key_tombstones_name_tld_key').on(table.name, table.tld)],
);

/**
 * DNS records.
 *
 * Records are a table, not an array nested in the domain, because
 * `GET /dns/resolve` sits on the hot path of every TNP name lookup: with a
 * composite index, answering it is an index lookup rather than loading the
 * whole domain and scanning its records in application code.
 *
 * `value` is deliberately untyped text: it holds an IPv4 literal, an IPv6
 * literal, a hostname or a TXT string depending on `type`, and the resolver
 * validates per type when it builds the wire answer.
 */
export const dnsRecords = pgTable(
  'dns_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    domainId: uuid('domain_id')
      .notNull()
      .references(() => domains.id, { onDelete: 'cascade' }),
    type: dnsRecordType('type').notNull(),
    /** Subdomain label, or `@` for the apex — the shape the resolver queries by. */
    name: text('name').notNull().default('@'),
    value: text('value').notNull(),
    ttl: integer('ttl').notNull().default(3600),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Covers the resolve path: records for a domain, filtered by label and type.
    index('dns_records_lookup_idx').on(table.domainId, table.name, table.type),
  ],
);

// ---------------------------------------------------------------------------
// Service nodes
// ---------------------------------------------------------------------------

/**
 * One service node per domain, so the foreign key is unique: the 1:1 is a
 * constraint, not a convention.
 */
export const serviceNodes = pgTable(
  'service_nodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    domainId: uuid('domain_id')
      .notNull()
      .references(() => domains.id, { onDelete: 'cascade' }),
    oxyUserId: text('oxy_user_id').notNull(),
    /** The node key (Ed25519, base64): the subject of the chain's leaf grant. */
    publicKey: text('public_key').notNull(),
    /** Grant chain, leaf first, rooted at the domain key. Verified before it is stored. */
    chain: jsonb('chain').$type<Grant[]>().notNull().default(sql`'[]'::jsonb`),
    /** The node's current key-agreement certificate (X25519, at most 7 days). */
    kaCert: jsonb('ka_cert').$type<KeyAgreementCertificate>(),
    connectedRelay: text('connected_relay').notNull().default(''),
    /**
     * The node key's signed statement of which relay it is attached to
     * (`@tnp/crypto` ServiceRelayBinding), from its latest heartbeat. Served in
     * the resolve record; clients verify it. Null for nodes that send none.
     */
    relayBinding: jsonb('relay_binding').$type<ServiceRelayBinding>(),
    status: nodeStatus('status').notNull().default('offline'),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('service_nodes_domain_id_key').on(table.domainId),
    index('service_nodes_oxy_user_id_idx').on(table.oxyUserId),
  ],
);

// ---------------------------------------------------------------------------
// Relays
// ---------------------------------------------------------------------------

export const relays = pgTable(
  'relays',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    endpoint: text('endpoint').notNull(),
    publicKey: text('public_key').notNull(),
    operator: relayOperator('operator').notNull(),
    operatorUserId: text('operator_user_id').notNull(),
    maxConnections: integer('max_connections').notNull(),
    bandwidth: integer('bandwidth').notNull(),
    location: text('location').notNull().default(''),
    status: relayStatus('status').notNull().default('offline'),
    lastSeen: timestamp('last_seen', { withTimezone: true }).notNull().defaultNow(),
    /**
     * When the relay last proved possession of `publicKey` (a signed
     * registration or heartbeat). The signed directory lists a community
     * relay only while this is fresh; null for relays that never proved it.
     */
    keyProvenAt: timestamp('key_proven_at', { withTimezone: true }),
    /**
     * When the registry last connected to `endpoint` itself and the relay
     * there proved `publicKey` (registry/relayLiveCheck.ts). Without a recent
     * one a community relay is not in the signed directory, so a key proof
     * alone cannot list an endpoint someone else answers.
     */
    liveCheckedAt: timestamp('live_checked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('relays_endpoint_key').on(table.endpoint),
    index('relays_operator_user_id_idx').on(table.operatorUserId),
  ],
);

// ---------------------------------------------------------------------------
// TLD proposals and votes
// ---------------------------------------------------------------------------

export const tldProposals = pgTable('tld_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  tld: text('tld').notNull(),
  proposedById: uuid('proposed_by_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  status: proposalStatus('status').notNull().default('open'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One vote per user per proposal.
 *
 * The unique constraint replaces a `findOneAndUpdate(..., { upsert: true })`
 * that enforced the same rule in application code — where two concurrent votes
 * could both pass the check and both insert.
 */
export const votes = pgTable(
  'votes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    proposalId: uuid('proposal_id')
      .notNull()
      .references(() => tldProposals.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    direction: voteDirection('direction').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('votes_proposal_user_key').on(table.proposalId, table.userId),
    index('votes_proposal_id_idx').on(table.proposalId),
  ],
);

// ---------------------------------------------------------------------------
// Personal DNS rules (end-to-end encrypted)
// ---------------------------------------------------------------------------

/**
 * One encrypted personal-rule envelope per Oxy account
 * (docs/architecture/naming.md §3, privacy-model.md §4).
 *
 * Everything here is opaque to the API: the rules are sealed in `ciphertext`
 * under a key that is itself wrapped under the user's sync passphrase, and
 * the plaintext is padded so the length does not count the rules. There is
 * deliberately no column for a rule count, a name, or anything derived from
 * the plaintext, and no history: a write replaces the row.
 *
 * Keyed by the Oxy user id rather than `users.id`, so storing rules needs no
 * local user row and deleting them leaves nothing behind.
 */
export const dnsRuleSets = pgTable('dns_rule_sets', {
  oxyUserId: text('oxy_user_id').primaryKey(),
  /** Envelope format version (`v`). */
  envelopeVersion: integer('envelope_version').notNull(),
  /** Argon2id parameters the wrap was derived with: `{ alg, m, t, p }`. */
  kdfParams: jsonb('kdf_params')
    .$type<{ alg: 'argon2id'; m: number; t: number; p: number }>()
    .notNull(),
  salt: text('salt').notNull(),
  wrappedKey: text('wrapped_key').notNull(),
  nonce: text('nonce').notNull(),
  ciphertext: text('ciphertext').notNull(),
  /** Monotonic; a write must be exactly this plus one. */
  version: integer('version').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// VPN devices (WireGuard, standard tier)
// ---------------------------------------------------------------------------

/**
 * One WireGuard device of one Oxy account (docs/architecture/vpn.md §10,
 * privacy-model.md §4).
 *
 * This is ALL the registry keeps about a device: who owns it, what its owner
 * calls it, its public key and its tunnel address. There is deliberately no
 * column for a private key, a handshake or connection time, an endpoint (the
 * device's IP) or traffic, and no `updatedAt`: nothing here records use.
 *
 * `address` is the IPv4 tunnel address in `10.77.0.0/16`; the IPv6 one is
 * derived from it (`vpnIpv6ForIpv4`), so it is not stored twice. Both unique
 * indexes are load-bearing: WireGuard routes by key and by address, and two
 * devices sharing either would receive each other's traffic.
 */
export const vpnDevices = pgTable(
  'vpn_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    oxyUserId: text('oxy_user_id').notNull(),
    name: text('name').notNull(),
    publicKey: text('public_key').notNull(),
    address: text('address').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('vpn_devices_public_key_key').on(table.publicKey),
    uniqueIndex('vpn_devices_address_key').on(table.address),
    index('vpn_devices_oxy_user_id_idx').on(table.oxyUserId),
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

export * from './services.js';
