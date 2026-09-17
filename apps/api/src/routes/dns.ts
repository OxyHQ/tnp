import { Router } from "express";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { getDb } from "../db/postgres.js";
import { tlds } from "../db/schema/index.js";
import { isReservedTld } from "@tnp/namespace";
import { decideResolution, loadNameFacts } from "../registry/resolve.js";

const router = Router();

/**
 * GET /dns/resolve — the hot path. Every TNP name lookup lands here.
 *
 * The facts come from `loadNameFacts` and the answer from `decideResolution`,
 * a pure function whose rules — CNAME at a name, NODATA against NXDOMAIN,
 * fresh-heartbeat nodes, parking synthesis — are specified in
 * docs/architecture/resolution.md. The response only ever grows: `rcode` is an
 * addition, and resolvers that predate it still read empty `answers` the way
 * they always have.
 */
router.get("/resolve", async (req, res) => {
  try {
    const fqdn = String(req.query.name || "").toLowerCase().trim().replace(/\.$/, "");
    const qtype = String(req.query.type || "A").toUpperCase();

    if (!fqdn) {
      res.status(400).json({ error: "name query parameter is required" });
      return;
    }

    const facts = await loadNameFacts(getDb(), fqdn);
    res.json(
      decideResolution(facts, qtype, {
        parkingIp: config.parkingIp,
        expiryEnforced: config.nativeExpiryEnforced,
        now: new Date(),
      }),
    );
  } catch (err) {
    console.error("DNS resolve error:", err);
    res.status(500).json({ error: "Failed to resolve" });
  }
});

/**
 * GET /dns/tlds — the TLD policy table clients cache for offline classification.
 *
 * Reserved TLDs are filtered out here as well as at write time: this endpoint is
 * what a resolver uses to decide which names are TNP's, so publishing `.com` on
 * it is precisely how public names came to be shadowed (audit S4). Clients
 * re-check the reserved set locally too — they do not have to trust the server
 * to have got its own policy right — but the server must not publish it either.
 */
router.get("/tlds", async (_req, res) => {
  try {
    const rows = await getDb()
      .select({ name: tlds.name, custom: tlds.custom })
      .from(tlds)
      .where(eq(tlds.status, "active"));

    res.json(rows.filter((t) => !isReservedTld(t.name)));
  } catch (err) {
    console.error("DNS TLDs error:", err);
    res.status(500).json({ error: "Failed to list TLDs" });
  }
});

export default router;
