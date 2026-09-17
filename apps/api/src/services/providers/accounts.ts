/**
 * Loading provider accounts and enforcing their modes.
 *
 * Sales and management are separate switches (services.md §4, §10 of the
 * issue): an account with `sales_state = 'sales_disabled'` refuses new
 * purchases but keeps renewing, syncing and editing what already exists; only
 * `management_mode` stops those.
 */

import { and, eq } from "drizzle-orm";
import type { Database } from "../../db/postgres.js";
import { providerAccounts } from "../../db/schema/index.js";
import type { ProviderEnvironment } from "./contracts.js";
import { ProviderError } from "./errors.js";
import type { ProviderAccountConfig } from "./registry.js";

export type ProviderAccountRow = typeof providerAccounts.$inferSelect;

export function toAccountConfig(row: ProviderAccountRow): ProviderAccountConfig {
  return {
    ref: { id: row.id, adapter: row.adapter, environment: row.environment },
    config: row.config,
    secretRef: row.secretRef,
  };
}

export type AccountUse = "sell" | "read" | "write";

/** Throws unless the account may be used for `use`. */
export function assertAccountUsable(row: ProviderAccountRow, use: AccountUse): void {
  if (row.managementMode === "disabled") {
    throw new ProviderError("credentials", `provider account ${row.id} is disabled`, {
      safeMessage: "This provider account is not available.",
    });
  }
  if (use !== "read" && row.managementMode === "read_only") {
    throw new ProviderError("credentials", `provider account ${row.id} is read-only`, {
      safeMessage: "Changes through this provider are paused.",
    });
  }
  if (use === "sell" && row.salesState !== "enabled") {
    throw new ProviderError("not_available", `provider account ${row.id} is not selling`, {
      safeMessage: "New purchases through this provider are paused.",
    });
  }
}

export async function loadProviderAccount(db: Database, id: string): Promise<ProviderAccountRow> {
  const [row] = await db.select().from(providerAccounts).where(eq(providerAccounts.id, id)).limit(1);
  if (!row) throw new ProviderError("credentials", `provider account ${id} does not exist`);
  return row;
}

/**
 * The account new purchases go through, for one adapter family and
 * environment. More than one selling account is an explicit configuration
 * error until a selection policy (services.md §3) is approved — silently
 * picking the first row would be exactly the "insertion order" choice the
 * ecosystem forbids.
 */
export async function selectSellingAccount(
  db: Database,
  environment: ProviderEnvironment,
): Promise<ProviderAccountRow | null> {
  const rows = await db
    .select()
    .from(providerAccounts)
    .where(
      and(
        eq(providerAccounts.environment, environment),
        eq(providerAccounts.salesState, "enabled"),
        eq(providerAccounts.managementMode, "active"),
      ),
    );
  if (rows.length > 1) {
    throw new ProviderError("credentials", `${rows.length} selling accounts in ${environment}; no selection policy is approved`, {
      safeMessage: "Purchases are temporarily unavailable.",
    });
  }
  return rows[0] ?? null;
}
