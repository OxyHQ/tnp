import { Router } from "express";
import TLD from "../models/TLD.js";
import TLDProposal from "../models/TLDProposal.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

// GET /tlds -- list all active TLDs
router.get("/", async (_req, res) => {
  try {
    const tlds = await TLD.find({ status: "active" }).sort({ name: 1 });
    res.json(tlds);
  } catch (err) {
    console.error("List TLDs error:", err);
    res.status(500).json({ error: "Failed to list TLDs" });
  }
});

// POST /tlds/propose -- propose a new TLD (auth required)
router.post("/propose", requireAuth, async (req, res) => {
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

    if (!/^[a-z][a-z0-9]{0,19}$/.test(name)) {
      res
        .status(400)
        .json({ error: "TLD must be 1-20 lowercase alphanumeric characters" });
      return;
    }

    const existing = await TLD.findOne({ name });
    if (existing) {
      res.status(409).json({ error: `TLD .${name} already exists` });
      return;
    }

    const proposal = await TLDProposal.create({
      tld: name,
      proposedBy: req.auth!.userId,
      reason,
    });

    await TLD.create({
      name,
      status: "proposed",
      proposedBy: req.auth!.userId,
    });

    res.status(201).json(proposal);
  } catch (err) {
    console.error("Propose TLD error:", err);
    res.status(500).json({ error: "Failed to propose TLD" });
  }
});

// GET /tlds/proposals -- list all proposals
router.get("/proposals", async (_req, res) => {
  try {
    const proposals = await TLDProposal.find()
      .sort({ votes: -1, createdAt: -1 })
      .populate("proposedBy", "oxyUserId");
    res.json(proposals);
  } catch (err) {
    console.error("List proposals error:", err);
    res.status(500).json({ error: "Failed to list proposals" });
  }
});

export default router;
