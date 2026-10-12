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
  MAX_RELAYS_PER_ACCOUNT,
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

/** How often a heartbeat re-runs the registry's live check of a community relay. */
export const RELAY_LIVE_RECHECK_SECONDS = 15 * 60;
/** A community relay leaves the signed directory when its last live check is older than this. */
export const RELAY_LIVE_CHECK_VALID_SECONDS = 60 * 60;

/**
 * Community relays the signed directory may list: heartbeat-fresh, not
 * offline, with a key proof as fresh as the heartbeat, and a live check (the
 * registry itself connected and the relay proved its key) within the hour.
 * `operator` is not read — the directory lists every registry relay as
 * `community`; `oxy` entries come only from the API's `TNP_OXY_RELAYS`
 * (registry/relayDirectory.ts).
 */
export async function listProvenCommunityRelays(db: Executor): Promise<CommunityRelayRow[]> {
  const fresh = sql`now() - make_interval(secs => ${RELAY_STALE_AFTER_SECONDS})`;
  const live = sql`now() - make_interval(secs => ${RELAY_LIVE_CHECK_VALID_SECONDS})`;
  return db
    .select({ endpoint: relays.endpoint, publicKey: relays.publicKey, location: relays.location })
    .from(relays)
    .where(
      and(
        ne(relays.status, 'offline'),
        gt(relays.lastSeen, fresh),
        isNotNull(relays.keyProvenAt),
        gt(relays.keyProvenAt, fresh),
        isNotNull(relays.liveCheckedAt),
        gt(relays.liveCheckedAt, live),
      ),
    )
    .orderBy(asc(relays.createdAt), asc(relays.id))
    .limit(256);
}

export type RegisterRelayOutcome =
  | { status: 'ok'; registration: RelayRegistration }
  | { status: 'taken' }
  | { status: 'cap' };

/**
 * Register or re-register a relay.
 *
 * - `taken`: the endpoint belongs to another account. The upsert's WHERE is
 *   what stops one account taking over another's relay by re-registering it.
 * - `cap`: the account already has `MAX_RELAYS_PER_ACCOUNT` other relays.
 *   Counted under a per-account advisory lock, so concurrent registrations
 *   cannot all pass the count.
 *
 * `keyProven` / `liveChecked` are the route's verdicts on the request's key
 * proof and on its own connection to the endpoint. A registration without
 * them is stored (relays released before proofs keep registering) with both
 * marks cleared, since the key may have changed.
 */
export async function registerRelay(
  db: Executor,
  params: {
    request: RegisterRelayRequest;
    operatorUserId: string;
    oxyOperators: ReadonlySet<string>;
    keyProven?: boolean;
    liveChecked?: boolean;
  },
): Promise<RegisterRelayOutcome> {
  const { request, operatorUserId, oxyOperators } = params;
  const proven = params.keyProven === true;
  const keyProvenAt = proven ? sql`now()` : null;
  const liveCheckedAt = proven && params.liveChecked ? sql`now()` : null;
  const { endpoint, publicKey, capacity, location } = request;
  // Stored for the record; the directory recomputes it on every read.
  const operator = relayOperatorFor(operatorUserId, oxyOperators);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`tnp-relays:${operatorUserId}`}))`,
    );
    const [others] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(relays)
      .where(and(eq(relays.operatorUserId, operatorUserId), ne(relays.endpoint, endpoint)));
    if ((others?.n ?? 0) >= MAX_RELAYS_PER_ACCOUNT) return { status: 'cap' } as const;

    const [relay] = await tx
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
        liveCheckedAt,
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
          liveCheckedAt,
          updatedAt: sql`now()`,
        },
        setWhere: eq(relays.operatorUserId, operatorUserId),
      })
      .returning();

    if (!relay) return { status: 'taken' } as const;

    // Projected, not returned whole: the row also carries `operatorUserId` and
    // internal ids, which are not part of the contract.
    return {
      status: 'ok',
      registration: {
        endpoint: relay.endpoint,
        publicKey: relay.publicKey,
        operator,
        capacity: { maxConnections: relay.maxConnections, bandwidth: relay.bandwidth },
        location: relay.location,
        status: relay.status,
      },
    } as const;
  });
}

/**
 * Record a heartbeat for the caller's own relay. `not-found` when there is no
 * such relay of theirs; `bad-proof` when a key proof was sent and does not
 * verify against the REGISTERED key (nothing is updated then). A valid proof
 * refreshes `key_proven_at`, and — at most every RELAY_LIVE_RECHECK_SECONDS —
 * re-runs the registry's live check (`liveCheck`), refreshing
 * `live_checked_at` only when the relay at the endpoint proves the key.
 *
 * The update is conditional on the key the proof was verified against, so a
 * re-registration with another key between the read and the write cannot be
 * marked proven by a proof for the old key.
 */
export async function recordRelayHeartbeat(
  db: Executor,
  params: {
    endpoint: string;
    operatorUserId: string;
    proof?: RelayKeyProof;
    nowSeconds?: number;
    liveCheck?: (endpoint: string, publicKey: string) => Promise<boolean>;
  },
): Promise<'ok' | 'not-found' | 'bad-proof'> {
  const owned = and(
    eq(relays.endpoint, params.endpoint),
    eq(relays.operatorUserId, params.operatorUserId),
  );
  let proven = false;
  let liveOk = false;
  let checkedKey: string | null = null;
  if (params.proof) {
    const [row] = await db
      .select({
        publicKey: relays.publicKey,
        liveDue: sql<boolean>`${relays.liveCheckedAt} is null or ${relays.liveCheckedAt} < now() - make_interval(secs => ${RELAY_LIVE_RECHECK_SECONDS})`,
      })
      .from(relays)
      .where(owned);
    if (!row) return 'not-found';
    proven = relayKeyProofValid({
      proof: params.proof,
      purpose: 'heartbeat',
      endpoint: params.endpoint,
      publicKey: row.publicKey,
      nowSeconds: params.nowSeconds ?? Math.floor(Date.now() / 1000),
    });
    if (!proven) return 'bad-proof';
    checkedKey = row.publicKey;
    if (row.liveDue && params.liveCheck) {
      liveOk = await params.liveCheck(params.endpoint, row.publicKey).catch(() => false);
    }
  }
  const updated = await db
    .update(relays)
    .set({
      lastSeen: sql`now()`,
      status: 'active',
      updatedAt: sql`now()`,
      // Only ever raised here, against the key the row still holds.
      ...(proven ? { keyProvenAt: sql`now()` } : {}),
      ...(liveOk ? { liveCheckedAt: sql`now()` } : {}),
    })
    .where(checkedKey === null ? owned : and(owned, eq(relays.publicKey, checkedKey)))
    .returning({ id: relays.id });
  return updated.length > 0 ? 'ok' : 'not-found';
}
