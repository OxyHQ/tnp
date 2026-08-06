import { eq } from "drizzle-orm";
import { isReservedTld } from "@tnp/namespace";
import { connectPostgres, closePostgres, getDb } from "./db/postgres.js";
import { runMigrations } from "./db/migrate.js";
import { tlds } from "./db/schema/index.js";

/**
 * Only TNP-native TLDs.
 *
 * `.com` and `.app` were seeded here as TNP TLDs, which is what let a TNP
 * registration change what a public name resolved to for TNP users (audit S4).
 * They are refused by the registry now; the migration for names already
 * registered under them is docs/architecture/naming.md §6.
 */
export const initialTLDs = [{ name: "ox", status: "active" as const, custom: true }];

/**
 * Idempotent. Under Mongoose this was a startup side effect guarded by "is the
 * collection empty"; as an upsert it can run on every boot without depending on
 * that, and without silently skipping a new TLD because some other row exists.
 */
export async function runSeed(): Promise<void> {
  const db = getDb();

  for (const tld of initialTLDs) {
    // Belt and braces: the registry refuses reserved TLDs, and the seed cannot
    // introduce one behind its back either.
    if (isReservedTld(tld.name)) {
      throw new Error(`Refusing to seed reserved TLD .${tld.name}`);
    }

    const inserted = await db
      .insert(tlds)
      .values(tld)
      .onConflictDoNothing({ target: tlds.name })
      .returning({ id: tlds.id });

    if (inserted.length > 0) console.log(`  Seeded .${tld.name}`);
  }
}

const isMain = process.argv[1]?.endsWith("seed.ts");
if (isMain) {
  await runMigrations();
  await connectPostgres();
  await runSeed();
  console.log("Seed complete");
  await closePostgres();
  process.exit(0);
}
