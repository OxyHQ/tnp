import { Router } from "express";
import mongoose from "mongoose";
import TLD from "../models/TLD.js";
import TLDProposal from "../models/TLDProposal.js";
import User from "../models/User.js";
import Vote from "../models/Vote.js";
import { requireOxyAuth, getOxyUserId, getRequiredOxyUserId } from "@oxyhq/core/server";
import { isReservedTld, validateNativeTld } from "@tnp/namespace";

const router = Router();

async function findOrCreateUser(oxyUserId: string) {
  let user = await User.findOne({ oxyUserId });
  if (!user) {
    user = await User.create({ oxyUserId });
  }
  return user;
}

// GET /tlds -- list all active TNP-native TLDs
//
// Reserved TLDs are filtered out at read time, not only at write time: a
// database seeded before the namespace policy landed still holds `.com` and
// `.app` rows, and publishing those is what made clients shadow public names
// (docs/architecture/naming.md §6, migration step M1). This makes the fix take
// effect on existing deployments without waiting for a data migration.
router.get("/", async (_req, res) => {
  try {
    const tlds = await TLD.find({ status: "active" }).sort({ name: 1 });
    res.json(tlds.filter((t) => !isReservedTld(t.name)));
  } catch (err) {
    console.error("List TLDs error:", err);
    res.status(500).json({ error: "Failed to list TLDs" });
  }
});

// POST /tlds/propose -- propose a new TLD (auth required)
router.post("/propose", requireOxyAuth, async (req, res) => {
  try {
    const { tld, reason } = req.body;

    if (!tld || typeof tld !== "string") {
      res.status(400).json({ error: "tld is required" });
      return;
    }
    if (!reason || typeof reason !== "string") {
      res.status(400).json({ error: "reason is required" });
      return;
    }

    const name = tld.toLowerCase().replace(/^\./, "");

    // Rule N3: a native TLD must pass the reserved check at proposal time as
    // well as at approval time. Proposing `.com` should fail here, not survive
    // to a vote and then be caught (or not) by whoever approves it.
    const policy = validateNativeTld(name);
    if (!policy.ok) {
      res
        .status(policy.reason === "reserved" ? 403 : 400)
        .json({ error: policy.reason === "reserved" ? "TLD_RESERVED" : "TLD_INVALID", detail: policy.detail });
      return;
    }

    const existing = await TLD.findOne({ name });
    if (existing) {
      res.status(409).json({ error: `TLD .${name} already exists` });
      return;
    }

    const user = await findOrCreateUser(getRequiredOxyUserId(req));

    const proposal = await TLDProposal.create({
      tld: name,
      proposedBy: user._id,
      reason,
    });

    await TLD.create({
      name,
      status: "proposed",
      proposedBy: user._id,
    });

    res.status(201).json(proposal);
  } catch (err) {
    console.error("Propose TLD error:", err);
    res.status(500).json({ error: "Failed to propose TLD" });
  }
});

// GET /tlds/proposals -- list all proposals with scores
router.get("/proposals", async (req, res) => {
  try {
    let userId: mongoose.Types.ObjectId | null = null;
    const callerId = getOxyUserId(req);
    if (callerId) {
      const user = await User.findOne({ oxyUserId: callerId });
      if (user) userId = user._id;
    }

    const proposals = await TLDProposal.aggregate([
      {
        $lookup: {
          from: "votes",
          localField: "_id",
          foreignField: "proposal",
          as: "votesDocs",
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "proposedBy",
          foreignField: "_id",
          as: "proposedByDoc",
        },
      },
      { $unwind: { path: "$proposedByDoc", preserveNullAndEmptyArrays: true } },
      {
        $addFields: {
          score: {
            $ifNull: [
              {
                $subtract: [
                  { $size: { $filter: { input: { $ifNull: ["$votesDocs", []] }, cond: { $eq: ["$$this.direction", "up"] } } } },
                  { $size: { $filter: { input: { $ifNull: ["$votesDocs", []] }, cond: { $eq: ["$$this.direction", "down"] } } } },
                ],
              },
              0,
            ],
          },
          userVote: userId
            ? {
                $let: {
                  vars: {
                    myVote: {
                      $arrayElemAt: [
                        { $filter: { input: { $ifNull: ["$votesDocs", []] }, cond: { $eq: ["$$this.user", userId] } } },
                        0,
                      ],
                    },
                  },
                  in: { $ifNull: ["$$myVote.direction", null] },
                },
              }
            : null,
          proposedBy: {
            _id: "$proposedByDoc._id",
            oxyUserId: "$proposedByDoc.oxyUserId",
          },
        },
      },
      { $project: { votesDocs: 0, proposedByDoc: 0, votes: 0 } },
      { $sort: { score: -1, createdAt: -1 } },
    ]);

    res.json(proposals);
  } catch (err) {
    console.error("List proposals error:", err);
    res.status(500).json({ error: "Failed to list proposals" });
  }
});

// POST /tlds/proposals/:id/vote -- upvote or downvote (auth required)
router.post("/proposals/:id/vote", requireOxyAuth, async (req, res) => {
  try {
    const { direction } = req.body;

    if (direction !== "up" && direction !== "down") {
      res.status(400).json({ error: "direction must be 'up' or 'down'" });
      return;
    }

    const proposal = await TLDProposal.findById(req.params.id);
    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    if (proposal.status !== "open") {
      res.status(400).json({ error: "Can only vote on open proposals" });
      return;
    }

    const user = await findOrCreateUser(getRequiredOxyUserId(req));

    if (proposal.proposedBy.equals(user._id)) {
      res.status(403).json({ error: "Cannot vote on your own proposal" });
      return;
    }

    await Vote.findOneAndUpdate(
      { proposal: proposal._id, user: user._id },
      { direction },
      { upsert: true }
    );

    const [counts] = await Vote.aggregate([
      { $match: { proposal: proposal._id } },
      {
        $group: {
          _id: null,
          up: { $sum: { $cond: [{ $eq: ["$direction", "up"] }, 1, 0] } },
          down: { $sum: { $cond: [{ $eq: ["$direction", "down"] }, 1, 0] } },
        },
      },
    ]);

    const score = counts ? counts.up - counts.down : 0;

    res.json({ score, userVote: direction });
  } catch (err) {
    console.error("Vote error:", err);
    res.status(500).json({ error: "Failed to vote" });
  }
});

// DELETE /tlds/proposals/:id/vote -- remove vote (auth required)
router.delete("/proposals/:id/vote", requireOxyAuth, async (req, res) => {
  try {
    const proposal = await TLDProposal.findById(req.params.id);
    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }

    const user = await findOrCreateUser(getRequiredOxyUserId(req));

    await Vote.deleteOne({ proposal: proposal._id, user: user._id });

    const [counts] = await Vote.aggregate([
      { $match: { proposal: proposal._id } },
      {
        $group: {
          _id: null,
          up: { $sum: { $cond: [{ $eq: ["$direction", "up"] }, 1, 0] } },
          down: { $sum: { $cond: [{ $eq: ["$direction", "down"] }, 1, 0] } },
        },
      },
    ]);

    const score = counts ? counts.up - counts.down : 0;

    res.json({ score, userVote: null });
  } catch (err) {
    console.error("Remove vote error:", err);
    res.status(500).json({ error: "Failed to remove vote" });
  }
});

export default router;
