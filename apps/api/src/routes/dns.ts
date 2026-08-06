import { Router } from "express";
import { and, eq, inArray, or } from "drizzle-orm";
import { config } from "../config.js";
import { getDb } from "../db/postgres.js";
import { dnsRecords, domains, serviceNodes, tlds } from "../db/schema/index.js";
import { isReservedTld } from "@tnp/namespace";

const router = Router();

interface DnsAnswer {
  name: string;
  type: string;
  value: string;
  ttl: number;
}

/** Record types the registry can store, so an unknown `type=` is not a lookup. */
const RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS"] as const;
type RecordType = (typeof RECORD_TYPES)[number];

function isRecordType(value: string): value is RecordType {
  return (RECORD_TYPES as readonly string[]).includes(value);
}

/**
 * GET /dns/resolve — the hot path. Every TNP name lookup lands here.
 *
 * Under Mongoose this loaded the whole domain document and filtered its
 * records subdocument array in application code. Records are their own table
 * now, so the filter is an index lookup on (domain_id, name, type).
 */
router.get("/resolve", async (req, res) => {
  try {
    const fqdn = String(req.query.name || "").toLowerCase().trim().replace(/\.$/, "");
    const qtype = String(req.query.type || "A").toUpperCase();

    if (!fqdn) {
      res.status(400).json({ error: "name query parameter is required" });
      return;
    }

    const parts = fqdn.split(".");
    if (parts.length < 2) {
      res.json({ name: fqdn, type: qtype, answers: [] });
      return;
    }

    const tld = parts[parts.length - 1];
    const domainName = parts[parts.length - 2];
    const subdomain = parts.length > 2 ? parts.slice(0, -2).join(".") : "@";

    // TNP never answers for a label the public DNS root delegates, whatever the
    // TLD table happens to contain (docs/architecture/naming.md, rule N1).
    // Checked before the lookup so a reserved row left by an earlier seed cannot
    // produce an answer that shadows the real name.
    if (isReservedTld(tld)) {
      res.json({ name: fqdn, type: qtype, answers: [] });
      return;
    }

    const db = getDb();

    const [tldRow] = await db
      .select({ custom: tlds.custom })
      .from(tlds)
      .where(and(eq(tlds.name, tld), eq(tlds.status, "active")))
      .limit(1);

    if (!tldRow) {
      res.json({ name: fqdn, type: qtype, answers: [] });
      return;
    }

    const [domain] = await db
      .select({ id: domains.id })
      .from(domains)
      .where(and(eq(domains.name, domainName), eq(domains.tld, tld), eq(domains.status, "active")))
      .limit(1);

    if (!domain) {
      // Unregistered name under a native TLD: hand out the parking address so a
      // browser lands on the "available" page.
      const answers: DnsAnswer[] = [];
      if (tldRow.custom && config.parkingIp && (qtype === "A" || qtype === "ANY")) {
        answers.push({ name: fqdn, type: "A", value: config.parkingIp, ttl: 300 });
      }
      res.json({ name: fqdn, type: qtype, answers });
      return;
    }

    // `name` matches either the bare label or the full FQDN, preserving the
    // Mongoose behaviour where records could be stored either way.
    const nameMatches = or(eq(dnsRecords.name, subdomain), eq(dnsRecords.name, fqdn));
    const typeFilter =
      qtype === "ANY"
        ? inArray(dnsRecords.type, [...RECORD_TYPES])
        : isRecordType(qtype)
          ? eq(dnsRecords.type, qtype)
          : // An unknown type cannot match a stored record, so do not query for it.
            null;

    const rows = typeFilter
      ? await db
          .select({ type: dnsRecords.type, value: dnsRecords.value, ttl: dnsRecords.ttl })
          .from(dnsRecords)
          .where(and(eq(dnsRecords.domainId, domain.id), nameMatches, typeFilter))
      : [];

    const answers: DnsAnswer[] = rows.map((row) => ({
      name: fqdn,
      type: row.type,
      value: row.value,
      ttl: row.ttl,
    }));

    const [node] = await db
      .select({
        publicKey: serviceNodes.publicKey,
        connectedRelay: serviceNodes.connectedRelay,
        status: serviceNodes.status,
      })
      .from(serviceNodes)
      .where(eq(serviceNodes.domainId, domain.id))
      .limit(1);

    // Parking fallback only when the name has neither records nor a live node.
    if (answers.length === 0 && !node && config.parkingIp) {
      if (qtype === "A" || qtype === "ANY") {
        answers.push({ name: fqdn, type: "A", value: config.parkingIp, ttl: 300 });
      }
    }

    const response: Record<string, unknown> = { name: fqdn, type: qtype, answers };

    if (node && node.status === "online") {
      response.overlay = {
        serviceNodePubKey: node.publicKey,
        relay: node.connectedRelay,
        available: true,
      };
    }

    res.json(response);
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
