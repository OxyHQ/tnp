/**
 * When a service node counts as online.
 *
 * `status` alone cannot say: `/nodes/heartbeat` sets it to `online` and nothing
 * ever sets it back, so a node that crashed a month ago still reads `online`.
 * The client heartbeats every 30 seconds (`packages/client/src/service-node.ts`,
 * `HEARTBEAT_INTERVAL_MS`), so a node is online only while its last heartbeat is
 * recent enough to have been one of the last three.
 */

import {
  type Grant,
  type KeyAgreementCertificate,
  KeyAgreementRole,
  verifyKeyAgreementCertificate,
} from '@tnp/crypto';
import type { ServiceNodeLookup, ServiceNodeStatus } from '@tnp/shared-types';
import { eq, sql } from 'drizzle-orm';
import { domains, serviceNodes } from '../db/schema/index.js';
import type { Executor } from './db.js';

/** Three missed 30-second heartbeats. */
export const SERVICE_NODE_STALE_AFTER_MS = 90_000;

export interface NodeLiveness {
  status: ServiceNodeStatus;
  lastSeen: Date;
}

export function isServiceNodeOnline(node: NodeLiveness | null, now: Date): boolean {
  if (node?.status !== 'online') return false;
  return now.getTime() - node.lastSeen.getTime() <= SERVICE_NODE_STALE_AFTER_MS;
}

/**
 * The public `GET /nodes/:domain` view of a node.
 *
 * No timestamp: that endpoint is unauthenticated, and the exact time of every
 * heartbeat is a record of when a name's operator has their machine on.
 * Liveness is the one bit a client needs, and the relay is published only
 * while a client could actually reach the node through it.
 */
export function toServiceNodeLookup(
  node: NodeLiveness & { publicKey: string; connectedRelay: string },
  now: Date,
): ServiceNodeLookup {
  const online = isServiceNodeOnline(node, now);
  return {
    publicKey: node.publicKey,
    connectedRelay: online ? node.connectedRelay : '',
    status: online ? 'online' : 'offline',
    online,
  };
}

/**
 * Store a service node's chain and certificate after verifying them against
 * the name's CURRENT domain key.
 *
 * One transaction with the domain row locked: the key the material is
 * verified against is still the domain key when it is stored. A rotation
 * (which locks the same row and clears node material) therefore either
 * happens before — and this registration is verified against the new key —
 * or after, and clears what this stored. It can never land after a rotation
 * with a chain under the retired key.
 */
export async function registerServiceNode(
  db: Executor,
  params: {
    userId: string;
    domainId: string;
    chain: Grant[];
    kaCert: KeyAgreementCertificate;
    now: number;
  },
) {
  return db.transaction(async (tx) => {
    const [domain] = await tx
      .select({
        id: domains.id,
        oxyUserId: domains.oxyUserId,
        name: domains.name,
        tld: domains.tld,
        domainKey: domains.domainKey,
      })
      .from(domains)
      .where(eq(domains.id, params.domainId))
      .for('update')
      .limit(1);

    if (!domain) return { status: 404, error: 'Domain not found' } as const;
    if (domain.oxyUserId !== params.userId) {
      return { status: 403, error: 'You do not own this domain' } as const;
    }
    if (!domain.domainKey) {
      return {
        status: 409,
        error: 'Register a domain key first: tnp domain key init <name>',
      } as const;
    }

    const verified = verifyKeyAgreementCertificate(params.kaCert, params.chain, {
      trustedRoots: [domain.domainKey],
      role: KeyAgreementRole.SERVICE_NODE,
      name: `${domain.name}.${domain.tld}`,
      now: params.now,
    });
    if (!verified.ok) {
      // The reason enum only: the detail can describe attacker-supplied input.
      return { status: 422, error: `Key material does not verify: ${verified.reason}` } as const;
    }
    const publicKey = params.kaCert.signer;
    const { chain, kaCert } = params;
    const userId = params.userId;

    // One node per domain, enforced by a unique index rather than by convention.
    const [row] = await tx
      .insert(serviceNodes)
      .values({ domainId: domain.id, oxyUserId: userId, publicKey, chain, kaCert })
      .onConflictDoUpdate({
        target: serviceNodes.domainId,
        set: {
          publicKey,
          chain,
          kaCert,
          oxyUserId: userId,
          // A binding is signed by the node key; one from another key would
          // only be refused by clients, so it does not outlive the key.
          relayBinding: sql`case when ${serviceNodes.publicKey} = ${publicKey} then ${serviceNodes.relayBinding} else null end`,
          lastSeen: sql`now()`,
          updatedAt: sql`now()`,
        },
      })
      .returning();
    return { status: 201, node: row } as const;
  });
}
