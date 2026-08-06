/**
 * PostgreSQL connection.
 *
 * One pool per process, opened at startup. TNP ran on MongoDB via Mongoose;
 * every other Oxy backend that has migrated uses drizzle over postgres.js, and
 * TNP is not special enough to be the exception.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { config } from "../config.js";
import { DATABASE_CASING } from "./casing.js";
import * as schema from "./schema/index.js";

export type Database = ReturnType<typeof createDb>;

function createDb(client: postgres.Sql) {
  // Drizzle applies `casing` at RUNTIME when building SQL; drizzle-kit applies
  // it at GENERATE time when emitting DDL. They must agree or queries reference
  // columns the migrations never created — so both read the same constant.
  return drizzle(client, { schema, casing: DATABASE_CASING });
}

let client: postgres.Sql | null = null;
let db: Database | null = null;

const CLOSE_TIMEOUT_SECONDS = 5;

export async function connectPostgres(): Promise<Database> {
  if (db) return db;

  if (!config.databaseUrl) {
    throw new Error(
      "DATABASE_URL is not set. Start a local Postgres with:\n" +
        "  docker run -d --name tnp-postgres -p 5434:5432 -e POSTGRES_PASSWORD=tnp -e POSTGRES_DB=tnp postgres:17\n" +
        "then set DATABASE_URL in apps/api/.env.",
    );
  }

  const instance = postgres(config.databaseUrl, {
    max: config.postgresMaxPoolSize,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  // postgres.js connects lazily, so constructing the pool proves nothing. Issue
  // a real round trip here so an unreachable or misconfigured database fails at
  // startup rather than on the first user request — and only publish the handle
  // once that round trip succeeded.
  try {
    await instance`select 1`;
  } catch (err) {
    await instance.end({ timeout: CLOSE_TIMEOUT_SECONDS });
    throw err;
  }

  client = instance;
  db = createDb(instance);
  return db;
}

/**
 * The connection opened by `connectPostgres()`.
 *
 * Throws if called before startup finished — a programming error (a query
 * issued too early), not a runtime condition to recover from.
 */
export function getDb(): Database {
  if (!db) {
    throw new Error("getDb() called before connectPostgres() resolved");
  }
  return db;
}

export async function closePostgres(): Promise<void> {
  if (client) {
    await client.end({ timeout: CLOSE_TIMEOUT_SECONDS });
    client = null;
    db = null;
  }
}
