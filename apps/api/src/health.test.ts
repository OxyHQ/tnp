import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import type postgres from "postgres";
import { pingDatabase } from "./db/postgres.js";
import { createHealthRouter, READINESS_TIMEOUT_MS } from "./health.js";

let server: Server;
let baseUrl: string;
let dbUp = true;
const timeouts: number[] = [];

beforeAll(async () => {
  const app = express();
  app.use(
    "/health",
    createHealthRouter(async (timeoutMs) => {
      timeouts.push(timeoutMs);
      return dbUp;
    }),
  );
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

describe("/health", () => {
  test("is liveness only: it answers without asking the database", async () => {
    dbUp = false;
    const before = timeouts.length;
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "tnp-api" });
    expect(timeouts.length).toBe(before);
  });
});

describe("/health/ready", () => {
  test("is 200 when the database answers, with the bounded timeout", async () => {
    dbUp = true;
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(timeouts.at(-1)).toBe(READINESS_TIMEOUT_MS);
    expect(READINESS_TIMEOUT_MS).toBe(2000);
  });

  test("is 503 when it does not", async () => {
    dbUp = false;
    const res = await fetch(`${baseUrl}/health/ready`);
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });
});

describe("pingDatabase", () => {
  test("is false before a pool exists", async () => {
    expect(await pingDatabase(null, 50)).toBe(false);
  });

  test("gives up at the timeout when the query never returns", async () => {
    // Only the tagged-template call is exercised; a query that never settles is
    // the case a real server cannot be made to produce on demand.
    const hanging = (() => new Promise<never>(() => {})) as unknown as postgres.Sql;
    const started = Date.now();
    expect(await pingDatabase(hanging, 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("is false, not a throw, when the query fails", async () => {
    const failing = (() => Promise.reject(new Error("connection refused"))) as unknown as postgres.Sql;
    expect(await pingDatabase(failing, 1000)).toBe(false);
  });
});
