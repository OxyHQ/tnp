import { Router } from "express";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { requireOxyAuth, getRequiredOxyUserId } from "@oxyhq/core/server";
import { getDb } from "../db/postgres.js";
import { relays } from "../db/schema/index.js";

const router = Router();

// GET /relays -- list active relays (public)
router.get("/", async (req, res) => {
  try {
    const operatorFilter = req.query.operator;
    const operator =
      operatorFilter === "oxy" || operatorFilter === "community" ? operatorFilter : null;

    const rows = await getDb()
      .select({
        endpoint: relays.endpoint,
        publicKey: relays.publicKey,
        operator: relays.operator,
        location: relays.location,
        status: relays.status,
      })
      .from(relays)
      .where(
        operator
          ? and(ne(relays.status, "offline"), eq(relays.operator, operator))
          : ne(relays.status, "offline"),
      )
      .orderBy(asc(relays.status), asc(relays.endpoint));

    res.json(rows);
  } catch (err) {
    console.error("List relays error:", err);
    res.status(500).json({ error: "Failed to list relays" });
  }
});

// POST /relays/register -- register a relay node (auth required)
router.post("/register", requireOxyAuth, async (req, res) => {
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

    const operatorUserId = getRequiredOxyUserId(req);

    // Re-registering an endpoint is only allowed by its existing operator: the
    // upsert's WHERE is what stops one account from taking over another's relay
    // by re-registering the same endpoint.
    const [relay] = await getDb()
      .insert(relays)
      .values({
        endpoint,
        publicKey,
        operator,
        operatorUserId,
        maxConnections: capacity.maxConnections,
        bandwidth: capacity.bandwidth,
        location: typeof location === "string" ? location : "",
        lastSeen: new Date(),
      })
      .onConflictDoUpdate({
        target: relays.endpoint,
        set: {
          publicKey,
          operator,
          maxConnections: capacity.maxConnections,
          bandwidth: capacity.bandwidth,
          location: typeof location === "string" ? location : "",
          lastSeen: sql`now()`,
          updatedAt: sql`now()`,
        },
        setWhere: eq(relays.operatorUserId, operatorUserId),
      })
      .returning();

    if (!relay) {
      res.status(403).json({ error: "This endpoint is registered to another operator" });
      return;
    }

    res.status(201).json(relay);
  } catch (err) {
    console.error("Register relay error:", err);
    res.status(500).json({ error: "Failed to register relay" });
  }
});

// POST /relays/heartbeat -- update relay status (auth required)
router.post("/heartbeat", requireOxyAuth, async (req, res) => {
  try {
    const { endpoint } = req.body;

    if (!endpoint || typeof endpoint !== "string") {
      res.status(400).json({ error: "endpoint is required" });
      return;
    }

    const updated = await getDb()
      .update(relays)
      .set({ lastSeen: sql`now()`, status: "active", updatedAt: sql`now()` })
      .where(
        and(
          eq(relays.endpoint, endpoint),
          eq(relays.operatorUserId, getRequiredOxyUserId(req)),
        ),
      )
      .returning({ id: relays.id });

    if (updated.length === 0) {
      res.status(404).json({ error: "Relay not found" });
      return;
    }

    res.json({ status: "ok" });
  } catch (err) {
    console.error("Relay heartbeat error:", err);
    res.status(500).json({ error: "Failed to update heartbeat" });
  }
});

export default router;
