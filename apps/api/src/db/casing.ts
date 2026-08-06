import type { Casing } from "drizzle-orm/utils";

/**
 * Column-naming authority.
 *
 * Schema modules declare columns in camelCase and let drizzle derive the
 * snake_case SQL name. That derivation happens in two places that must agree,
 * or queries reference columns the migrations never created: `drizzle()` in
 * `postgres.ts` (what queries reference) and drizzle-kit in `drizzle.config.ts`
 * (what the DDL creates). Both read this constant, so there is one setting
 * rather than two copies to keep in lockstep.
 */
export const DATABASE_CASING: Casing = "snake_case";
