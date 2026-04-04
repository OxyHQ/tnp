import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import TLDProposal from "../models/TLDProposal.js";
import TLD from "../models/TLD.js";
import Vote from "../models/Vote.js";

const APP_NAME = "tnp";
const env = process.env.NODE_ENV || "development";
const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017";
const dbName = `${APP_NAME}-${env}`;

async function approveTopProposals() {
  await mongoose.connect(mongoUri, { dbName });
  console.log(`Connected to MongoDB (${dbName})`);

  // Ensure the Vote model is registered so the "votes" collection is known
  void Vote;

  const ranked = await TLDProposal.aggregate([
    { $match: { status: "open" } },
    {
      $lookup: {
        from: "votes",
        localField: "_id",
        foreignField: "proposal",
        as: "votesDocs",
      },
    },
    {
      $addFields: {
        score: {
          $subtract: [
            {
              $size: {
                $filter: {
                  input: "$votesDocs",
                  cond: { $eq: ["$$this.direction", "up"] },
                },
              },
            },
            {
              $size: {
                $filter: {
                  input: "$votesDocs",
                  cond: { $eq: ["$$this.direction", "down"] },
                },
              },
            },
          ],
        },
      },
    },
    { $match: { score: { $gt: 0 } } },
    { $sort: { score: -1, createdAt: 1 } },
    { $limit: 5 },
    { $project: { _id: 1, tld: 1, score: 1 } },
  ]);

  if (ranked.length === 0) {
    console.log("No open proposals with positive score. Nothing to approve.");
    await mongoose.disconnect();
    return;
  }

  for (const entry of ranked) {
    await TLDProposal.updateOne(
      { _id: entry._id },
      { $set: { status: "approved" } }
    );
    await TLD.updateOne(
      { name: entry.tld },
      { $set: { status: "active" } }
    );
    console.log(`Approved .${entry.tld} (score: ${entry.score})`);
  }

  console.log(`Approved ${ranked.length} proposal(s).`);
  await mongoose.disconnect();
}

approveTopProposals().catch((err) => {
  console.error("Auto-approval failed:", err);
  process.exit(1);
});
