/**
 * Persistence for the operations outbox: enqueue, claim, submit, finish.
 *
 * Every state transition a worker makes is guarded by `lease_owner = <me>` and
 * `status = 'running'`, so a worker that stalled past its lease and was
 * superseded cannot overwrite the result of the worker that took over.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "../../db/postgres.js";
import { operationResourceLeases, operations } from "../../db/schema/index.js";
import { hashIntent, IdempotencyConflictError } from "./intent.js";

export type Operation = typeof operations.$inferSelect;
export type OperationStatus = Operation["status"];
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type DbOrTx = Database | Tx;

export interface EnqueueInput {
  readonly kind: string;
  /** `user:<users.id>` or `system`. */
  readonly scope: string;
  readonly idempotencyKey: string;
  readonly ownerId: string | null;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly providerAccountId: string | null;
  readonly payload: Record<string, unknown>;
  readonly maxAttempts?: number;
  readonly runAt?: Date;
}

/**
 * Insert an operation, or return the one this idempotency key already created.
 *
 * `ON CONFLICT DO NOTHING` then a read, rather than catching a unique
 * violation: inside a transaction a failed statement aborts the transaction,
 * and callers enqueue inside the same transaction as the order that needs it.
 */
export async function enqueueOperation(
  db: DbOrTx,
  input: EnqueueInput,
): Promise<{ operation: Operation; created: boolean }> {
  const intentHash = hashIntent({
    kind: input.kind,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    providerAccountId: input.providerAccountId,
    payload: input.payload,
  });

  const [inserted] = await db
    .insert(operations)
    .values({
      kind: input.kind,
      idempotencyScope: input.scope,
      idempotencyKey: input.idempotencyKey,
      intentHash,
      ownerId: input.ownerId,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      providerAccountId: input.providerAccountId,
      payload: input.payload,
      maxAttempts: input.maxAttempts ?? 5,
      nextRunAt: input.runAt ?? new Date(),
    })
    .onConflictDoNothing({ target: [operations.idempotencyScope, operations.idempotencyKey] })
    .returning();
  if (inserted) return { operation: inserted, created: true };

  const [existing] = await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.idempotencyScope, input.scope),
        eq(operations.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  if (!existing) {
    throw new Error(`operation for idempotency key ${input.idempotencyKey} conflicted and then vanished`);
  }
  if (existing.intentHash !== intentHash) throw new IdempotencyConflictError(input.idempotencyKey);
  return { operation: existing, created: false };
}

export interface ClaimOptions {
  readonly workerId: string;
  readonly leaseMs: number;
  readonly kinds: readonly string[];
  /** Candidates examined per claim; a busy resource skips to the next. */
  readonly scan?: number;
}

function resourceKey(op: Pick<Operation, "resourceType" | "resourceId">): string {
  return `${op.resourceType}:${op.resourceId}`;
}

/**
 * Claim one runnable operation.
 *
 * Runnable: `queued` or `unknown` whose `next_run_at` has passed, or `running`
 * whose lease has expired (its worker died). Rows are locked with `SKIP
 * LOCKED`, so concurrent workers never claim the same row, and a
 * `operation_resource_leases` row — unique per resource — ensures two
 * operations on the same domain or zone never run at once, even when two
 * workers claim them in the same instant.
 */
export async function claimNextOperation(db: Database, options: ClaimOptions): Promise<Operation | null> {
  if (options.kinds.length === 0) return null;
  const leaseSeconds = Math.max(1, Math.ceil(options.leaseMs / 1000));

  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: operations.id, resourceType: operations.resourceType, resourceId: operations.resourceId })
      .from(operations)
      .where(
        and(
          inArray(operations.kind, [...options.kinds]),
          sql`(
            (${operations.status} in ('queued', 'unknown') and ${operations.nextRunAt} <= now())
            or (${operations.status} = 'running' and ${operations.leaseExpiresAt} < now())
          )`,
        ),
      )
      .orderBy(operations.nextRunAt)
      .limit(options.scan ?? 10)
      .for("update", { skipLocked: true });

    for (const candidate of candidates) {
      const key = resourceKey(candidate);
      const [lease] = await tx
        .insert(operationResourceLeases)
        .values({
          resourceKey: key,
          operationId: candidate.id,
          expiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
        })
        .onConflictDoUpdate({
          target: operationResourceLeases.resourceKey,
          set: {
            operationId: sql`excluded.operation_id`,
            expiresAt: sql`excluded.expires_at`,
          },
          // Take over only an expired lease, or our own row (a reclaimed
          // operation whose previous worker died holding it).
          setWhere: sql`${operationResourceLeases.expiresAt} < now() or ${operationResourceLeases.operationId} = excluded.operation_id`,
        })
        .returning({ operationId: operationResourceLeases.operationId });
      if (!lease) continue;

      const [claimed] = await tx
        .update(operations)
        .set({
          status: "running",
          leaseOwner: options.workerId,
          leaseExpiresAt: sql`now() + make_interval(secs => ${leaseSeconds})`,
          // A reconciliation pass is not an execution attempt.
          attempts: sql`${operations.attempts} + case when ${operations.submittedAt} is null then 1 else 0 end`,
          updatedAt: sql`now()`,
        })
        .where(eq(operations.id, candidate.id))
        .returning();
      return claimed ?? null;
    }
    return null;
  });
}

export class LeaseLostError extends Error {
  constructor(operationId: string) {
    super(`lease on operation ${operationId} was lost`);
    this.name = "LeaseLostError";
  }
}

/**
 * Record that a mutating request is about to be sent. Committed on its own,
 * before the request, so a crash after sending is recovered by reconciliation.
 * Refuses when the lease has been lost: another worker may be reconciling.
 */
export async function markSubmitted(db: Database, operationId: string, workerId: string): Promise<void> {
  const [row] = await db
    .update(operations)
    .set({ submittedAt: sql`coalesce(${operations.submittedAt}, now())`, updatedAt: sql`now()` })
    .where(
      and(
        eq(operations.id, operationId),
        eq(operations.status, "running"),
        eq(operations.leaseOwner, workerId),
        sql`${operations.leaseExpiresAt} > now()`,
      ),
    )
    .returning({ id: operations.id });
  if (!row) throw new LeaseLostError(operationId);
}

export interface FinishUpdate {
  readonly status: Exclude<OperationStatus, "running">;
  readonly result?: Record<string, unknown> | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  readonly nextRunAt?: Date;
  /** `null` clears it: only when nothing was applied and the operation will run again. */
  readonly submittedAt?: null;
  readonly incrementResubmissions?: boolean;
  readonly incrementReconcileAttempts?: boolean;
}

const TERMINAL: ReadonlySet<OperationStatus> = new Set(["succeeded", "failed", "manual_review"]);

/**
 * Leave the `running` state and release the resource lease, in one
 * transaction. Returns false when this worker no longer held the lease — the
 * result is dropped, because whoever holds it now is authoritative.
 */
export async function finishOperation(
  db: Database,
  operationId: string,
  workerId: string,
  update: FinishUpdate,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(operations)
      .set({
        status: update.status,
        leaseOwner: null,
        leaseExpiresAt: null,
        ...(update.result !== undefined ? { result: update.result } : {}),
        errorCode: update.errorCode ?? null,
        errorMessage: update.errorMessage ?? null,
        ...(update.nextRunAt ? { nextRunAt: update.nextRunAt } : {}),
        ...(update.submittedAt === null ? { submittedAt: null } : {}),
        ...(update.incrementResubmissions ? { resubmissions: sql`${operations.resubmissions} + 1` } : {}),
        ...(update.incrementReconcileAttempts
          ? { reconcileAttempts: sql`${operations.reconcileAttempts} + 1` }
          : {}),
        completedAt: TERMINAL.has(update.status) ? sql`now()` : null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(operations.id, operationId),
          eq(operations.status, "running"),
          eq(operations.leaseOwner, workerId),
        ),
      )
      .returning({ id: operations.id, resourceType: operations.resourceType, resourceId: operations.resourceId });
    if (!row) return false;

    await tx
      .delete(operationResourceLeases)
      .where(
        and(
          eq(operationResourceLeases.resourceKey, resourceKey(row)),
          eq(operationResourceLeases.operationId, operationId),
        ),
      );
    return true;
  });
}
