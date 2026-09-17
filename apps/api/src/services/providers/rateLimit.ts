/**
 * Provider quota shared by every API and worker replica.
 *
 * An in-memory limiter per process would let N replicas spend N times the
 * provider's quota. Counters live in `provider_rate_windows`, one row per
 * account per minute/hour/day window, and admission locks the three rows in a
 * fixed order inside one transaction, so two replicas cannot both take the
 * last slot.
 *
 * Interactive traffic may use only `1 - criticalReserve` of each window; the
 * reserve is kept for renewals and reconciliation (services.md §7).
 */

import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../../db/postgres.js";
import { providerAccounts, providerRateWindows } from "../../db/schema/index.js";
import { ProviderError } from "./errors.js";
import type { QuotaGate, QuotaPriority } from "./registry.js";

export interface QuotaLimits {
  readonly perMinute: number;
  readonly perHour: number;
  readonly perDay: number;
  /** Share of each window reserved for `critical` calls, 0–1. */
  readonly criticalReserve: number;
}

/**
 * Published per-key limits. Namecheap: 50/min, 700/hour, 8000/day
 * (docs/providers/namecheap.md). An adapter without an entry gets the most
 * conservative limits rather than none.
 */
export const DEFAULT_LIMITS: Readonly<Record<string, QuotaLimits>> = {
  namecheap: { perMinute: 50, perHour: 700, perDay: 8000, criticalReserve: 0.2 },
};
const FALLBACK_LIMITS: QuotaLimits = { perMinute: 10, perHour: 100, perDay: 1000, criticalReserve: 0.2 };

const WINDOWS = [
  { kind: "minute", limit: (l: QuotaLimits) => l.perMinute, ms: 60_000 },
  { kind: "hour", limit: (l: QuotaLimits) => l.perHour, ms: 3_600_000 },
  { kind: "day", limit: (l: QuotaLimits) => l.perDay, ms: 86_400_000 },
] as const;

export function capacityFor(limit: number, priority: QuotaPriority, reserve: number): number {
  return priority === "critical" ? limit : Math.floor(limit * (1 - reserve));
}

export function createPostgresQuotaGate(
  db: Database,
  limitsByAdapter: Readonly<Record<string, QuotaLimits>> = DEFAULT_LIMITS,
): QuotaGate {
  return {
    async acquire(accountId: string, priority: QuotaPriority) {
      await db.transaction(async (tx) => {
        const [account] = await tx
          .select({ adapter: providerAccounts.adapter })
          .from(providerAccounts)
          .where(eq(providerAccounts.id, accountId))
          .limit(1);
        if (!account) throw new ProviderError("credentials", `provider account ${accountId} does not exist`);
        const limits = limitsByAdapter[account.adapter] ?? FALLBACK_LIMITS;

        // `now()` is fixed for the transaction, so all three windows are
        // computed from the same instant.
        await tx
          .insert(providerRateWindows)
          .values(
            WINDOWS.map((w) => ({
              providerAccountId: accountId,
              window: w.kind,
              windowStart: sql`date_trunc(${w.kind}, now())`,
              count: 0,
            })),
          )
          .onConflictDoNothing();

        const rows = await tx
          .select({ window: providerRateWindows.window, count: providerRateWindows.count })
          .from(providerRateWindows)
          .where(
            and(
              eq(providerRateWindows.providerAccountId, accountId),
              sql`${providerRateWindows.windowStart} = date_trunc(${providerRateWindows.window}::text, now())`,
            ),
          )
          .orderBy(providerRateWindows.window)
          .for("update");

        for (const w of WINDOWS) {
          const row = rows.find((r) => r.window === w.kind);
          const capacity = capacityFor(w.limit(limits), priority, limits.criticalReserve);
          if (!row || row.count >= capacity) {
            throw new ProviderError("rate_limited", `${priority} quota for ${w.kind} exhausted on ${accountId}`, {
              submitted: false,
              retryAfterMs: w.ms - (Date.now() % w.ms),
            });
          }
        }

        await tx
          .update(providerRateWindows)
          .set({ count: sql`${providerRateWindows.count} + 1` })
          .where(
            and(
              eq(providerRateWindows.providerAccountId, accountId),
              sql`${providerRateWindows.windowStart} = date_trunc(${providerRateWindows.window}::text, now())`,
            ),
          );
      });
    },
  };
}

/** Delete windows older than two days. Run periodically by the worker. */
export async function pruneRateWindows(db: Database): Promise<void> {
  await db
    .delete(providerRateWindows)
    .where(sql`${providerRateWindows.windowStart} < now() - interval '2 days'`);
}
