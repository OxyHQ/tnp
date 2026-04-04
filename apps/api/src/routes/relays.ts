import { Router } from "express";
import Relay from "../models/Relay.js";
import { requireAuth } from "../middleware/auth.js";
import type { AuthRequest } from "../middleware/auth.js";

const router = Router();

// GET /relays -- list active relays (public)
router.get("/", async (req, res) => {
  try {
    const operatorFilter = req.query.operator;

    const query: Record<string, unknown> = {
      status: { $ne: "offline" },
    };

    if (operatorFilter === "oxy" || operatorFilter === "community") {
      query.operator = operatorFilter;
    }

    const relays = await Relay.find(query)
      .select("endpoint publicKey operator location status")
      .sort({ status: 1, endpoint: 1 });

    res.json(relays);
  } catch (err) {
    console.error("List relays error:", err);
    res.status(500).json({ error: "Failed to list relays" });
  }
});

// POST /relays/register -- register a relay node (auth required)
router.post("/register", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { endpoint, publicKey, operator, capacity, location } = req.body;

    if (!endpoint || typeof endpoint !== "string") {
      res.status(400).json({ error: "endpoint is required" });
      return;
    }
    if (!publicKey || typeof publicKey !== "string") {
      res.status(400).json({ error: "publicKey is required" });
      return;
    }
    if (operator !== "oxy" && operator !== "community") {
      res.status(400).json({ error: "operator must be 'oxy' or 'community'" });
      return;
    }
    if (
      !capacity ||
      typeof capacity.maxConnections !== "number" ||
      typeof capacity.bandwidth !== "number"
    ) {
      res.status(400).json({
        error: "capacity with maxConnections and bandwidth is required",
      });
      return;
    }

    const relay = await Relay.findOneAndUpdate(
      { endpoint },
      {
        endpoint,
        publicKey,
        operator,
        operatorUserId: req.user!.id,
        capacity,
        location: location || "",
        lastSeen: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(201).json(relay);
  } catch (err) {
    console.error("Register relay error:", err);
    res.status(500).json({ error: "Failed to register relay" });
  }
});

// POST /relays/heartbeat -- update relay status (auth required)
router.post("/heartbeat", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { endpoint } = req.body;

    if (!endpoint || typeof endpoint !== "string") {
      res.status(400).json({ error: "endpoint is required" });
      return;
    }

    const relay = await Relay.findOne({ endpoint });
    if (!relay) {
      res.status(404).json({ error: "Relay not found" });
      return;
    }

    if (relay.operatorUserId !== req.user!.id) {
      res.status(403).json({ error: "You do not operate this relay" });
      return;
    }

    relay.lastSeen = new Date();
    relay.status = "active";
    await relay.save();

    res.json({ status: "ok" });
  } catch (err) {
    console.error("Relay heartbeat error:", err);
    res.status(500).json({ error: "Failed to update heartbeat" });
  }
});

export default router;
