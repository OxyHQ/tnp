import { describe, expect, test } from "bun:test";
import {
  MAX_AVAILABILITY_NAMES,
  parseAvailabilityNames,
  parseContact,
  parsePlaceOrderRequest,
  parseQuoteRequest,
  parseZoneApplyRequest,
  parseZoneChanges,
} from "./services.js";

const contact = {
  firstName: "Ada",
  lastName: "Example",
  address1: "1 Example Street",
  city: "Exampleton",
  stateProvince: "EX",
  postalCode: "00000",
  country: "us",
  phone: "+1.5555550100",
  email: "ada@example.invalid",
};

describe("services contracts", () => {
  test("availability accepts a comma list or repeated params, bounded", () => {
    expect(parseAvailabilityNames("a.com, b.net")).toEqual({ ok: true, value: ["a.com", "b.net"] });
    expect(parseAvailabilityNames(["a.com", "b.net"])).toEqual({ ok: true, value: ["a.com", "b.net"] });
    expect(parseAvailabilityNames(undefined).ok).toBe(false);
    expect(parseAvailabilityNames(" , ").ok).toBe(false);
    expect(parseAvailabilityNames(Array.from({ length: MAX_AVAILABILITY_NAMES + 1 }, (_, i) => `n${i}.com`)).ok).toBe(false);
  });

  test("quote years default to 1 and are bounded integers", () => {
    expect(parseQuoteRequest({ name: "a.com" })).toEqual({ ok: true, value: { name: "a.com", years: 1 } });
    for (const years of [0, 11, 1.5, "2"]) expect(parseQuoteRequest({ name: "a.com", years }).ok).toBe(false);
  });

  test("zone changes: each action has its required parts, and the list is bounded", () => {
    const ok = parseZoneChanges({
      changes: [
        { action: "add", record: { host: "www", type: "a", value: "192.0.2.1" } },
        { action: "delete", match: { host: "@", type: "TXT", value: "x" } },
      ],
    });
    expect(ok).toEqual({
      ok: true,
      value: [
        { action: "add", record: { host: "www", type: "A", value: "192.0.2.1", ttl: 1800, priority: null } },
        { action: "delete", match: { host: "@", type: "TXT", value: "x" } },
      ],
    });
    expect(parseZoneChanges({ changes: [] }).ok).toBe(false);
    expect(parseZoneChanges({ changes: [{ action: "rename" }] }).ok).toBe(false);
    expect(parseZoneChanges({ changes: [{ action: "update", record: { host: "a", type: "A", value: "1" } }] }).ok).toBe(false);
    expect(parseZoneChanges({ changes: Array.from({ length: 51 }, () => ({ action: "delete", match: { host: "a", type: "A", value: "1" } })) }).ok).toBe(false);
  });

  test("applying needs the preview's hash", () => {
    const changes = [{ action: "delete", match: { host: "a", type: "A", value: "1" } }];
    expect(parseZoneApplyRequest({ changes }).ok).toBe(false);
    expect(parseZoneApplyRequest({ changes, baseHash: "abc" }).ok).toBe(false);
    expect(parseZoneApplyRequest({ changes, baseHash: "a".repeat(64) }).ok).toBe(true);
  });

  test("contacts are validated and normalized, and optional fields are dropped when empty", () => {
    const parsed = parseContact({ ...contact, organization: "" });
    expect(parsed).toEqual({ ok: true, value: { ...contact, country: "US" } });
    expect(parseContact({ ...contact, phone: "555-0100" }).ok).toBe(false);
    expect(parseContact({ ...contact, email: "nope" }).ok).toBe(false);
    expect(parseContact({ ...contact, country: "USA" }).ok).toBe(false);
    expect(parseContact({ ...contact, city: undefined }).ok).toBe(false);
  });

  test("an order needs quote ids, a valid contact and explicit acceptance", () => {
    const id = "9f8d3b1c-2e4a-4d6b-8c7e-1a2b3c4d5e6f";
    expect(parsePlaceOrderRequest({ quoteIds: [id], contact, acceptedTerms: true }).ok).toBe(true);
    expect(parsePlaceOrderRequest({ quoteIds: [id], contact, acceptedTerms: "yes" }).ok).toBe(false);
    expect(parsePlaceOrderRequest({ quoteIds: ["not-a-uuid"], contact, acceptedTerms: true }).ok).toBe(false);
    expect(parsePlaceOrderRequest({ quoteIds: [], contact, acceptedTerms: true }).ok).toBe(false);
  });
});
