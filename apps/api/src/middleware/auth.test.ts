import { afterAll, beforeAll, expect, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import { getRequiredOxyUserId, requireOxyAuth } from "@oxyhq/core/server";
import { oxyAuthOptional } from "./auth.js";

/**
 * Regression lock for the @oxyhq/core server auth bypass (fixed in core 20.x).
 *
 * On the vulnerable core 12.x line, `oxy.auth()` decoded the bearer with
 * `jwtDecode()` (no signature check) and, for a token that carried NO
 * `sessionId`, took a "local validation only" branch that trusted the `userId`
 * claim verbatim. A forged, unsigned token therefore authenticated as any
 * account through exactly this composition: `oxyAuthOptional` (the app's
 * `createOptionalOxyAuth`) followed by a route's `requireOxyAuth`.
 *
 * These tests drive the real middleware chain over a live server so the lock
 * fails if the app is ever moved back onto a build without the session-binding
 * requirement. The forged token deliberately omits `sessionId`, which keeps the
 * assertion offline: the fixed middleware refuses it before any session round
 * trip to the Oxy API.
 */

/** Build an unsigned JWT with a `userId` claim and, crucially, no `sessionId`. */
function forgeSessionlessToken(userId: string): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "none", typ: "JWT" });
  const payload = encode({ userId, id: userId });
  return `${header}.${payload}.unsigned`;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Mirror the production wiring in src/index.ts: optional resolver first, then
  // a per-route guard that enforces authentication.
  app.post("/guarded", oxyAuthOptional, requireOxyAuth, (req, res) => {
    res.json({ userId: getRequiredOxyUserId(req) });
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected an AddressInfo from server.address()");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test("a forged, session-less bearer token is refused on a guarded route", async () => {
  const response = await fetch(`${baseUrl}/guarded`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${forgeSessionlessToken("victim-account-000")}`,
    },
    body: "{}",
  });

  expect(response.status).toBe(401);
});

test("a request with no bearer token is refused on a guarded route", async () => {
  const response = await fetch(`${baseUrl}/guarded`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

  expect(response.status).toBe(401);
});
