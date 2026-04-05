import mongoose from "mongoose";
import { config } from "./config.js";
import TLD from "./models/TLD.js";

const initialTLDs = [
  { name: "ox", status: "active" as const, custom: true },
  { name: "app", status: "active" as const, custom: false },
  { name: "com", status: "active" as const, custom: false },
];

export async function runSeed() {
  // Ensure existing TLDs have the custom flag set
  await TLD.updateMany({ name: { $in: ["com", "app"] }, custom: { $exists: false } }, { $set: { custom: false } });
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
