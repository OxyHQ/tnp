import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type { OperationStatusDto, PublicAvailabilityStatus, PublicDomainLifecycleDto, ServicesStatus } from "@tnp/shared-types";
import {
  availabilityPresentation,
  canQuote,
  isTerminalOperation,
  lifecyclePresentation,
  operationPresentation,
  purchaseBlockedKey,
  servicesAvailability,
  zoneStatePresentation,
} from "../src/lib/services/status";
import { availabilityPath, newIdempotencyKey, parseSearchInput } from "../src/lib/services/search";
import { draftToChanges, emptyRow, rowFor, sameIntent } from "../src/lib/services/zone";

const LOCALES = ["en", "zh", "es", "hi", "fr"] as const;
const localeFile = (lng: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, "..", "public", "locales", lng, "services.json"), "utf-8"));

function hasKey(dict: Record<string, unknown>, key: string): boolean {
  let node: unknown = dict;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string";
}

const AVAILABILITY: PublicAvailabilityStatus[] = ["available", "unavailable", "unknown", "unsupported", "invalid"];
const OPERATIONS: OperationStatusDto[] = ["queued", "running", "succeeded", "failed", "unknown", "manual_review"];
const LIFECYCLES: PublicDomainLifecycleDto[] = [
  "pending", "active", "expired", "redemption", "transferring_in", "transferred_out", "locked_by_registry", "failed", "unknown",
];

describe("availability never overstates", () => {
  test("only `available` is presented as success and offers a quote", () => {
    for (const status of AVAILABILITY) {
      const shown = availabilityPresentation(status);
      expect(shown.tone === "success").toBe(status === "available");
      expect(canQuote(status)).toBe(status === "available");
    }
  });

  test("unknown and unsupported are distinct from each other and from available", () => {
    const labels = AVAILABILITY.map((s) => availabilityPresentation(s).labelKey);
    expect(new Set(labels).size).toBe(AVAILABILITY.length);
    expect(availabilityPresentation("unknown").tone).toBe("warning");
    expect(availabilityPresentation("unsupported").tone).toBe("warning");
  });
});

describe("an unconfirmed outcome is never a failure", () => {
  test("unknown and manual_review are warnings, not errors", () => {
    expect(operationPresentation("unknown").tone).toBe("warning");
    expect(operationPresentation("manual_review").tone).toBe("warning");
    expect(operationPresentation("failed").tone).toBe("error");
    expect(lifecyclePresentation("unknown").tone).toBe("warning");
  });

  test("polling stops on the API's terminal set only", () => {
    expect(OPERATIONS.filter(isTerminalOperation)).toEqual(["succeeded", "failed", "manual_review"]);
  });
});

describe("services availability from /services/status", () => {
  // Built from the fields the web reads; `renewals` is being removed from the
  // contract and is deliberately not referenced.
  const status = (over: Partial<ServicesStatus> = {}): ServicesStatus =>
    ({
      catalog: true,
      dnsWrite: false,
      purchasable: false,
      purchaseBlockedReason: "payments_not_configured",
      ...over,
    }) as ServicesStatus;

  test("a 404 means not deployed, and is not an error", () => {
    expect(servicesAvailability({ httpStatus: 404 })).toEqual({ kind: "not_available", reason: "not_deployed" });
  });

  test("no response or a server error is unreachable", () => {
    expect(servicesAvailability({ httpStatus: null })).toEqual({ kind: "not_available", reason: "unreachable" });
    expect(servicesAvailability({ httpStatus: 502 })).toEqual({ kind: "not_available", reason: "unreachable" });
  });

  test("the catalog flag gates the area", () => {
    expect(servicesAvailability({ status: status({ catalog: false }) })).toEqual({ kind: "not_available", reason: "catalog_off" });
    expect(servicesAvailability({ status: status() }).kind).toBe("available");
  });

  test("each purchase block reason has its own explanation", () => {
    expect(purchaseBlockedKey("sales_disabled")).not.toBe(purchaseBlockedKey("payments_not_configured"));
  });
});

describe("every presented label is translated in every locale", () => {
  const keys = [
    ...AVAILABILITY.flatMap((s) => [availabilityPresentation(s).labelKey, `availability.explain.${s}`]),
    ...OPERATIONS.flatMap((s) => [operationPresentation(s).labelKey, `operation.explain.${s}`]),
    ...LIFECYCLES.flatMap((s) => [lifecyclePresentation(s).labelKey, `lifecycle.explain.${s}`]),
    ...(["unmanaged", "in_sync", "pending", "conflict", "unknown"] as const).map((s) => zoneStatePresentation(s).labelKey),
    purchaseBlockedKey("sales_disabled"),
    purchaseBlockedKey("payments_not_configured"),
    "operation.kind.dns_apply",
    "operation.kind.domain_register",
    "operation.kind.domain_renew",
    "operation.kind.domain_sync",
  ];

  for (const lng of LOCALES) {
    test(lng, () => {
      const dict = localeFile(lng);
      expect(keys.filter((key) => !hasKey(dict, key))).toEqual([]);
    });
  }
});

describe("search input", () => {
  test("splits, trims, de-duplicates and caps at the API limit", () => {
    const input = "a.com, B.com  b.com\nc.com,d.com e.com f.com g.com h.com i.com j.com k.com l.com";
    const { names, dropped } = parseSearchInput(input);
    expect(names).toEqual(["a.com", "b.com", "c.com", "d.com", "e.com", "f.com", "g.com", "h.com", "i.com", "j.com"]);
    expect(dropped).toBe(2);
  });

  test("empty input is no search", () => {
    expect(parseSearchInput("  , ,")).toEqual({ names: [], dropped: 0 });
  });

  test("names are URL-encoded in the query", () => {
    expect(availabilityPath(["bücher.de", "a.com"])).toBe("/services/domains/availability?name=b%C3%BCcher.de,a.com");
  });

  test("idempotency keys fit the API's 8–128 character rule and differ", () => {
    const a = newIdempotencyKey();
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(a.length).toBeLessThanOrEqual(128);
    expect(newIdempotencyKey()).not.toBe(a);
  });
});

describe("zone draft", () => {
  test("rows become the wire changes the API parser accepts", () => {
    const add = { ...emptyRow("add"), host: "www", type: "CNAME", value: "example.com.", ttl: "300" };
    const del = rowFor("delete", { host: "@", type: "A", value: "192.0.2.1", ttl: 1800, priority: null });
    const mx = { ...rowFor("update", { host: "@", type: "MX", value: "mx1.example.com.", ttl: 1800, priority: 10 }), priority: "20" };
    const parsed = draftToChanges([add, del, mx]);
    expect(parsed).toEqual({
      ok: true,
      value: [
        { action: "add", record: { host: "www", type: "CNAME", value: "example.com.", ttl: 300, priority: null } },
        { action: "delete", match: { host: "@", type: "A", value: "192.0.2.1" } },
        {
          action: "update",
          match: { host: "@", type: "MX", value: "mx1.example.com." },
          record: { host: "@", type: "MX", value: "mx1.example.com.", ttl: 1800, priority: 20 },
        },
      ],
    });
  });

  test("an invalid row is reported, not truncated", () => {
    expect(draftToChanges([{ ...emptyRow("add"), value: "192.0.2.1", ttl: "3.5" }]).ok).toBe(false);
    expect(draftToChanges([{ ...emptyRow("add"), value: "" }]).ok).toBe(false);
    expect(draftToChanges([]).ok).toBe(false);
  });

  test("an intent is the same only for the same changes against the same base", () => {
    const changes = [{ action: "delete" as const, match: { host: "@", type: "A", value: "192.0.2.1" } }];
    const base = "a".repeat(64);
    expect(sameIntent({ changes, baseHash: base }, { changes: [...changes], baseHash: base })).toBe(true);
    expect(sameIntent({ changes, baseHash: base }, { changes, baseHash: "b".repeat(64) })).toBe(false);
    expect(sameIntent({ changes, baseHash: base }, { changes: [], baseHash: base })).toBe(false);
  });
});
