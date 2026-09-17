/**
 * Liveness and readiness.
 *
 * `/health` answers from the process alone: it says the event loop is running
 * and nothing more, so a slow database never gets a healthy process killed.
 * `/health/ready` adds the one dependency the API cannot serve without — its
 * PostgreSQL — and nothing else. No provider, relay or other external service
 * is consulted by either, so an outage somewhere commercial can never take the
 * network API out of rotation (services.md §12).
 */

import { Router } from "express";
import { pingPostgres } from "./db/postgres.js";

export const READINESS_TIMEOUT_MS = 2000;

export function createHealthRouter(ping: (timeoutMs: number) => Promise<boolean> = pingPostgres) {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ ok: true, service: "tnp-api" });
  });

  router.get("/ready", async (_req, res) => {
    const ok = await ping(READINESS_TIMEOUT_MS);
    res.status(ok ? 200 : 503).json(ok ? { ok: true } : { ok: false, error: "database unavailable" });
  });

  return router;
}
