/**
 * The public TLD proposals list.
 */

import { desc, eq, sql } from "drizzle-orm";
import type { TldProposalEntry } from "@tnp/shared-types";
import { tldProposals, users } from "../db/schema/index.js";
import type { Executor } from "./db.js";

/**
 * Proposals with scores, highest score then newest first.
 *
 * `callerOxyUserId` is whoever is asking, or null when nobody is signed in. It
 * decides `userVote` and `proposedByMe` and appears in no response. The list
 * used to embed `proposedBy: { _id, oxyUserId }` so the web could hide the vote
 * buttons on the caller's own proposals — publishing every proposer's Oxy id to
 * anyone, to answer a question about the caller. The server answers it instead.
 */
export async function listTldProposals(
  db: Executor,
  callerOxyUserId: string | null,
): Promise<TldProposalEntry[]> {
  let userId: string | null = null;
  if (callerOxyUserId) {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.oxyUserId, callerOxyUserId))
      .limit(1);
    userId = row?.id ?? null;
  }

  // Correlated subqueries are written as literal SQL with the outer table
  // named explicitly, NOT with drizzle column objects. In a single-table
  // select drizzle renders a column object in the select list unqualified
  // (`"proposal_id" = "id"`), and inside the subquery an unqualified `id`
  // resolves to the SUBQUERY's own table — so the predicate compared a vote
  // with itself, matched nothing, and every score read 0 and every userVote
  // null, with no error. The same expression in ORDER BY happened to render
  // qualified, which is why the list still looked sorted. Caught by
  // test-db/registry.test.ts; verified against the generated SQL.
  const score = sql<number>`(
    select coalesce(
      count(*) filter (where v.direction = 'up')
      - count(*) filter (where v.direction = 'down'), 0)
    from votes v
    where v.proposal_id = tld_proposals.id
  )::int`;

  const userVote = userId
    ? sql<string | null>`(
        select v.direction::text from votes v
        where v.proposal_id = tld_proposals.id
          and v.user_id = ${userId}
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
      proposedById: tldProposals.proposedById,
    })
    .from(tldProposals)
    .orderBy(desc(score), desc(tldProposals.createdAt));

  return rows.map(({ proposedById, createdAt, userVote: vote, ...row }) => ({
    ...row,
    createdAt: createdAt.toISOString(),
    userVote: vote === "up" || vote === "down" ? vote : null,
    proposedByMe: userId !== null && proposedById === userId,
  }));
}
