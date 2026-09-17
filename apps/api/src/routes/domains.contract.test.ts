/**
 * The `/domains` response and request contracts.
 *
 * Serializer half: a public DTO must not carry any owner identifier, however
 * the row changes. Asserted as absence of the keys, not only equality to an
 * expected object, so the test says what it protects.
 *
 * HTTP half, same shape as `relays.contract.test.ts`: the real router with no
 * database. A body the contract refuses is a 400 with the parser's code; one it
 * accepts reaches the handler and 500s at `getDb()`. Availability of a name that
 * is not registrable is decided before any query, so it answers here too.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import express from "express";
import type { Server } from "node:http";
import type { OxyAuthRequest } from "@oxy.so/core/server";
import type { CreateDnsRecordRequest, NativeAvailability } from "@tnp/shared-types";
import domainsRouter from "./domains.js";
import {
  serializeDnsRecord,
  toOwnedDomain,
  toOwnedDomainSummary,
  toOwnedDomainWithRecords,
  toPublicDomain,
  toPublicDomainWithRecords,
} from "../registry/serialize.js";

const createdAt = new Date("2026-09-12T20:00:00.000Z");
const updatedAt = new Date("2026-09-12T21:00:00.000Z");
const domain = {
  id: "9f8d3b1c-2e4a-4d6b-8c7e-1a2b3c4d5e6f",
  name: "example",
  tld: "ox",
  ownerId: "6a893ae7-7b95-4e9e-99ef-989c4c1f256c",
  oxyUserId: "oxy-user-under-test",
  status: "active" as const,
  createdAt,
  updatedAt,
  expiresAt: null,
};
const record = {
  id: "d96e5ccc-f43d-4426-a403-212ecbfed24f",
  domainId: domain.id,
  type: "A" as const,
  name: "@",
  value: "192.0.2.1",
  ttl: 3600,
  createdAt,
  updatedAt,
};

/** Every key that identifies an owner, on the row or anywhere it might be copied. */
const OWNER_KEYS = ["oxyUserId", "ownerId", "owner", "proposedBy", "proposedById"];

function expectNoOwnerKeys(value: object): void {
  const keys = Object.keys(value);
  // Floor: an empty object would pass the absence check below by containing nothing.
  expect(keys).toContain("name");
  for (const key of OWNER_KEYS) expect(keys).not.toContain(key);
  expect(JSON.stringify(value)).not.toContain(domain.oxyUserId);
  expect(JSON.stringify(value)).not.toContain(domain.ownerId);
}

describe("public domain DTO", () => {
  test("carries the directory fields as wire strings and no owner identifier", () => {
    const dto = toPublicDomain(domain);
    expect(dto).toEqual({
      _id: domain.id,
      name: "example",
      tld: "ox",
      status: "active",
      createdAt: "2026-09-12T20:00:00.000Z",
      updatedAt: "2026-09-12T21:00:00.000Z",
      expiresAt: null,
    });
    expectNoOwnerKeys(dto);
  });

  test("the lookup view with records carries no owner identifier either", () => {
    const dto = toPublicDomainWithRecords(domain, [record]);
    expectNoOwnerKeys(dto);
    expect(dto.records).toEqual([serializeDnsRecord(record)]);
  });

  test("serializes only records belonging to the domain", () => {
    const dto = toPublicDomainWithRecords(domain, [
      record,
      { ...record, id: "b730a3f2-7340-490e-9c55-a9c0ccdded16", domainId: crypto.randomUUID() },
    ]);
    expect(dto.records).toEqual([serializeDnsRecord(record)]);
  });
});

describe("owner domain DTO", () => {
  const now = new Date("2026-09-17T00:00:00.000Z");

  test("adds the expiry state the dashboard shows, still without the owner's ids", () => {
    const expiring = { ...domain, expiresAt: new Date("2026-10-01T00:00:00.000Z") };
    expect(toOwnedDomain(expiring, now)).toEqual({
      ...toPublicDomain(expiring),
      expiryState: "renewable",
    });
    expect(toOwnedDomain(domain, now).expiryState).toBe("active");
    expectNoOwnerKeys(toOwnedDomain(domain, now));
    expectNoOwnerKeys(toOwnedDomainSummary(domain, 3, now));
    expectNoOwnerKeys(toOwnedDomainWithRecords(domain, [record], now));
  });

  test("the inventory summary counts records rather than embedding them", () => {
    const summary = toOwnedDomainSummary(domain, 7, now);
    expect(summary.recordCount).toBe(7);
    expect(Object.keys(summary)).not.toContain("records");
  });
});

describe("routes, with no database", () => {
  let server: Server;
  let baseUrl: string;
  const REACHED_HANDLER = 500;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as OxyAuthRequest).userId = "oxy-user-under-test";
      next();
    });
    app.use("/domains", domainsRouter);
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

  async function send(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    } finally {
      logged.mockRestore();
    }
  }

  const DOMAIN_PATH = `/domains/${domain.id}/records`;

  test("POST records: a well-formed record reaches the handler", async () => {
    const request: CreateDnsRecordRequest = {
      type: "MX",
      name: "@",
      value: "mail.example.ox",
      priority: 10,
    };
    expect((await send("POST", DOMAIN_PATH, request)).status).toBe(REACHED_HANDLER);
  });

  test("POST records: the parser's code and field come back with the 400", async () => {
    expect(await send("POST", DOMAIN_PATH, { type: "A", name: "@", value: "999.1.1.1" })).toEqual({
      status: 400,
      body: {
        error: "An A record needs an IPv4 address like 192.0.2.1",
        code: "ipv4_invalid",
        field: "value",
      },
    });
    const ttl = await send("POST", DOMAIN_PATH, { type: "A", name: "@", value: "192.0.2.1", ttl: 5 });
    expect(ttl.status).toBe(400);
    expect(ttl.body.code).toBe("ttl_invalid");
  });

  test("PUT records: a malformed patch is refused before any lookup", async () => {
    const response = await send("PUT", `${DOMAIN_PATH}/${record.id}`, { ttl: 100000 });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe("ttl_invalid");
    expect((await send("PUT", `${DOMAIN_PATH}/${record.id}`, { ttl: 120 })).status).toBe(REACHED_HANDLER);
  });

  test("check: a subdomain is invalid with a message, not a crash or a split", async () => {
    const response = await send("GET", "/domains/check/a.b.ox");
    expect(response.status).toBe(200);
    const body = response.body as unknown as NativeAvailability;
    expect(body.available).toBe(false);
    expect(body.reason).toBe("invalid");
    expect(body.namespace).toBe("tnp-native");
    expect(body.detail).toContain("subdomain");
  });

  test("check: both route forms refuse a reserved TLD as reserved", async () => {
    for (const path of ["/domains/check/google.com", "/domains/check/google/com"]) {
      const response = await send("GET", path);
      expect(response.status).toBe(200);
      expect(response.body.available).toBe(false);
      expect(response.body.reason).toBe("reserved");
    }
  });

  test("check: a registrable name goes on to the registry", async () => {
    expect((await send("GET", "/domains/check/example.ox")).status).toBe(REACHED_HANDLER);
  });

  test("renew: a malformed id is a 404 before any lookup", async () => {
    expect((await send("POST", "/domains/not-a-uuid/renew")).status).toBe(404);
    expect((await send("POST", `/domains/${domain.id}/renew`)).status).toBe(REACHED_HANDLER);
  });

  test("owned and the deprecated mine both exist behind auth", async () => {
    expect((await send("GET", "/domains/owned?page=2&limit=5")).status).toBe(REACHED_HANDLER);
    expect((await send("GET", "/domains/mine")).status).toBe(REACHED_HANDLER);
  });
});
