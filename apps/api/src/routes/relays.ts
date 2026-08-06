import { Router } from "express";
import { and, asc, eq, ne, sql } from "drizzle-orm";
import { requireOxyAuth, getRequiredOxyUserId } from "@oxyhq/core/server";
import {
  parseRegisterRelayRequest,
  parseRelayHeartbeatRequest,
  type RelayDirectoryEntry,
  type RelayHeartbeatResponse,
  type RelayRegistration,
} from "@tnp/shared-types";
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

    // Annotated rather than merely returned: the directory listing is a
    // contract the CLI and the web dashboard both read, so a column added to
    // or dropped from the projection above has to be a decision about the
    // contract instead of a silent change to one consumer's assumptions.
    const directory: RelayDirectoryEntry[] = rows;
    res.json(directory);
  } catch (err) {
    console.error("List relays error:", err);
    res.status(500).json({ error: "Failed to list relays" });
  }
});

// POST /relays/register -- register a relay node (auth required)
router.post("/register", requireOxyAuth, async (req, res) => {
  try {
    // The one definition of what this endpoint accepts lives in
    // @tnp/shared-types, and the relay builds its request from that same
    // declaration. Hand-written field checks here are exactly what let this
    // route and the client disagree for the whole life of the feature — see
    // audit finding B2.
    const parsed = parseRegisterRelayRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const { endpoint, publicKey, operator, capacity, location } = parsed.value;
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
        location,
        lastSeen: new Date(),
      })
      .onConflictDoUpdate({
        target: relays.endpoint,
        set: {
          publicKey,
          operator,
          maxConnections: capacity.maxConnections,
          bandwidth: capacity.bandwidth,
          location,
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

    // Projected, not returned whole: the row also carries `operatorUserId` and
    // internal ids, which are not part of the contract.
    const registration: RelayRegistration = {
      endpoint: relay.endpoint,
      publicKey: relay.publicKey,
      operator: relay.operator,
      capacity: { maxConnections: relay.maxConnections, bandwidth: relay.bandwidth },
      location: relay.location,
      status: relay.status,
    };
    res.status(201).json(registration);
  } catch (err) {
    console.error("Register relay error:", err);
    res.status(500).json({ error: "Failed to register relay" });
  }
});

// POST /relays/heartbeat -- update relay status (auth required)
router.post("/heartbeat", requireOxyAuth, async (req, res) => {
  try {
    const parsed = parseRelayHeartbeatRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }

    const updated = await getDb()
      .update(relays)
      .set({ lastSeen: sql`now()`, status: "active", updatedAt: sql`now()` })
      .where(
        and(
          eq(relays.endpoint, parsed.value.endpoint),
          eq(relays.operatorUserId, getRequiredOxyUserId(req)),
        ),
      )
      .returning({ id: relays.id });

    if (updated.length === 0) {
      res.status(404).json({ error: "Relay not found" });
      return;
    }

    const response: RelayHeartbeatResponse = { status: "ok" };
    res.json(response);
  } catch (err) {
    console.error("Relay heartbeat error:", err);
    res.status(500).json({ error: "Failed to update heartbeat" });
  }
});

export default router;
