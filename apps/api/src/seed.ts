import mongoose from "mongoose";
import { config } from "./config.js";
import TLD from "./models/TLD.js";

// Only TNP-native TLDs. `.com` and `.app` were seeded here as TNP TLDs, which
// is what let a TNP registration change what a public name resolved to for TNP
// users (audit S4). They are rejected by the registry now; the migration for
// names already registered under them is docs/architecture/naming.md §6.
export const initialTLDs = [{ name: "ox", status: "active" as const, custom: true }];

export async function runSeed() {
  await TLD.updateMany({ custom: { $exists: false } }, { $set: { custom: true } });

  const count = await TLD.countDocuments();
  if (count > 0) return;

  for (const tld of initialTLDs) {
    await TLD.create(tld);
    console.log(`  Seeded .${tld.name}`);
  }
  console.log("Seed complete");
}

// Allow running as standalone script
const isMain = process.argv[1]?.endsWith("seed.ts") || process.argv[1]?.endsWith("seed.js");
if (isMain) {
  mongoose
    .connect(config.mongoUri, { dbName: config.dbName })
    .then(() => {
      console.log(`Connected to MongoDB (${config.dbName})`);
      return runSeed();
    })
    .then(() => mongoose.disconnect())
    .catch((err) => {
      console.error("Seed failed:", err);
      process.exit(1);
    });
}
