/**
 * Promote the highest-scoring open TLD proposals to active TLDs.
 *
 * Operator tool, run by hand. The reserved check runs here too: approval is the
 * last gate before a label becomes servable, and a proposal created before the
 * namespace policy landed could still be sitting in the table.
 */

import { desc, eq, sql } from "drizzle-orm";
import { validateNativeTld } from "@tnp/namespace";
import { connectPostgres, closePostgres, getDb } from "../db/postgres.js";
import { tldProposals, tlds, votes } from "../db/schema/index.js";

const DEFAULT_LIMIT = 5;
const MIN_SCORE = 1;

async function main(): Promise<void> {
  const limit = parseInt(process.argv[2] ?? "", 10) || DEFAULT_LIMIT;

  await connectPostgres();
  const db = getDb();

  const score = sql<number>`(
    select coalesce(
      count(*) filter (where ${votes.direction} = 'up')
      - count(*) filter (where ${votes.direction} = 'down'), 0)
    from ${votes}
    where ${votes.proposalId} = ${tldProposals.id}
  )::int`;

  const candidates = await db
    .select({ id: tldProposals.id, tld: tldProposals.tld, score })
    .from(tldProposals)
    .where(eq(tldProposals.status, "open"))
    .orderBy(desc(score))
    .limit(limit);

  let approved = 0;

  for (const candidate of candidates) {
    if (candidate.score < MIN_SCORE) {
      console.log(`  skip .${candidate.tld} — score ${candidate.score}`);
      continue;
    }

    const policy = validateNativeTld(candidate.tld);
    if (!policy.ok) {
      console.log(`  REFUSED .${candidate.tld} — ${policy.detail}`);
      await db
        .update(tldProposals)
        .set({ status: "rejected", updatedAt: sql`now()` })
        .where(eq(tldProposals.id, candidate.id));
      continue;
    }

    await db
      .update(tlds)
      .set({ status: "active", updatedAt: sql`now()` })
      .where(eq(tlds.name, candidate.tld));
    await db
      .update(tldProposals)
      .set({ status: "approved", updatedAt: sql`now()` })
      .where(eq(tldProposals.id, candidate.id));

    console.log(`  approved .${candidate.tld} (score ${candidate.score})`);
    approved++;
  }

  console.log(`Approved ${approved} of ${candidates.length} candidate(s)`);
  await closePostgres();
}

await main();
