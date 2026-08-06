/**
 * The registry half of the service-node contract gate.
 *
 * Same shape and same reasoning as `relays.contract.test.ts`: the route must
 * accept what `@tnp/shared-types` describes, checked over real HTTP through
 * the real router. The `/nodes` endpoints happened to agree with the client
 * when the contracts were extracted — they agreed by hand, which is the exact
 * footing `/relays` was on right up until it did not.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import type { OxyAuthRequest } from "@oxyhq/core/server";
import type {
  RegisterServiceNodeRequest,
  ServiceNodeHeartbeatRequest,
} from "@tnp/shared-types";
import nodesRouter from "./nodes.js";

/** Status the handler returns once a body is past validation and hits the absent database. */
const REACHED_HANDLER = 500;
const DOMAIN_ID = "9f8d3b1c-2e4a-4d6b-8c7e-1a2b3c4d5e6f";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as OxyAuthRequest).userId = "oxy-user-under-test";
    next();
  });
  app.use("/nodes", nodesRouter);

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

async function postPastValidation(path: string, body: unknown): Promise<number> {
  const logged = spyOn(console, "error").mockImplementation(() => {});
  try {
    return (await post(path, body)).status;
  } finally {
    logged.mockRestore();
  }
}

describe("POST /nodes/register", () => {
  test("accepts the contract shape", async () => {
    const request: RegisterServiceNodeRequest = {
      domainId: DOMAIN_ID,
      publicKey: "cHVibGljLWtleQ==",
    };

    expect(await postPastValidation("/nodes/register", request)).toBe(REACHED_HANDLER);
  });

  test("names the field it rejects", async () => {
    const cases: Array<[unknown, string]> = [
      [{ publicKey: "cHVibGljLWtleQ==" }, "domainId is required"],
      [{ domainId: "not-a-uuid", publicKey: "cHVibGljLWtleQ==" }, "domainId must be a uuid"],
      [{ domainId: DOMAIN_ID }, "publicKey is required"],
    ];

    for (const [body, error] of cases) {
      expect(await post("/nodes/register", body)).toEqual({ status: 400, error });
    }
  });
});

describe("POST /nodes/heartbeat", () => {
  test("accepts the contract shape", async () => {
    const request: ServiceNodeHeartbeatRequest = {
      domainId: DOMAIN_ID,
      connectedRelay: "wss://relay.example.test",
    };

    expect(await postPastValidation("/nodes/heartbeat", request)).toBe(REACHED_HANDLER);
  });

  test("requires the relay the node is attached to", async () => {
    expect(await post("/nodes/heartbeat", { domainId: DOMAIN_ID })).toEqual({
      status: 400,
      error: "connectedRelay is required",
    });
  });
});
