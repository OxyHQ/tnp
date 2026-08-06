import { Router } from "express";
import type { Request } from "express";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { requireOxyAuth, getOxyUserId, getRequiredOxyUserId } from "@oxyhq/core/server";
import { isReservedTld, validateNativeTld } from "@tnp/namespace";
import { getDb } from "../db/postgres.js";
import { tldProposals, tlds, users, votes } from "../db/schema/index.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findOrCreateUser(oxyUserId: string): Promise<string> {
  const [row] = await getDb()
    .insert(users)
    .values({ oxyUserId })
    .onConflictDoUpdate({ target: users.oxyUserId, set: { updatedAt: sql`now()` } })
    .returning({ id: users.id });
  return row.id;
}

// GET /tlds -- list all active TNP-native TLDs
//
// Reserved TLDs are filtered at read time, not only at write time: a database
// populated before the namespace policy landed still holds `.com` and `.app`
// rows, and publishing those is what made clients shadow public names.
router.get("/", async (_req, res) => {
  try {
    const rows = await getDb()
      .select()
      .from(tlds)
      .where(eq(tlds.status, "active"))
      .orderBy(asc(tlds.name));

    res.json(rows.filter((t) => !isReservedTld(t.name)));
  } catch (err) {
    console.error("List TLDs error:", err);
    res.status(500).json({ error: "Failed to list TLDs" });
  }
});

// POST /tlds/propose -- propose a new TLD (auth required)
router.post("/propose", requireOxyAuth, async (req, res) => {
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

    // Rule N3: a native TLD passes the reserved check at proposal time as well
    // as at approval time. Proposing `.com` fails here rather than surviving to
    // a vote and depending on whoever approves it to catch it.
    const policy = validateNativeTld(name);
    if (!policy.ok) {
      res.status(policy.reason === "reserved" ? 403 : 400).json({
        error: policy.reason === "reserved" ? "TLD_RESERVED" : "TLD_INVALID",
        detail: policy.detail,
      });
      return;
    }

    const db = getDb();
    const proposedById = await findOrCreateUser(getRequiredOxyUserId(req));

    // The unique index decides, so two concurrent proposals of the same label
    // cannot both succeed.
    const claimed = await db
      .insert(tlds)
      .values({ name, status: "proposed", proposedById })
      .onConflictDoNothing({ target: tlds.name })
      .returning({ id: tlds.id });

    if (claimed.length === 0) {
      res.status(409).json({ error: `TLD .${name} already exists` });
      return;
    }

    const [proposal] = await db
      .insert(tldProposals)
      .values({ tld: name, proposedById, reason })
      .returning();

    res.status(201).json(proposal);
  } catch (err) {
    console.error("Propose TLD error:", err);
    res.status(500).json({ error: "Failed to propose TLD" });
  }
});

// GET /tlds/proposals -- proposals with scores, newest-highest first
router.get("/proposals", async (req, res) => {
  try {
    const db = getDb();

    const callerId = getOxyUserId(req);
    let userId: string | null = null;
    if (callerId) {
      const [row] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.oxyUserId, callerId))
        .limit(1);
      userId = row?.id ?? null;
    }

    // Correlated subqueries are fully qualified. An unqualified column inside a
    // correlated subquery resolves against the SUBQUERY's own table, so the
    // predicate silently compares two of its columns and matches nothing — with
    // no error at all. That shipped in a sibling Oxy port and read as zero
    // counts everywhere.
    const score = sql<number>`(
      select coalesce(
        count(*) filter (where ${votes.direction} = 'up')
        - count(*) filter (where ${votes.direction} = 'down'), 0)
      from ${votes}
      where ${votes.proposalId} = ${tldProposals.id}
    )::int`;

    const userVote = userId
      ? sql<string | null>`(
          select ${votes.direction} from ${votes}
          where ${votes.proposalId} = ${tldProposals.id}
            and ${votes.userId} = ${userId}
          limit 1
        )`
      : sql<string | null>`null::text`;

    const rows = await db
      .select({
        _id: tldProposals.id,
        tld: tldProposals.tld,
        reason: tldProposals.reason,
        status: tldProposals.status,
        createdAt: tldProposals.createdAt,
        score,
        userVote,
        proposedBy: {
          _id: users.id,
          oxyUserId: users.oxyUserId,
        },
      })
      .from(tldProposals)
      .leftJoin(users, eq(tldProposals.proposedById, users.id))
      .orderBy(desc(score), desc(tldProposals.createdAt));

    res.json(rows);
  } catch (err) {
    console.error("List proposals error:", err);
    res.status(500).json({ error: "Failed to list proposals" });
  }
});

async function proposalScore(proposalId: string): Promise<number> {
  const [row] = await getDb()
    .select({
      score: sql<number>`(
        count(*) filter (where ${votes.direction} = 'up')
        - count(*) filter (where ${votes.direction} = 'down')
      )::int`,
    })
    .from(votes)
    .where(eq(votes.proposalId, proposalId));
  return row?.score ?? 0;
}

// POST /tlds/proposals/:id/vote (auth required)
router.post(
  "/proposals/:id/vote",
  requireOxyAuth,
  async (req: Request<{ id: string }>, res) => {
  try {
    const { direction } = req.body;
    if (direction !== "up" && direction !== "down") {
      res.status(400).json({ error: "direction must be 'up' or 'down'" });
      return;
    }
    if (!UUID_RE.test(req.params.id)) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }

    const db = getDb();

    const [proposal] = await db
      .select({ id: tldProposals.id, status: tldProposals.status, proposedById: tldProposals.proposedById })
      .from(tldProposals)
      .where(eq(tldProposals.id, req.params.id))
      .limit(1);

    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }
    if (proposal.status !== "open") {
      res.status(400).json({ error: "Can only vote on open proposals" });
      return;
    }

    const userId = await findOrCreateUser(getRequiredOxyUserId(req));

    if (proposal.proposedById === userId) {
      res.status(403).json({ error: "Cannot vote on your own proposal" });
      return;
    }

    // One vote per user per proposal is a unique index, so a re-vote updates
    // rather than inserting a second row. The old upsert let two concurrent
    // votes both pass the check and both insert.
    await db
      .insert(votes)
      .values({ proposalId: proposal.id, userId, direction })
      .onConflictDoUpdate({
        target: [votes.proposalId, votes.userId],
        set: { direction },
      });

      res.json({ score: await proposalScore(proposal.id), userVote: direction });
    } catch (err) {
      console.error("Vote error:", err);
      res.status(500).json({ error: "Failed to vote" });
    }
  },
);

// DELETE /tlds/proposals/:id/vote (auth required)
router.delete(
  "/proposals/:id/vote",
  requireOxyAuth,
  async (req: Request<{ id: string }>, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }

    const db = getDb();

    const [proposal] = await db
      .select({ id: tldProposals.id })
      .from(tldProposals)
      .where(eq(tldProposals.id, req.params.id))
      .limit(1);

    if (!proposal) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }

    const userId = await findOrCreateUser(getRequiredOxyUserId(req));

    await db
      .delete(votes)
      .where(and(eq(votes.proposalId, proposal.id), eq(votes.userId, userId)));

      res.json({ score: await proposalScore(proposal.id), userVote: null });
    } catch (err) {
      console.error("Remove vote error:", err);
      res.status(500).json({ error: "Failed to remove vote" });
    }
  },
);

export default router;
