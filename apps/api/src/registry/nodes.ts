/**
 * When a service node counts as online.
 *
 * `status` alone cannot say: `/nodes/heartbeat` sets it to `online` and nothing
 * ever sets it back, so a node that crashed a month ago still reads `online`.
 * The client heartbeats every 30 seconds (`packages/client/src/service-node.ts`,
 * `HEARTBEAT_INTERVAL_MS`), so a node is online only while its last heartbeat is
 * recent enough to have been one of the last three.
 */

import type { ServiceNodeStatus } from "@tnp/shared-types";

/** Three missed 30-second heartbeats. */
export const SERVICE_NODE_STALE_AFTER_MS = 90_000;

export interface NodeLiveness {
  status: ServiceNodeStatus;
  lastSeen: Date;
}

export function isServiceNodeOnline(node: NodeLiveness | null, now: Date): boolean {
  if (!node || node.status !== "online") return false;
  return now.getTime() - node.lastSeen.getTime() <= SERVICE_NODE_STALE_AFTER_MS;
}

/** The status to publish: `online` only while the heartbeat is fresh. */
export function effectiveServiceNodeStatus(node: NodeLiveness, now: Date): ServiceNodeStatus {
  return isServiceNodeOnline(node, now) ? "online" : "offline";
}
