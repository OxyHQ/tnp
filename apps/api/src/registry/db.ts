import type { Database } from "../db/postgres.js";

/**
 * A handle a registry function can run statements on: the pool, or a
 * transaction opened on it.
 *
 * The registry functions take one as a parameter instead of calling `getDb()`
 * so the real-PostgreSQL tests run the shipped statements against their own
 * database — a test that re-implemented the SQL would measure the copy.
 */
export type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];
