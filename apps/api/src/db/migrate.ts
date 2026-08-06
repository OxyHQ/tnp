/**
 * Apply pending migrations.
 *
 * Uses drizzle-orm's migrator over the SQL in `drizzle/`, so dev, CI, the test
 * harness and production all run the same code path. Running migrations from
 * the application process — rather than a separate CLI step — means a deploy
 * cannot start serving against a schema it has not migrated.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { join } from "path";
import { config } from "../config.js";

const MIGRATIONS_FOLDER = join(import.meta.dir, "..", "..", "drizzle");

export async function runMigrations(url: string = config.databaseUrl): Promise<void> {
  if (!url) throw new Error("DATABASE_URL is required to run migrations");

  // A dedicated single connection: the migrator takes an advisory lock, and
  // holding that on a pooled connection risks it being handed out mid-migration.
  const client = postgres(url, { max: 1 });
  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end({ timeout: 5 });
  }
}

const isMain = process.argv[1]?.endsWith("migrate.ts");
if (isMain) {
  await runMigrations();
  console.log("Migrations applied");
  process.exit(0);
}
