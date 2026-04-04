import { Router } from "express";
import Domain from "../models/Domain.js";
import TLD from "../models/TLD.js";
import ServiceNode from "../models/ServiceNode.js";
import { requireAuth } from "../middleware/auth.js";
import type { AuthRequest } from "../middleware/auth.js";

const router = Router();

// POST /nodes/register -- register a service node for a domain (auth required)
router.post("/register", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { domainId, publicKey } = req.body;

    if (!domainId || typeof domainId !== "string") {
      res.status(400).json({ error: "domainId is required" });
      return;
    }
    if (!publicKey || typeof publicKey !== "string") {
      res.status(400).json({ error: "publicKey is required" });
      return;
    }

    const domain = await Domain.findById(domainId);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    if (domain.oxyUserId !== req.user!.id) {
      res.status(403).json({ error: "You do not own this domain" });
      return;
    }

    const node = await ServiceNode.findOneAndUpdate(
      { domainId: domain._id },
      {
        domainId: domain._id,
        oxyUserId: req.user!.id,
        publicKey,
        lastSeen: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await Domain.findByIdAndUpdate(domain._id, {
      serviceNodeId: node._id,
      serviceNodePubKey: publicKey,
    });

    res.status(201).json(node);
  } catch (err) {
    console.error("Register service node error:", err);
    res.status(500).json({ error: "Failed to register service node" });
  }
});

// GET /nodes/:domain -- look up service node by domain (e.g., example.ox)
router.get("/:domain", async (req, res) => {
  try {
    const parts = req.params.domain.split(".");
    if (parts.length !== 2) {
      res.status(400).json({ error: "Format must be name.tld (e.g., example.ox)" });
      return;
    }

    const [name, tld] = parts;

    const tldDoc = await TLD.findOne({
      name: tld.toLowerCase(),
      status: "active",
    });
    if (!tldDoc) {
      res.status(404).json({ error: "TLD not found" });
      return;
    }

    const domain = await Domain.findOne({
      name: name.toLowerCase(),
      tld: tld.toLowerCase(),
      status: "active",
    });
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    const node = await ServiceNode.findOne({ domainId: domain._id });
    if (!node) {
      res.status(404).json({ error: "No service node registered for this domain" });
      return;
    }

    res.json({
      publicKey: node.publicKey,
      connectedRelay: node.connectedRelay,
      status: node.status,
    });
  } catch (err) {
    console.error("Lookup service node error:", err);
    res.status(500).json({ error: "Failed to look up service node" });
  }
});

// POST /nodes/heartbeat -- update service node status (auth required)
router.post("/heartbeat", requireAuth, async (req: AuthRequest, res) => {
  try {
    const { domainId, connectedRelay } = req.body;

    if (!domainId || typeof domainId !== "string") {
      res.status(400).json({ error: "domainId is required" });
      return;
    }
    if (!connectedRelay || typeof connectedRelay !== "string") {
      res.status(400).json({ error: "connectedRelay is required" });
      return;
    }

    const node = await ServiceNode.findOne({ domainId });
    if (!node) {
      res.status(404).json({ error: "Service node not found" });
      return;
    }

    if (node.oxyUserId !== req.user!.id) {
      res.status(403).json({ error: "You do not own this service node" });
      return;
    }

    node.lastSeen = new Date();
    node.connectedRelay = connectedRelay;
    node.status = "online";
    await node.save();

    res.json({ status: "ok" });
  } catch (err) {
    console.error("Service node heartbeat error:", err);
    res.status(500).json({ error: "Failed to update heartbeat" });
  }
});

export default router;
