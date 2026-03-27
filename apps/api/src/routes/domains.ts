import { Router } from "express";
import Domain from "../models/Domain.js";
import TLD from "../models/TLD.js";
import User from "../models/User.js";
import { requireAuth } from "../middleware/auth.js";

const router = Router();

const DOMAIN_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

// GET /domains -- public directory of all registered domains
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page)) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit)) || 50));
    const skip = (page - 1) * limit;

    const [domains, total] = await Promise.all([
      Domain.find({ status: "active" })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select("-records"),
      Domain.countDocuments({ status: "active" }),
    ]);

    res.json({ domains, total, page, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error("List domains error:", err);
    res.status(500).json({ error: "Failed to list domains" });
  }
});

// GET /domains/search?q= -- search available domains
router.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").toLowerCase().trim();
    if (!q) {
      res.status(400).json({ error: "Search query is required" });
      return;
    }

    const domains = await Domain.find({
      name: { $regex: q, $options: "i" },
      status: "active",
    })
      .limit(50)
      .select("-records");

    res.json(domains);
  } catch (err) {
    console.error("Search domains error:", err);
    res.status(500).json({ error: "Failed to search domains" });
  }
});

// GET /domains/check/:name.:tld -- check if a specific domain is available
router.get("/check/:domain", async (req, res) => {
  try {
    const parts = req.params.domain.split(".");
    if (parts.length !== 2) {
      res.status(400).json({ error: "Format must be name.tld" });
      return;
    }

    const [name, tld] = parts;

    const existing = await Domain.findOne({
      name: name.toLowerCase(),
      tld: tld.toLowerCase(),
    });

    res.json({ domain: `${name}.${tld}`, available: !existing });
  } catch (err) {
    console.error("Check domain error:", err);
    res.status(500).json({ error: "Failed to check domain" });
  }
});

// POST /domains/register -- register a domain (auth required)
router.post("/register", requireAuth, async (req, res) => {
  try {
    const { name, tld } = req.body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!tld || typeof tld !== "string") {
      res.status(400).json({ error: "tld is required" });
      return;
    }

    const cleanName = name.toLowerCase().trim();
    const cleanTld = tld.toLowerCase().trim().replace(/^\./, "");

    if (!DOMAIN_NAME_RE.test(cleanName)) {
      res.status(400).json({
        error:
          "Domain name must be 1-63 characters, alphanumeric and hyphens only, cannot start or end with a hyphen",
      });
      return;
    }

    const tldDoc = await TLD.findOne({ name: cleanTld, status: "active" });
    if (!tldDoc) {
      res.status(400).json({ error: `TLD .${cleanTld} is not available` });
      return;
    }

    const existing = await Domain.findOne({ name: cleanName, tld: cleanTld });
    if (existing) {
      res.status(409).json({ error: `${cleanName}.${cleanTld} is already registered` });
      return;
    }

    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    const domain = await Domain.create({
      name: cleanName,
      tld: cleanTld,
      ownerId: req.auth!.userId,
      oxyUserId: req.auth!.oxyUserId,
      status: "active",
      records: [],
      expiresAt,
    });

    await User.findByIdAndUpdate(req.auth!.userId, {
      $push: { domains: domain._id },
    });

    res.status(201).json(domain);
  } catch (err) {
    console.error("Register domain error:", err);
    res.status(500).json({ error: "Failed to register domain" });
  }
});

// GET /domains/mine -- get current user's domains (auth required)
router.get("/mine", requireAuth, async (req, res) => {
  try {
    const domains = await Domain.find({ ownerId: req.auth!.userId }).sort({
      createdAt: -1,
    });
    res.json(domains);
  } catch (err) {
    console.error("My domains error:", err);
    res.status(500).json({ error: "Failed to get your domains" });
  }
});

// DELETE /domains/:id -- release a domain (auth required, must be owner)
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const domain = await Domain.findById(req.params.id);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    if (domain.ownerId.toString() !== req.auth!.userId) {
      res.status(403).json({ error: "You do not own this domain" });
      return;
    }

    await Domain.findByIdAndDelete(domain._id);
    await User.findByIdAndUpdate(req.auth!.userId, {
      $pull: { domains: domain._id },
    });

    res.json({ message: "Domain released" });
  } catch (err) {
    console.error("Delete domain error:", err);
    res.status(500).json({ error: "Failed to release domain" });
  }
});

// ── DNS Records ──

// GET /domains/:id/records
router.get("/:id/records", async (req, res) => {
  try {
    const domain = await Domain.findById(req.params.id);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }
    res.json(domain.records);
  } catch (err) {
    console.error("Get records error:", err);
    res.status(500).json({ error: "Failed to get records" });
  }
});

// POST /domains/:id/records -- add a DNS record (auth required, must be owner)
router.post("/:id/records", requireAuth, async (req, res) => {
  try {
    const domain = await Domain.findById(req.params.id);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }
    if (domain.ownerId.toString() !== req.auth!.userId) {
      res.status(403).json({ error: "You do not own this domain" });
      return;
    }

    const { type, name, value, ttl } = req.body;

    if (!type || !name || !value) {
      res.status(400).json({ error: "type, name, and value are required" });
      return;
    }

    domain.records.push({ type, name, value, ttl: ttl || 3600 });
    await domain.save();

    res.status(201).json(domain.records[domain.records.length - 1]);
  } catch (err) {
    console.error("Add record error:", err);
    res.status(500).json({ error: "Failed to add record" });
  }
});

// PUT /domains/:id/records/:rid -- update a DNS record
router.put("/:id/records/:rid", requireAuth, async (req, res) => {
  try {
    const domain = await Domain.findById(req.params.id);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }
    if (domain.ownerId.toString() !== req.auth!.userId) {
      res.status(403).json({ error: "You do not own this domain" });
      return;
    }

    const record = domain.records.id(req.params.rid);
    if (!record) {
      res.status(404).json({ error: "Record not found" });
      return;
    }

    const { type, name, value, ttl } = req.body;
    if (type) record.type = type;
    if (name) record.name = name;
    if (value) record.value = value;
    if (ttl !== undefined) record.ttl = ttl;

    await domain.save();
    res.json(record);
  } catch (err) {
    console.error("Update record error:", err);
    res.status(500).json({ error: "Failed to update record" });
  }
});

// DELETE /domains/:id/records/:rid -- delete a DNS record
router.delete("/:id/records/:rid", requireAuth, async (req, res) => {
  try {
    const domain = await Domain.findById(req.params.id);
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }
    if (domain.ownerId.toString() !== req.auth!.userId) {
      res.status(403).json({ error: "You do not own this domain" });
      return;
    }

    const record = domain.records.id(req.params.rid);
    if (!record) {
      res.status(404).json({ error: "Record not found" });
      return;
    }

    record.deleteOne();
    await domain.save();
    res.json({ message: "Record deleted" });
  } catch (err) {
    console.error("Delete record error:", err);
    res.status(500).json({ error: "Failed to delete record" });
  }
});

export default router;
