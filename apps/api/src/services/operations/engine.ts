/**
 * The operation engine: run one claimed operation to its next state.
 *
 * The decision table lives here once, for every handler and every provider
 * (services.md §5):
 *
 * | Situation | Next state |
 * |---|---|
 * | handler succeeded | `succeeded` |
 * | error before anything was submitted, retryable, attempts left | `queued` with backoff |
 * | error before submission, not retryable | `failed` (or `manual_review` for operator problems) |
 * | mutating call submitted, error does not prove nothing applied | `unknown` → reconcile |
 * | reconcile finds the effect | `succeeded` |
 * | reconcile proves absence after the settle window, first time | `queued` again, once |
 * | reconcile proves absence a second time, or cannot decide for too long | `manual_review` |
 *
 * It never re-executes a submitted mutating operation without a reconciliation
 * that proved the first attempt absent, and it never does so twice.
 */

import type { Database } from "../../db/postgres.js";
import { recordAudit } from "../audit.js";
import type { AdapterCallContext } from "../providers/contracts.js";
import { isProviderError, provesNothingApplied, type ProviderErrorCode } from "../providers/errors.js";
import {
  claimNextOperation,
  finishOperation,
  LeaseLostError,
  markSubmitted,
  type FinishUpdate,
  type Operation,
} from "./store.js";

export type ExecuteOutcome =
  | { readonly kind: "succeeded"; readonly result?: Record<string, unknown> }
  | { readonly kind: "failed"; readonly code: string; readonly message: string }
  | { readonly kind: "manual_review"; readonly code: string; readonly message: string }
  /** The request was sent and the effect could not be confirmed. */
  | { readonly kind: "unknown"; readonly message: string };

export type ReconcileOutcome =
  | { readonly kind: "succeeded"; readonly result?: Record<string, unknown> }
  /** Positive evidence the submitted request had no effect. */
  | { readonly kind: "absent" }
  | { readonly kind: "undetermined"; readonly message: string }
  /** The remote state matches neither the intent nor the prior state. */
  | { readonly kind: "conflict"; readonly message: string };

export interface HandlerContext {
  readonly db: Database;
  readonly operation: Operation;
  readonly now: () => Date;
  /** Pass to every adapter call; `beforeSubmit` persists `submitted_at`. */
  readonly call: AdapterCallContext;
  /**
   * Call immediately after the mutating provider call returns. From then on
   * the change is known to have been sent and accepted, so any later failure —
   * a re-read refused by the quota gate, say — is an unknown outcome, never
   * evidence that nothing was applied.
   */
  readonly mutationReturned: () => void;
}

export interface OperationHandler {
  readonly kind: string;
  /** Whether executing twice could do something twice (register, renew, replace a zone). */
  readonly mutating: boolean;
  execute(ctx: HandlerContext): Promise<ExecuteOutcome>;
  /** Required for mutating handlers; never called for read-only ones. */
  reconcile?(ctx: HandlerContext): Promise<ReconcileOutcome>;
  /** Mirror a terminal failure onto the resource (lifecycle, order line). */
  onGiveUp?(ctx: HandlerContext, status: "failed" | "manual_review", code: string): Promise<void>;
}

export interface EngineOptions {
  readonly db: Database;
  readonly workerId: string;
  readonly handlers: readonly OperationHandler[];
  readonly leaseMs?: number;
  /** Minimum age of a submission before "absent" is believed. */
  readonly settleMs?: number;
  readonly maxReconcileAttempts?: number;
  readonly now?: () => Date;
  readonly log?: (event: Record<string, unknown>) => void;
}

const RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set(["rate_limited", "provider_unavailable"]);
const OPERATOR_PROBLEMS: ReadonlySet<ProviderErrorCode> = new Set(["credentials", "insufficient_funds"]);

export function backoffMs(attempt: number, baseMs = 30_000, capMs = 3_600_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

export class OperationEngine {
  readonly #db: Database;
  readonly #workerId: string;
  readonly #handlers: Map<string, OperationHandler>;
  readonly #leaseMs: number;
  readonly #settleMs: number;
  readonly #maxReconcileAttempts: number;
  readonly #now: () => Date;
  readonly #log: (event: Record<string, unknown>) => void;

  constructor(options: EngineOptions) {
    this.#db = options.db;
    this.#workerId = options.workerId;
    this.#handlers = new Map();
    for (const handler of options.handlers) {
      if (handler.mutating && !handler.reconcile) {
        throw new Error(`mutating handler ${handler.kind} must implement reconcile`);
      }
      this.#handlers.set(handler.kind, handler);
    }
    this.#leaseMs = options.leaseMs ?? 300_000;
    this.#settleMs = options.settleMs ?? 300_000;
    this.#maxReconcileAttempts = options.maxReconcileAttempts ?? 12;
    this.#now = options.now ?? (() => new Date());
    this.#log = options.log ?? (() => {});
  }

  get kinds(): readonly string[] {
    return [...this.#handlers.keys()];
  }

  /** Claim and run one operation. Returns false when nothing was runnable. */
  async runOnce(): Promise<boolean> {
    const operation = await claimNextOperation(this.#db, {
      workerId: this.#workerId,
      leaseMs: this.#leaseMs,
      kinds: this.kinds,
    });
    if (!operation) return false;
    await this.run(operation);
    return true;
  }

  async run(operation: Operation): Promise<void> {
    const handler = this.#handlers.get(operation.kind);
    if (!handler) {
      await this.#finish(operation, { status: "manual_review", errorCode: "no_handler", errorMessage: "No handler for this operation." });
      return;
    }

    let submitted = operation.submittedAt !== null;
    let mutationReturned = false;
    const ctx: HandlerContext = {
      db: this.#db,
      operation,
      now: this.#now,
      call: {
        correlationId: operation.correlationId,
        beforeSubmit: async () => {
          await markSubmitted(this.#db, operation.id, this.#workerId);
          submitted = true;
        },
      },
      mutationReturned: () => {
        mutationReturned = true;
      },
    };

    if (handler.mutating && operation.submittedAt !== null) {
      await this.#reconcile(handler, ctx);
      return;
    }

    try {
      const outcome = await handler.execute(ctx);
      await this.#applyExecuteOutcome(handler, ctx, outcome, submitted);
    } catch (err) {
      await this.#applyExecuteError(handler, ctx, err, submitted, mutationReturned);
    }
  }

  async #applyExecuteOutcome(
    handler: OperationHandler,
    ctx: HandlerContext,
    outcome: ExecuteOutcome,
    submitted: boolean,
  ): Promise<void> {
    const op = ctx.operation;
    switch (outcome.kind) {
      case "succeeded":
        await this.#finish(op, { status: "succeeded", result: outcome.result ?? {} });
        return;
      case "unknown":
        await this.#toUnknown(op, "unknown_outcome", outcome.message);
        return;
      case "failed":
      case "manual_review": {
        // A handler that reports failure after submitting has no proof of
        // absence to offer; only an error that proves it may say so.
        if (handler.mutating && submitted && outcome.kind === "failed") {
          await this.#toUnknown(op, outcome.code, outcome.message);
          return;
        }
        await this.#giveUp(handler, ctx, outcome.kind, outcome.code, outcome.message);
        return;
      }
    }
  }

  async #applyExecuteError(
    handler: OperationHandler,
    ctx: HandlerContext,
    err: unknown,
    submitted: boolean,
    mutationReturned: boolean,
  ): Promise<void> {
    const op = ctx.operation;
    if (err instanceof LeaseLostError) {
      this.#log({ event: "operation.lease_lost", operationId: op.id });
      return;
    }

    if (!isProviderError(err)) {
      this.#log({ event: "operation.error", operationId: op.id, kind: op.kind, error: String(err) });
      if (handler.mutating && submitted) {
        await this.#toUnknown(op, "internal", "The result is being checked.");
        return;
      }
      await this.#retryOrGiveUp(handler, ctx, "internal", "An internal error occurred.");
      return;
    }

    // The `submitted` flag on the error describes the call that failed, not the
    // operation. Only a refusal returned BY the submitting call itself proves
    // nothing applied; an error after the mutation returned, or a pre-send
    // failure once `submitted_at` is written, is reconciled instead.
    if (handler.mutating && submitted && (mutationReturned || !err.submitted || !provesNothingApplied(err))) {
      await this.#toUnknown(op, err.code, err.safeMessage);
      return;
    }
    // From here the provider demonstrably applied nothing, so a retry cannot
    // do anything twice; clear the submission marker if one was written.
    if (RETRYABLE.has(err.code)) {
      await this.#retryOrGiveUp(handler, ctx, err.code, err.safeMessage, err.retryAfterMs);
      return;
    }
    const status = OPERATOR_PROBLEMS.has(err.code) ? "manual_review" : "failed";
    await this.#giveUp(handler, ctx, status, err.code, err.safeMessage);
  }

  async #reconcile(handler: OperationHandler, ctx: HandlerContext): Promise<void> {
    const op = ctx.operation;
    const reconcile = handler.reconcile;
    if (!reconcile) throw new Error(`handler ${handler.kind} cannot reconcile`);

    let outcome: ReconcileOutcome;
    try {
      outcome = await reconcile(ctx);
    } catch (err) {
      outcome = {
        kind: "undetermined",
        message: isProviderError(err) ? err.safeMessage : "The result could not be checked yet.",
      };
    }

    const submittedAt = op.submittedAt ?? this.#now();
    const settled = this.#now().getTime() - submittedAt.getTime() >= this.#settleMs;

    if (outcome.kind === "succeeded") {
      await this.#finish(op, { status: "succeeded", result: outcome.result ?? {} });
      return;
    }
    if (outcome.kind === "conflict") {
      await this.#giveUp(handler, ctx, "manual_review", "conflict", outcome.message);
      return;
    }
    if (outcome.kind === "absent" && settled) {
      if (op.resubmissions >= 1) {
        await this.#giveUp(handler, ctx, "manual_review", "absent_after_resubmission", "The provider shows no effect after a second attempt.");
        return;
      }
      this.#log({ event: "operation.resubmit", operationId: op.id, kind: op.kind });
      await this.#finish(op, {
        status: "queued",
        submittedAt: null,
        incrementResubmissions: true,
        nextRunAt: this.#now(),
      });
      return;
    }

    if (op.reconcileAttempts + 1 >= this.#maxReconcileAttempts) {
      await this.#giveUp(handler, ctx, "manual_review", "unreconciled", "The result could not be confirmed and needs review.");
      return;
    }
    await this.#finish(op, {
      status: "unknown",
      errorCode: "unknown_outcome",
      errorMessage: outcome.kind === "undetermined" ? outcome.message : "Waiting for the provider to settle.",
      incrementReconcileAttempts: true,
      nextRunAt: new Date(this.#now().getTime() + backoffMs(op.reconcileAttempts + 1, 60_000)),
    });
  }

  async #toUnknown(op: Operation, code: string, message: string): Promise<void> {
    await this.#finish(op, {
      status: "unknown",
      errorCode: code === "unknown_outcome" ? code : `unknown_outcome:${code}`,
      errorMessage: message,
      nextRunAt: new Date(this.#now().getTime() + 60_000),
    });
  }

  async #retryOrGiveUp(
    handler: OperationHandler,
    ctx: HandlerContext,
    code: string,
    message: string,
    retryAfterMs?: number,
  ): Promise<void> {
    const op = ctx.operation;
    if (op.attempts >= op.maxAttempts) {
      await this.#giveUp(handler, ctx, handler.mutating ? "manual_review" : "failed", code, message);
      return;
    }
    await this.#finish(op, {
      status: "queued",
      errorCode: code,
      errorMessage: message,
      submittedAt: null,
      nextRunAt: new Date(this.#now().getTime() + Math.max(retryAfterMs ?? 0, backoffMs(op.attempts))),
    });
  }

  async #giveUp(
    handler: OperationHandler,
    ctx: HandlerContext,
    status: "failed" | "manual_review",
    code: string,
    message: string,
  ): Promise<void> {
    const finished = await this.#finish(ctx.operation, { status, errorCode: code, errorMessage: message });
    if (finished && handler.onGiveUp) {
      try {
        await handler.onGiveUp(ctx, status, code);
      } catch (err) {
        this.#log({ event: "operation.on_give_up_failed", operationId: ctx.operation.id, error: String(err) });
      }
    }
  }

  async #finish(op: Operation, update: FinishUpdate): Promise<boolean> {
    const finished = await finishOperation(this.#db, op.id, this.#workerId, update);
    if (finished && update.status !== "queued") {
      try {
        await recordAudit(this.#db, {
          actor: { kind: "system" },
          action: `operation.${op.kind}`,
          resourceType: op.resourceType,
          resourceId: op.resourceId,
          correlationId: op.correlationId,
          outcome: update.status,
          metadata: { operationId: op.id, code: update.errorCode ?? null, attempts: op.attempts },
        });
      } catch (err) {
        // The transition is committed; a missing audit row is logged loudly
        // rather than turned into a second, contradictory state change.
        this.#log({ event: "operation.audit_failed", operationId: op.id, error: String(err) });
      }
    }
    this.#log({
      event: finished ? "operation.transition" : "operation.lease_lost",
      operationId: op.id,
      kind: op.kind,
      status: update.status,
      code: update.errorCode ?? undefined,
    });
    return finished;
  }
}
