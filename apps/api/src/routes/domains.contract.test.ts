import { describe, expect, test } from "bun:test";
import { serializeDnsRecord, serializeDomain, serializeDomainWithRecords } from "./domains.js";

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

describe("domain API response contract", () => {
  test("uses the client-facing identifier without exposing database ownership keys", () => {
    expect(serializeDomain(domain)).toEqual({
      _id: domain.id,
      name: "example",
      tld: "ox",
      oxyUserId: "oxy-user-under-test",
      status: "active",
      createdAt,
      updatedAt,
      expiresAt: null,
    });
  });

  test("always includes a records array", () => {
    expect(serializeDomainWithRecords(domain, [])).toEqual({
      ...serializeDomain(domain),
      records: [],
    });
  });

  test("serializes only records belonging to the domain", () => {
    expect(
      serializeDomainWithRecords(domain, [
        record,
        { ...record, id: "b730a3f2-7340-490e-9c55-a9c0ccdded16", domainId: crypto.randomUUID() },
      ]),
    ).toEqual({ ...serializeDomain(domain), records: [serializeDnsRecord(record)] });
  });
});
