import { defineConfig } from "drizzle-kit";
import { DATABASE_CASING } from "./src/db/casing";

/**
 * drizzle-kit configuration.
 *
 * `bun run db:generate` diffs the schema against `drizzle/` and writes a new
 * SQL migration. It never opens a database and only runs on a developer's
 * machine.
 *
 * Migrations are APPLIED by `src/db/migrate.ts` using drizzle-orm's own
 * migrator over the files in `drizzle/` — not by `drizzle-kit migrate`.
 * drizzle-kit is a devDependency and the shipped image installs it only
 * incidentally; relying on the CLI in production would make the deploy depend
 * on a tool that is not part of the runtime contract.
 *
 * `casing` decides what the DDL CREATES; the same value passed to `drizzle()`
 * in `src/db/postgres.ts` decides what queries REFERENCE. Both read it from
 * `src/db/casing.ts` so they cannot drift apart.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  casing: DATABASE_CASING,
  strict: true,
  verbose: true,
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
