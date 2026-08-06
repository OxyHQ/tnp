import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { requireOxyAuth, getRequiredOxyUserId } from "@oxyhq/core/server";
import { isReservedTld } from "@tnp/namespace";
import {
  parseRegisterServiceNodeRequest,
  parseServiceNodeHeartbeatRequest,
  type ServiceNodeHeartbeatResponse,
  type ServiceNodeLookup,
  type ServiceNodeRegistration,
} from "@tnp/shared-types";
import { getDb } from "../db/postgres.js";
import { domains, serviceNodes, tlds } from "../db/schema/index.js";

const router = Router();

// POST /nodes/register -- register a service node for a domain (auth required)
router.post("/register", requireOxyAuth, async (req, res) => {
  try {
    const userId = getRequiredOxyUserId(req);

    const parsed = parseRegisterServiceNodeRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { domainId, publicKey } = parsed.value;

    const db = getDb();

    const [domain] = await db
      .select({ id: domains.id, oxyUserId: domains.oxyUserId })
      .from(domains)
      .where(eq(domains.id, domainId))
      .limit(1);

    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }
    if (domain.oxyUserId !== userId) {
      res.status(403).json({ error: "You do not own this domain" });
      return;
    }

    // One node per domain, enforced by a unique index rather than by convention.
    const [node] = await db
      .insert(serviceNodes)
      .values({ domainId: domain.id, oxyUserId: userId, publicKey })
      .onConflictDoUpdate({
        target: serviceNodes.domainId,
        set: { publicKey, oxyUserId: userId, lastSeen: sql`now()`, updatedAt: sql`now()` },
      })
      .returning();

    if (!node) {
      res.status(500).json({ error: "Failed to register service node" });
      return;
    }

    // Projected, not returned whole: the row also carries `oxyUserId`, which is
    // not part of the contract.
    const registration: ServiceNodeRegistration = {
      domainId: node.domainId,
      publicKey: node.publicKey,
      connectedRelay: node.connectedRelay,
      status: node.status,
    };
    res.status(201).json(registration);
  } catch (err) {
    console.error("Register service node error:", err);
    res.status(500).json({ error: "Failed to register service node" });
  }
});

// GET /nodes/:domain -- look up a service node by domain (e.g. example.ox)
router.get("/:domain", async (req, res) => {
  try {
    const parts = req.params.domain.split(".");
    if (parts.length !== 2) {
      res.status(400).json({ error: "Format must be name.tld (e.g., example.ox)" });
      return;
    }

    const [name, tld] = parts.map((p) => p.toLowerCase());

    // TNP serves no reserved TLD, so it publishes no service node under one
    // either — otherwise this endpoint would be a way around the namespace rule.
    if (isReservedTld(tld)) {
      res.status(404).json({ error: "TLD not found" });
      return;
    }

    const db = getDb();

    const [tldRow] = await db
      .select({ id: tlds.id })
      .from(tlds)
      .where(and(eq(tlds.name, tld), eq(tlds.status, "active")))
      .limit(1);

    if (!tldRow) {
      res.status(404).json({ error: "TLD not found" });
      return;
    }

    const [node] = await db
      .select({
        publicKey: serviceNodes.publicKey,
        connectedRelay: serviceNodes.connectedRelay,
        status: serviceNodes.status,
        lastSeen: serviceNodes.lastSeen,
      })
      .from(serviceNodes)
      .innerJoin(domains, eq(serviceNodes.domainId, domains.id))
      .where(and(eq(domains.name, name), eq(domains.tld, tld), eq(domains.status, "active")))
      .limit(1);

    if (!node) {
      res.status(404).json({ error: "No service node registered for this domain" });
      return;
    }

    // `lastSeen` is serialized here rather than left to `JSON.stringify`: the
    // contract says ISO 8601 string, and a `Date` that only becomes one by way
    // of the serializer is a shape no consumer's type can be checked against.
    // The web dashboard has been rendering a "last seen" line conditionally
    // since it was written, on a field this endpoint never sent.
    const lookup: ServiceNodeLookup = {
      publicKey: node.publicKey,
      connectedRelay: node.connectedRelay,
      status: node.status,
      lastSeen: node.lastSeen.toISOString(),
    };
    res.json(lookup);
  } catch (err) {
    console.error("Lookup service node error:", err);
    res.status(500).json({ error: "Failed to look up service node" });
  }
});

// POST /nodes/heartbeat -- update service node status (auth required)
router.post("/heartbeat", requireOxyAuth, async (req, res) => {
  try {
    const parsed = parseServiceNodeHeartbeatRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { domainId, connectedRelay } = parsed.value;

    // The ownership predicate is in the UPDATE, so a node belonging to another
    // account cannot be touched even by guessing its domain id.
    const updated = await getDb()
      .update(serviceNodes)
      .set({
        lastSeen: sql`now()`,
        connectedRelay,
        status: "online",
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(serviceNodes.domainId, domainId),
          eq(serviceNodes.oxyUserId, getRequiredOxyUserId(req)),
        ),
      )
      .returning({ id: serviceNodes.id });

    if (updated.length === 0) {
      // Deliberately does not distinguish "no such node" from "not yours":
      // telling an unauthorized caller which domains have nodes is a disclosure
      // the previous 404/403 split made for free.
      res.status(404).json({ error: "Service node not found" });
      return;
    }

    const response: ServiceNodeHeartbeatResponse = { status: "ok" };
    res.json(response);
  } catch (err) {
    console.error("Service node heartbeat error:", err);
    res.status(500).json({ error: "Failed to update heartbeat" });
  }
});

export default router;
