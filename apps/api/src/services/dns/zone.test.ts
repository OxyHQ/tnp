import { describe, expect, test } from "bun:test";
import type { Zone } from "../providers/contracts.js";
import { diffZones, hashZone, mergeZoneChanges } from "./zone.js";

const zone: Zone = {
  records: [
    { host: "@", type: "MX", value: "Mail.Example.", ttl: 1800, priority: 10 },
    { host: "@", type: "TXT", value: "v=spf1 -all", ttl: 1800, priority: null },
    { host: "_sip._tcp", type: "SRV", value: "0 5 5060 sip.example", ttl: 1800, priority: null },
  ],
  settings: { EmailType: "MX" },
  servedByProvider: true,
};
const types = ["A", "AAAA", "CNAME", "MX", "TXT"];
const NUL = String.fromCharCode(0);

describe("zone hashing", () => {
  test("is independent of record order and provider casing", () => {
    const reordered: Zone = {
      ...zone,
      records: [...zone.records].reverse().map((r) => (r.type === "MX" ? { ...r, value: "mail.example" } : r)),
    };
    expect(hashZone(reordered)).toBe(hashZone(zone));
  });

  test("changes when any record or setting changes", () => {
    expect(hashZone({ ...zone, settings: { EmailType: "FWD" } })).not.toBe(hashZone(zone));
    expect(hashZone({ ...zone, records: zone.records.slice(1) })).not.toBe(hashZone(zone));
    expect(hashZone({ ...zone, records: zone.records.map((r) => ({ ...r, ttl: 3600 })) })).not.toBe(hashZone(zone));
  });
});

describe("merging a change set into the full zone", () => {
  test("records the change does not mention — including unsupported types — are carried through", () => {
    const merged = mergeZoneChanges(
      zone,
      [{ action: "add", record: { host: "www", type: "A", value: "192.0.2.1", ttl: 1800, priority: null } }],
      types,
    );
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.zone.records).toHaveLength(4);
    expect(merged.zone.records.map((r) => r.type).sort()).toEqual(["A", "MX", "SRV", "TXT"]);
    expect(merged.zone.settings).toEqual({ EmailType: "MX" });
    expect(diffZones(zone, merged.zone)).toMatchObject({ added: [{ host: "www", type: "A" }], removed: [] });
  });

  test("update and delete must match an existing record, or the whole merge fails", () => {
    const missing = mergeZoneChanges(zone, [{ action: "delete", match: { host: "gone", type: "A", value: "192.0.2.9" } }], types);
    expect(missing.ok).toBe(false);
    const deleted = mergeZoneChanges(zone, [{ action: "delete", match: { host: "@", type: "TXT", value: "v=spf1 -all" } }], types);
    expect(deleted.ok && deleted.zone.records.length).toBe(2);
    const updated = mergeZoneChanges(
      zone,
      [
        {
          action: "update",
          match: { host: "@", type: "MX", value: "mail.example" },
          record: { host: "@", type: "MX", value: "mx2.example", ttl: 600, priority: 20 },
        },
      ],
      types,
    );
    expect(updated.ok && updated.zone.records.find((r) => r.type === "MX")).toEqual({
      host: "@",
      type: "MX",
      value: "mx2.example",
      ttl: 600,
      priority: 20,
    });
  });

  test("validation: CNAME exclusivity, duplicates, types, TTL, addresses", () => {
    const add = (record: Zone["records"][number]) => mergeZoneChanges(zone, [{ action: "add", record }], types);
    expect(add({ host: "@", type: "CNAME", value: "x.example", ttl: 1800, priority: null }).ok).toBe(false);
    expect(add({ host: "@", type: "TXT", value: "v=spf1 -all", ttl: 1800, priority: null }).ok).toBe(false);
    expect(add({ host: "x", type: "SRV", value: "0 0 1 y", ttl: 1800, priority: null }).ok).toBe(false);
    expect(add({ host: "x", type: "A", value: "192.0.2.1", ttl: 30, priority: null }).ok).toBe(false);
    expect(add({ host: "x", type: "A", value: "192.0.2.256", ttl: 1800, priority: null }).ok).toBe(false);
    expect(add({ host: "x", type: "A", value: "01.2.3.4", ttl: 1800, priority: null }).ok).toBe(false);
    expect(add({ host: "x", type: "AAAA", value: "2001:db8::1", ttl: 1800, priority: null }).ok).toBe(true);
    expect(add({ host: "x", type: "AAAA", value: "2001:db8:::1", ttl: 1800, priority: null }).ok).toBe(false);
    expect(add({ host: "x", type: "TXT", value: `bad${NUL}`, ttl: 1800, priority: null }).ok).toBe(false);
    expect(add({ host: "bad host", type: "A", value: "192.0.2.1", ttl: 1800, priority: null }).ok).toBe(false);
    expect(add({ host: "*.wild", type: "A", value: "192.0.2.1", ttl: 1800, priority: null }).ok).toBe(true);
  });
});
