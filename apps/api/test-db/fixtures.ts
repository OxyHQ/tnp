/**
 * Fixtures and lock probes for the real-PostgreSQL tests.
 *
 * Instants are written relative to the real clock, never as absolute dates, so
 * a fixture does not change meaning as the calendar moves.
 */

import { sql } from "drizzle-orm";
import type postgres from "postgres";
import { domains, tlds, users } from "../src/db/schema/index.js";
import type { TestDb } from "./harness.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

export function daysFrom(now: Date, days: number): Date {
  return new Date(now.getTime() + days * DAY_MS);
}

export async function seedTld(db: TestDb, name = "ox"): Promise<void> {
  await db.insert(tlds).values({ name, status: "active" }).onConflictDoNothing({ target: tlds.name });
}

export async function seedDomain(
  db: TestDb,
  values: { name: string; tld?: string; oxyUserId?: string; expiresAt?: Date | null },
) {
  const oxyUserId = values.oxyUserId ?? "owner-under-test";
  const [owner] = await db
    .insert(users)
    .values({ oxyUserId })
    .onConflictDoUpdate({ target: users.oxyUserId, set: { updatedAt: sql`now()` } })
    .returning();
  const [domain] = await db
    .insert(domains)
    .values({
      name: values.name,
      tld: values.tld ?? "ox",
      ownerId: owner.id,
      oxyUserId,
      expiresAt: values.expiresAt === undefined ? null : values.expiresAt,
    })
    .returning();
  return domain;
}

/** The server pid of the connection a transaction runs on. */
export async function backendPid(
  tx: { execute: (query: ReturnType<typeof sql>) => PromiseLike<unknown> },
): Promise<number> {
  const rows = (await tx.execute(sql`select pg_backend_pid() as pid`)) as unknown as { pid: number }[];
  const pid = rows[0]?.pid;
  if (typeof pid !== "number") throw new Error("could not read pg_backend_pid()");
  return pid;
}

/**
 * Wait until some other session is blocked on a lock `holderPid` holds, and
 * throw if that never happens.
 *
 * This is the precondition of every interleaving test: if the contender never
 * blocked, it finished before the holder did anything, and a green result says
 * nothing about concurrency. Scoped to the holder through
 * `pg_blocking_pids`, not to a lock relation (a row-lock wait queues on the
 * holder's transaction id) and not to "some pid other than mine" (the pool may
 * reuse connections).
 */
export async function waitUntilBlockedBy(
  probe: postgres.Sql,
  holderPid: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await probe<{ waiting: number }[]>`
      select count(*)::int as waiting from pg_locks
      where not granted and ${holderPid}::int = any(pg_blocking_pids(pid))
    `;
    if (row.waiting > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `no session blocked on pid ${holderPid} within ${timeoutMs}ms — the contender did not wait for the lock`,
  );
}
