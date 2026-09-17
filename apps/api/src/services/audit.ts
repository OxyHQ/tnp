/**
 * The services audit trail (services.md §4, §11).
 *
 * Minimized by construction: callers pass ids, states and codes. There is no
 * field for contact data, EPP codes, request bodies or provider responses, and
 * `metadata` values are restricted to scalars so a whole object cannot be
 * dropped in by accident.
 */

import type { Database } from "../db/postgres.js";
import { auditEvents } from "../db/schema/index.js";
import type { DbOrTx } from "./operations/store.js";

export type AuditActor =
  | { readonly kind: "user"; readonly oxyUserId: string }
  | { readonly kind: "support"; readonly oxyUserId: string }
  | { readonly kind: "system" };

export interface AuditEvent {
  readonly actor: AuditActor;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly correlationId?: string | null;
  readonly outcome: string;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export async function recordAudit(db: DbOrTx | Database, event: AuditEvent): Promise<void> {
  await db.insert(auditEvents).values({
    actorKind: event.actor.kind,
    actorOxyUserId: event.actor.kind === "system" ? null : event.actor.oxyUserId,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    correlationId: event.correlationId ?? null,
    outcome: event.outcome,
    metadata: event.metadata ?? {},
  });
}
