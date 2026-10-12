/**
 * When a service node counts as online.
 *
 * `status` alone cannot say: `/nodes/heartbeat` sets it to `online` and nothing
 * ever sets it back, so a node that crashed a month ago still reads `online`.
 * The client heartbeats every 30 seconds (`packages/client/src/service-node.ts`,
 * `HEARTBEAT_INTERVAL_MS`), so a node is online only while its last heartbeat is
 * recent enough to have been one of the last three.
 */

import type { ServiceNodeLookup, ServiceNodeStatus } from '@tnp/shared-types';

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
