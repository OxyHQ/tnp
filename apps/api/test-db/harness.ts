/**
 * Real-PostgreSQL test harness.
 *
 * Constraints, locks, `ON CONFLICT` and `FOR UPDATE SKIP LOCKED` are properties
 * of the server, not of drizzle's query builder, so a fake cannot test them.
 * Every file gets its own freshly migrated database, created from
 * `TEST_DATABASE_URL` (a role allowed to `CREATE DATABASE`) and dropped when
 * the file finishes, so no file can read another's rows.
 *
 * `bun run test:db` requires the variable and fails without it. It is a
 * separate command from `bun run test` rather than a suite that skips itself
 * when the variable is missing: a skipped suite reads as a passing one.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { runMigrations } from "../src/db/migrate.js";
import { DATABASE_CASING } from "../src/db/casing.js";
import * as schema from "../src/db/schema/index.js";

export type TestDb = ReturnType<typeof drizzleFor>;

function drizzleFor(client: postgres.Sql) {
  return drizzle(client, { schema, casing: DATABASE_CASING });
}

export interface TestDatabase {
  /** Connection string for the migrated database, for code that opens its own pool. */
  readonly url: string;
  readonly sql: postgres.Sql;
  readonly db: TestDb;
  /** Close every connection this harness opened and drop the database. */
  drop(): Promise<void>;
}

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. `bun run test:db` needs a PostgreSQL server " +
        "and a role that may CREATE DATABASE, e.g. postgres://tnp:tnp@127.0.0.1:5434/postgres",
    );
  }
  return url;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const admin = adminUrl();
  const name = `tnp_test_${crypto.randomUUID().replaceAll("-", "")}`;

  const control = postgres(admin, { max: 1, onnotice: () => {} });
  try {
    // An identifier cannot be a bind parameter; `name` is generated above from
    // hex digits only.
    await control.unsafe(`create database ${name}`);
  } finally {
    await control.end({ timeout: 5 });
  }

  const url = withDatabase(admin, name);
  await runMigrations(url);

  const sql = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzleFor(sql);

  return {
    url,
    sql,
    db,
    async drop() {
      await sql.end({ timeout: 5 });
      const cleanup = postgres(admin, { max: 1, onnotice: () => {} });
      try {
        await cleanup.unsafe(`drop database if exists ${name} with (force)`);
      } finally {
        await cleanup.end({ timeout: 5 });
      }
    },
  };
}
