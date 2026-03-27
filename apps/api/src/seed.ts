import mongoose from "mongoose";
import { config } from "./config.js";
import TLD from "./models/TLD.js";

const initialTLDs = [
  { name: "ox", status: "active" as const },
  { name: "app", status: "active" as const },
  { name: "com", status: "active" as const },
];

async function seed() {
  await mongoose.connect(config.mongoUri, { dbName: config.dbName });
  console.log(`Connected to MongoDB (${config.dbName})`);

  for (const tld of initialTLDs) {
    const existing = await TLD.findOne({ name: tld.name });
    if (existing) {
      console.log(`  .${tld.name} already exists, skipping`);
    } else {
      await TLD.create(tld);
      console.log(`  .${tld.name} created`);
    }
  }

  console.log("Seed complete");
  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
