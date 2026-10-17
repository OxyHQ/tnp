/**
 * Apply pending migrations.
 *
 * Runs over the SQL in `drizzle/`, so dev, CI, the test harness and production
 * all run the same code path. Running migrations from the application process
 * — rather than a separate CLI step — means a deploy cannot start serving
 * against a schema it has not migrated.
 *
 * ONE TRANSACTION PER MIGRATION. drizzle's `migrate()` applies every pending
 * migration in a single transaction, so the first migration's ACCESS EXCLUSIVE
 * lock would be held, and every reader of that table queued behind it, until
 * the last one committed: the 2026-10-16 outage on the shared RDS (oxy#1778).
 * Each migration here commits on its own under a short lock_timeout and a
 * bounded statement_timeout (a file may raise its own with
 * `-- oxy:statement-timeout=<n>s`), and is retried with backoff when its locks
 * do not come — the contract `@oxy.so/db` gives every Oxy backend, with its
 * helpers. Pending is decided exactly as drizzle decides it, and each ledger
 * row is the one drizzle would write.
 *
 * Every API task and the commerce worker migrate at boot, so the run holds a
 * session advisory lock on its one dedicated connection: a second process
 * waits, then finds nothing pending.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_LOCK_ATTEMPTS,
  DEFAULT_LOCK_RETRY_BASE_DELAY_MS,
  DEFAULT_LOCK_RETRY_MAX_DELAY_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  isLockContention,
  lockRetryDelayMs,
  readMigrationStatementTimeouts,
} from '@oxy.so/db/migrate';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from '../config.js';

const MIGRATIONS_FOLDER = join(import.meta.dir, '..', '..', 'drizzle');

/** ASCII "tnp_migr" as one int8: the advisory-lock key for schema migrations. */
const MIGRATION_LOCK_KEY = '0x746e705f6d696772';

const LEDGER = sql`"drizzle"."__drizzle_migrations"`;

export async function runMigrations(
  url: string = config.databaseUrl,
  options: {
    log?: (line: string) => void;
    lockTimeoutMs?: number;
    migrationsFolder?: string;
  } = {},
): Promise<string[]> {
  if (!url) throw new Error('DATABASE_URL is required to run migrations');
  const log = options.log ?? ((line: string) => console.log(line));
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const folder = options.migrationsFolder ?? MIGRATIONS_FOLDER;

  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const tags = journal.entries.map((entry) => entry.tag);
  const timeouts = readMigrationStatementTimeouts(tags, folder);
  if (timeouts.problems.length > 0) {
    throw new Error(`illegible statement-timeout marker(s): ${timeouts.problems.join('; ')}`);
  }
  const files = readMigrationFiles({ migrationsFolder: folder });

  // One dedicated connection: the advisory lock and every migration live on it.
  const client = postgres(url, { max: 1, idle_timeout: 0, max_lifetime: null, onnotice: () => {} });
  try {
    await client.unsafe(`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`);
    const db = drizzle(client);
    await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS ${LEDGER} (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    const [last] = await client<{ created_at: string }[]>`
      select created_at::text from "drizzle"."__drizzle_migrations" order by created_at desc limit 1`;
    const newest = last ? Number(last.created_at) : Number.NEGATIVE_INFINITY;

    const applied: string[] = [];
    for (const [index, migration] of files.entries()) {
      if (migration.folderMillis <= newest) continue;
      const tag = tags[index] ?? String(migration.folderMillis);
      const statementTimeoutMs =
        timeouts.statementTimeoutsMs.get(tag) ?? DEFAULT_STATEMENT_TIMEOUT_MS;
      for (let attempt = 1; ; attempt += 1) {
        try {
          await client.unsafe(`set lock_timeout = '${lockTimeoutMs}ms'`);
          await client.unsafe(`set statement_timeout = '${statementTimeoutMs}ms'`);
          await db.transaction(async (tx) => {
            for (const statement of migration.sql) await tx.execute(sql.raw(statement));
            await tx.execute(
              sql`insert into ${LEDGER} ("hash", "created_at") values (${migration.hash}, ${migration.folderMillis})`,
            );
          });
          break;
        } catch (error) {
          if (!isLockContention(error)) throw error;
          if (attempt >= DEFAULT_LOCK_ATTEMPTS) {
            throw new Error(
              `${tag} could not take its locks within ${lockTimeoutMs}ms on any of ${DEFAULT_LOCK_ATTEMPTS} attempts; nothing of it was applied`,
              { cause: error },
            );
          }
          const delayMs = lockRetryDelayMs(
            attempt,
            DEFAULT_LOCK_RETRY_BASE_DELAY_MS,
            DEFAULT_LOCK_RETRY_MAX_DELAY_MS,
          );
          log(
            `${tag}: lock not available (attempt ${attempt}); rolled back, retrying in ${delayMs}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
      log(`Applied migration ${tag}`);
      applied.push(tag);
    }
    return applied;
  } finally {
    // Closing the session releases the advisory lock with it.
    await client.end({ timeout: 5 });
  }
}

const isMain = process.argv[1]?.endsWith('migrate.ts');
if (isMain) {
  await runMigrations();
  console.log('Migrations applied');
  process.exit(0);
}
