import { Router } from "express";
import Domain from "../models/Domain.js";
import TLD from "../models/TLD.js";

const router = Router();

interface DnsAnswer {
  name: string;
  type: string;
  value: string;
  ttl: number;
}

// GET /dns/resolve?name=example.ox&type=A
// Returns DNS records for a TNP domain. Used by the TNP resolver daemon.
router.get("/resolve", async (req, res) => {
  try {
    const fqdn = String(req.query.name || "").toLowerCase().trim().replace(/\.$/, "");
    const qtype = String(req.query.type || "A").toUpperCase();

    if (!fqdn) {
      res.status(400).json({ error: "name query parameter is required" });
      return;
    }

    // Split into parts -- support subdomains (e.g., www.example.ox)
    const parts = fqdn.split(".");
    if (parts.length < 2) {
      res.json({ name: fqdn, type: qtype, answers: [] });
      return;
    }

    const tld = parts[parts.length - 1];
    const domainName = parts[parts.length - 2];
    const subdomain = parts.length > 2 ? parts.slice(0, -2).join(".") : "@";

    // Verify this is a TNP TLD
    const tldDoc = await TLD.findOne({ name: tld, status: "active" });
    if (!tldDoc) {
      res.json({ name: fqdn, type: qtype, answers: [] });
      return;
    }

    const domain = await Domain.findOne({
      name: domainName,
      tld,
      status: "active",
    });

    if (!domain) {
      res.json({ name: fqdn, type: qtype, answers: [] });
      return;
    }

    // Filter records by type and subdomain
    const answers: DnsAnswer[] = domain.records
      .filter((r) => {
        const typeMatch = qtype === "ANY" || r.type === qtype;
        const nameMatch = r.name === subdomain || r.name === fqdn;
        return typeMatch && nameMatch;
      })
      .map((r) => ({
        name: fqdn,
        type: r.type,
        value: r.value,
        ttl: r.ttl,
      }));

    res.json({ name: fqdn, type: qtype, answers });
  } catch (err) {
    console.error("DNS resolve error:", err);
    res.status(500).json({ error: "Failed to resolve" });
  }
});

// GET /dns/tlds -- returns list of active TNP TLDs (for daemon TLD sync)
router.get("/tlds", async (_req, res) => {
  try {
    const tlds = await TLD.find({ status: "active" }).select("name");
    res.json(tlds.map((t) => t.name));
  } catch (err) {
    console.error("DNS TLDs error:", err);
    res.status(500).json({ error: "Failed to list TLDs" });
  }
});

export default router;
