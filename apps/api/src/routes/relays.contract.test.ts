/**
 * The registry half of the client/API contract gate.
 *
 * `packages/client/src/api.contract.test.ts` proves the client sends what
 * `@tnp/shared-types` describes. This proves the route ACCEPTS what
 * `@tnp/shared-types` describes — over real HTTP, through the real router,
 * rather than by calling the parser directly, which would only prove the
 * parser agrees with itself.
 *
 * Without both halves the gate has a hole: a route that quietly went back to
 * hand-written field checks would drift from the client again while every
 * parser test stayed green. That is precisely how audit B2 happened.
 *
 * No database is provided on purpose. Validation runs before the first query,
 * so a rejected body is a 400 from the contract and an accepted body reaches
 * the handler and fails at `getDb()` — which is what makes "did this body get
 * past validation?" observable without standing up Postgres.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import type { OxyAuthRequest } from "@oxyhq/core/server";
import type { RegisterRelayRequest, RelayHeartbeatRequest } from "@tnp/shared-types";
import relaysRouter from "./relays.js";

/** Status the handler returns once a body is past validation and hits the absent database. */
const REACHED_HANDLER = 500;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stands in for the app's optional Oxy auth: `requireOxyAuth` authorizes
  // whatever `getOxyUserId` can read off the request, so a userId is all a
  // route test needs to get past the guard.
  app.use((req, _res, next) => {
    (req as OxyAuthRequest).userId = "oxy-user-under-test";
    next();
  });
  app.use("/relays", relaysRouter);

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

async function post(path: string, body: unknown): Promise<{ status: number; error?: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, error: payload.error };
}

/**
 * Run a request whose body is valid, silencing the handler's log of the
 * database failure it is expected to hit.
 */
async function postPastValidation(path: string, body: unknown): Promise<number> {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    return (await post(path, body)).status;
  } finally {
    logged.mockRestore();
  }
}

describe("POST /relays/register", () => {
  test("accepts the contract shape", async () => {
    const request: RegisterRelayRequest = {
      endpoint: "wss://relay.example.test:8443",
      publicKey: "Zm9vYmFyLXB1YmxpYy1rZXk=",
      operator: "community",
      capacity: { maxConnections: 100, bandwidth: 250 },
      location: "eu-west",
    };

    // Past validation and into the handler, where the absent database stops it.
    expect(await postPastValidation("/relays/register", request)).toBe(REACHED_HANDLER);
  });

  test("rejects the body the client sent before @tnp/shared-types existed", async () => {
    // Audit B2 verbatim. This is the request every `tnp relay` ever made.
    expect(await post("/relays/register", { port: 8080, location: "eu-west" })).toEqual({
      status: 400,
      error: "endpoint is required",
    });
  });

  test("rejects a registration missing any field the directory depends on", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ publicKey: undefined }, "publicKey is required"],
      [{ operator: "someone-else" }, "operator must be 'oxy' or 'community'"],
      [{ capacity: undefined }, "capacity with maxConnections and bandwidth is required"],
      [
        { capacity: { maxConnections: Number.NaN, bandwidth: 0 } },
        "capacity.maxConnections must be an integer between 1 and 1000000",
      ],
      [
        { endpoint: "https://relay.example.test" },
        "endpoint must be a ws:// or wss:// URL with no credentials, query or fragment",
      ],
    ];

    for (const [override, error] of cases) {
      const response = await post("/relays/register", {
        endpoint: "wss://relay.example.test:8443",
        publicKey: "Zm9vYmFyLXB1YmxpYy1rZXk=",
        operator: "community",
        capacity: { maxConnections: 100, bandwidth: 250 },
        location: "eu-west",
        ...override,
      });
      expect(response).toEqual({ status: 400, error });
    }
  });
});

describe("POST /relays/heartbeat", () => {
  test("accepts the contract shape", async () => {
    const request: RelayHeartbeatRequest = { endpoint: "wss://relay.example.test:8443" };

    expect(await postPastValidation("/relays/heartbeat", request)).toBe(REACHED_HANDLER);
  });

  test("rejects the body the client sent before @tnp/shared-types existed", async () => {
    expect(
      await post("/relays/heartbeat", {
        relayId: "68b0f0a4c1f0a4a9b7d2e3f4",
        serviceNodes: 2,
        activeCircuits: 5,
      }),
    ).toEqual({ status: 400, error: "endpoint is required" });
  });
});

describe("the gate itself", () => {
  test("an unauthenticated request never reaches validation", async () => {
    // The 500 that stands for "accepted" above must not be reachable any other
    // way, or every acceptance assertion here is vacuous. Mounted without the
    // auth stub, the same valid body stops at the guard.
    const guarded = express();
    guarded.use(express.json());
    guarded.use("/relays", relaysRouter);

    const listening = await new Promise<Server>((resolve) => {
      const s = guarded.listen(0, () => resolve(s));
    });
    const address = listening.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/relays/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          endpoint: "wss://relay.example.test:8443",
          publicKey: "Zm9vYmFyLXB1YmxpYy1rZXk=",
          operator: "community",
          capacity: { maxConnections: 100, bandwidth: 250 },
          location: "eu-west",
        }),
      });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => {
        listening.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
