/**
 * The services worker: runs the operations outbox.
 *
 * A separate process from the API — same image, different command
 * (`bun apps/api/src/workers/commerce.ts`) — with its own connection pool and
 * concurrency, so a backlog of provider calls can never exhaust the pool the
 * resolver-facing API answers from. Infrastructure for it (the ECS service,
 * its egress address) belongs to `oxy-infra`.
 *
 * Shutdown stops claiming, waits for in-flight operations up to a deadline,
 * then exits. An operation still running at the deadline keeps its lease until
 * it expires and is then reconciled by the next worker, never re-executed.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import postgres from "postgres";
import { hostname } from "node:os";
import { config as apiConfig } from "../config.js";
import { DATABASE_CASING } from "../db/casing.js";
import { runMigrations } from "../db/migrate.js";
import type { Database } from "../db/postgres.js";
import * as schema from "../db/schema/index.js";
import { providerAccounts, publicDomains } from "../db/schema/index.js";
import { anyServiceEnabled, readServicesConfig } from "../services/config.js";
import { OperationEngine } from "../services/operations/engine.js";
import { createOperationHandlers, OPERATION_KINDS } from "../services/operations/handlers.js";
import { enqueueOperation } from "../services/operations/store.js";
import { createProductionRegistry } from "../services/providers/production.js";
import { pruneRateWindows } from "../services/providers/rateLimit.js";

const IDLE_POLL_MS = 2_000;
const SHUTDOWN_DEADLINE_MS = 30_000;
const MAINTENANCE_INTERVAL_MS = 15 * 60_000;
const SYNC_AFTER_MS = 24 * 60 * 60_000;

function log(event: Record<string, unknown>): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), service: "tnp-services-worker", ...event }));
}

/**
 * Queue a daily sync for every domain not synced within a day. The idempotency
 * key is per domain per UTC day, so replicas scheduling at once enqueue once.
 */
export async function scheduleSyncs(db: Database, now: Date): Promise<number> {
  const stale = await db
    .select({ id: publicDomains.id, ownerId: publicDomains.ownerId, accountId: publicDomains.providerAccountId, environment: providerAccounts.environment })
    .from(publicDomains)
    .innerJoin(providerAccounts, eq(providerAccounts.id, publicDomains.providerAccountId))
    .where(
      and(
        sql`${publicDomains.lifecycle} not in ('pending', 'failed')`,
        sql`${providerAccounts.managementMode} <> 'disabled'`,
        or(isNull(publicDomains.lastSyncedAt), lt(publicDomains.lastSyncedAt, new Date(now.getTime() - SYNC_AFTER_MS))),
      ),
    )
    .limit(500);
  const day = now.toISOString().slice(0, 10);
  let created = 0;
  for (const domain of stale) {
    const result = await enqueueOperation(db, {
      kind: OPERATION_KINDS.sync,
      scope: "system",
      idempotencyKey: `daily-sync:${domain.id}:${day}`,
      ownerId: domain.ownerId,
      resourceType: "public_domain",
      resourceId: domain.id,
      providerAccountId: domain.accountId,
      payload: { publicDomainId: domain.id, environment: domain.environment },
    });
    if (result.created) created++;
  }
  return created;
}

async function main(): Promise<void> {
  const services = readServicesConfig();
  if (!anyServiceEnabled(services)) {
    log({ event: "worker.disabled", reason: "no TNP_SERVICES_* flag is set" });
    return;
  }
  if (!apiConfig.databaseUrl) throw new Error("DATABASE_URL is required");

  await runMigrations();
  const client = postgres(apiConfig.databaseUrl, { max: services.workerPoolSize, idle_timeout: 30, connect_timeout: 10 });
  const db: Database = drizzle(client, { schema, casing: DATABASE_CASING });
  await client`select 1`;

  const workerId = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  const engine = new OperationEngine({
    db,
    workerId,
    handlers: createOperationHandlers(createProductionRegistry(db)),
    log,
  });

  let stopping = false;
  let deadline: Promise<void> = new Promise(() => {});
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log({ event: "worker.stopping" });
    deadline = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DEADLINE_MS).unref());
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);

  const maintenance = async () => {
    try {
      await pruneRateWindows(db);
      const queued = await scheduleSyncs(db, new Date());
      log({ event: "worker.maintenance", syncsQueued: queued });
    } catch (err) {
      log({ event: "worker.maintenance_failed", error: String(err) });
    }
  };
  await maintenance();
  const timer = setInterval(() => void maintenance(), MAINTENANCE_INTERVAL_MS);

  const loop = async (slot: number) => {
    while (!stopping) {
      try {
        const worked = await engine.runOnce();
        if (!worked) await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
      } catch (err) {
        log({ event: "worker.loop_error", slot, error: String(err) });
        await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS));
      }
    }
  };

  log({ event: "worker.started", workerId, concurrency: services.workerConcurrency, kinds: engine.kinds });
  const loops = Array.from({ length: services.workerConcurrency }, (_, slot) => loop(slot));
  // Loops finish their current operation and return once `stopping` is set;
  // the deadline only matters if a provider call hangs past it. `deadline` is
  // read after the loops start waiting, so the race sees the one `stop` made.
  const allLoops = Promise.all(loops);
  while (!stopping) await Promise.race([allLoops, new Promise((r) => setTimeout(r, 1_000))]);
  await Promise.race([allLoops, deadline]);
  clearInterval(timer);
  await client.end({ timeout: 5 });
  log({ event: "worker.stopped" });
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("services worker failed:", err);
    process.exit(1);
  });
}
