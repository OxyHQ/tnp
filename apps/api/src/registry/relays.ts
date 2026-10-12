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

import { and, asc, eq, gt, inArray, ne, not, sql, type SQL } from 'drizzle-orm';
import type {
  RegisterRelayRequest,
  RelayDirectoryEntry,
  RelayOperator,
  RelayRegistration,
} from '@tnp/shared-types';
import { relays } from '../db/schema/index.js';
import type { Executor } from './db.js';

/**
 * Three missed heartbeats: relays check in every 30 seconds
 * (`packages/client/src/relay-node.ts`, `HEARTBEAT_INTERVAL_MS`).
 */
export const RELAY_STALE_AFTER_SECONDS = 90;

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
 * Register or re-register a relay. Null when the endpoint belongs to another
 * account: the upsert's WHERE is what stops one account taking over another's
 * relay by re-registering its endpoint.
 */
export async function registerRelay(
  db: Executor,
  params: {
    request: RegisterRelayRequest;
    operatorUserId: string;
    oxyOperators: ReadonlySet<string>;
  },
): Promise<RelayRegistration | null> {
  const { request, operatorUserId, oxyOperators } = params;
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

/** Record a heartbeat for the caller's own relay. False when there is no such relay of theirs. */
export async function recordRelayHeartbeat(
  db: Executor,
  params: { endpoint: string; operatorUserId: string },
): Promise<boolean> {
  const updated = await db
    .update(relays)
    .set({ lastSeen: sql`now()`, status: 'active', updatedAt: sql`now()` })
    .where(
      and(eq(relays.endpoint, params.endpoint), eq(relays.operatorUserId, params.operatorUserId)),
    )
    .returning({ id: relays.id });
  return updated.length > 0;
}
