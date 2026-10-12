/**
 * The relay directory: who may be published as Oxy-operated, which relays are
 * live, and in what order clients see them.
 *
 * Three rules, each closing a way the directory used to be steerable by any
 * Oxy account (security review, 2026-10):
 *
 * 1. `operator` is the registry's decision. A relay is `oxy` only while its
 *    registering account is on the `TNP_OXY_RELAY_OPERATORS` allowlist, and
 *    that is evaluated when the directory is read — so a row written back when
 *    the field was self-asserted, or an operator later removed from the list,
 *    is `community` immediately rather than at its next registration.
 * 2. A relay is listed only while its heartbeat is fresh. Nothing ever wrote
 *    `offline`, so one heartbeat used to list a relay forever.
 * 3. The order is not the relay's to choose. It used to be status, then
 *    endpoint string — so `ws://…` sorted ahead of every `wss://…` and a
 *    chosen hostname could put a relay first. Now: Oxy-operated first, then
 *    longest-registered, then id. Tenure costs an attacker time; an endpoint
 *    string or a heartbeat rate costs nothing.
 */

import { and, asc, eq, gt, inArray, isNotNull, ne, not, sql, type SQL } from 'drizzle-orm';
import { verifyRelayRegistryProof, type RelayRegistryProofPurpose } from '@tnp/crypto';
import {
  RELAY_KEY_PROOF_WINDOW_SECONDS,
  type RegisterRelayRequest,
  type RelayDirectoryEntry,
  type RelayKeyProof,
  type RelayOperator,
  type RelayRegistration,
} from '@tnp/shared-types';
import { relays } from '../db/schema/index.js';
import type { Executor } from './db.js';
import type { CommunityRelayRow } from './relayDirectory.js';

/**
 * Three missed heartbeats: relays check in every 30 seconds
 * (`packages/client/src/relay-node.ts`, `HEARTBEAT_INTERVAL_MS`).
 */
export const RELAY_STALE_AFTER_SECONDS = 90;

/**
 * Whether `proof` shows the caller holds the private half of `publicKey` for
 * `endpoint`, signed within the freshness window of `nowSeconds`. The window
 * bounds how long a captured proof is worth anything; the account token is
 * still required alongside it.
 */
export function relayKeyProofValid(params: {
  proof: RelayKeyProof;
  purpose: RelayRegistryProofPurpose;
  endpoint: string;
  publicKey: string;
  nowSeconds: number;
}): boolean {
  const { proof, purpose, endpoint, publicKey, nowSeconds } = params;
  if (Math.abs(nowSeconds - proof.issuedAt) > RELAY_KEY_PROOF_WINDOW_SECONDS) return false;
  return verifyRelayRegistryProof(
    { purpose, endpoint, relayKey: publicKey, issuedAt: proof.issuedAt },
    proof.signature,
  );
}

export function relayOperatorFor(
  operatorUserId: string,
  oxyOperators: ReadonlySet<string>,
): RelayOperator {
  return oxyOperators.has(operatorUserId) ? 'oxy' : 'community';
}

/** `operator_user_id IN (allowlist)`, or a constant false for an empty allowlist. */
function isOxyOperated(oxyOperators: ReadonlySet<string>): SQL {
  return oxyOperators.size > 0 ? inArray(relays.operatorUserId, [...oxyOperators]) : sql`false`;
}

export async function listRelayDirectory(
  db: Executor,
  params: { oxyOperators: ReadonlySet<string>; operator: RelayOperator | null },
): Promise<RelayDirectoryEntry[]> {
  const { oxyOperators, operator } = params;
  const oxy = isOxyOperated(oxyOperators);

  const rows = await db
    .select({
      endpoint: relays.endpoint,
      publicKey: relays.publicKey,
      operatorUserId: relays.operatorUserId,
      location: relays.location,
      status: relays.status,
    })
    .from(relays)
    .where(
      and(
        ne(relays.status, 'offline'),
        // The database's clock, not this task's: the heartbeat wrote `now()`.
        gt(relays.lastSeen, sql`now() - make_interval(secs => ${RELAY_STALE_AFTER_SECONDS})`),
        operator === 'oxy' ? oxy : operator === 'community' ? not(oxy) : undefined,
      ),
    )
    .orderBy(sql`case when ${oxy} then 0 else 1 end`, asc(relays.createdAt), asc(relays.id));

  return rows.map((row) => ({
    endpoint: row.endpoint,
    publicKey: row.publicKey,
    operator: relayOperatorFor(row.operatorUserId, oxyOperators),
    location: row.location,
    status: row.status,
  }));
}

/**
 * Community relays the signed directory may list: heartbeat-fresh, not
 * offline, and with a key proof as fresh as the heartbeat. `operator` is not
 * read — the directory lists every registry relay as `community`; `oxy`
 * entries come only from the API's `TNP_OXY_RELAYS` (registry/relayDirectory.ts).
 */
export async function listProvenCommunityRelays(db: Executor): Promise<CommunityRelayRow[]> {
  const fresh = sql`now() - make_interval(secs => ${RELAY_STALE_AFTER_SECONDS})`;
  return db
    .select({ endpoint: relays.endpoint, publicKey: relays.publicKey, location: relays.location })
    .from(relays)
    .where(
      and(
        ne(relays.status, 'offline'),
        gt(relays.lastSeen, fresh),
        isNotNull(relays.keyProvenAt),
        gt(relays.keyProvenAt, fresh),
      ),
    )
    .orderBy(asc(relays.createdAt), asc(relays.id))
    .limit(256);
}

/**
 * Register or re-register a relay. Null when the endpoint belongs to another
 * account: the upsert's WHERE is what stops one account taking over another's
 * relay by re-registering its endpoint.
 *
 * `keyProven` is the route's verdict on the request's key proof. A
 * registration without one is stored (relays released before proofs keep
 * registering) with `key_proven_at` cleared, since the key may have changed.
 */
export async function registerRelay(
  db: Executor,
  params: {
    request: RegisterRelayRequest;
    operatorUserId: string;
    oxyOperators: ReadonlySet<string>;
    keyProven?: boolean;
  },
): Promise<RelayRegistration | null> {
  const { request, operatorUserId, oxyOperators } = params;
  const keyProvenAt = params.keyProven ? sql`now()` : null;
  const { endpoint, publicKey, capacity, location } = request;
  // Stored for the record; the directory recomputes it on every read.
  const operator = relayOperatorFor(operatorUserId, oxyOperators);

  const [relay] = await db
    .insert(relays)
    .values({
      endpoint,
      publicKey,
      operator,
      operatorUserId,
      maxConnections: capacity.maxConnections,
      bandwidth: capacity.bandwidth,
      location,
      lastSeen: sql`now()`,
      keyProvenAt,
    })
    .onConflictDoUpdate({
      target: relays.endpoint,
      set: {
        publicKey,
        operator,
        maxConnections: capacity.maxConnections,
        bandwidth: capacity.bandwidth,
        location,
        lastSeen: sql`now()`,
        keyProvenAt,
        updatedAt: sql`now()`,
      },
      setWhere: eq(relays.operatorUserId, operatorUserId),
    })
    .returning();

  if (!relay) return null;

  // Projected, not returned whole: the row also carries `operatorUserId` and
  // internal ids, which are not part of the contract.
  return {
    endpoint: relay.endpoint,
    publicKey: relay.publicKey,
    operator,
    capacity: { maxConnections: relay.maxConnections, bandwidth: relay.bandwidth },
    location: relay.location,
    status: relay.status,
  };
}

/**
 * Record a heartbeat for the caller's own relay. `not-found` when there is no
 * such relay of theirs; `bad-proof` when a key proof was sent and does not
 * verify against the REGISTERED key (nothing is updated then). A valid proof
 * refreshes `key_proven_at`; a heartbeat without one leaves it to go stale.
 */
export async function recordRelayHeartbeat(
  db: Executor,
  params: {
    endpoint: string;
    operatorUserId: string;
    proof?: RelayKeyProof;
    nowSeconds?: number;
  },
): Promise<'ok' | 'not-found' | 'bad-proof'> {
  const owned = and(
    eq(relays.endpoint, params.endpoint),
    eq(relays.operatorUserId, params.operatorUserId),
  );
  let proven = false;
  if (params.proof) {
    const [row] = await db.select({ publicKey: relays.publicKey }).from(relays).where(owned);
    if (!row) return 'not-found';
    proven = relayKeyProofValid({
      proof: params.proof,
      purpose: 'heartbeat',
      endpoint: params.endpoint,
      publicKey: row.publicKey,
      nowSeconds: params.nowSeconds ?? Math.floor(Date.now() / 1000),
    });
    if (!proven) return 'bad-proof';
  }
  const updated = await db
    .update(relays)
    .set({
      lastSeen: sql`now()`,
      status: 'active',
      updatedAt: sql`now()`,
      // Only ever raised here, against the key the row holds.
      ...(proven ? { keyProvenAt: sql`now()` } : {}),
    })
    .where(owned)
    .returning({ id: relays.id });
  return updated.length > 0 ? 'ok' : 'not-found';
}
