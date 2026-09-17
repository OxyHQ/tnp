import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { availabilityMessageKey, parentDomain } from "../src/lib/availability";

const LOCALES = join(import.meta.dir, "..", "public", "locales");

describe("availabilityMessageKey", () => {
  test("maps every reason, and the legacy reason-less refusal to 'taken'", () => {
    expect(availabilityMessageKey({ domain: "a.ox", available: true })).toBe("common:availability.available");
    expect(availabilityMessageKey({ domain: "a.ox", available: false })).toBe("common:availability.taken");
    expect(availabilityMessageKey({ domain: "a.ox", available: false, reason: "registered" })).toBe(
      "common:availability.taken",
    );
    expect(availabilityMessageKey({ domain: "a.com", available: false, reason: "reserved" })).toBe(
      "common:availability.reserved",
    );
    expect(availabilityMessageKey({ domain: "a.zz", available: false, reason: "tld_not_available" })).toBe(
      "common:availability.tldNotAvailable",
    );
    expect(availabilityMessageKey({ domain: "-a.ox", available: false, reason: "invalid" })).toBe(
      "common:availability.invalid",
    );
    expect(availabilityMessageKey({ domain: "a.b.ox", available: false, reason: "invalid" })).toBe(
      "common:availability.subdomain",
    );
    expect(parentDomain("a.b.ox")).toBe("b.ox");
  });

  test("every key it can return exists in all five locales", () => {
    const keys = ["available", "taken", "reserved", "tldNotAvailable", "invalid", "subdomain"];
    for (const lang of ["en", "zh", "es", "hi", "fr"]) {
      const common = JSON.parse(readFileSync(join(LOCALES, lang, "common.json"), "utf8"));
      for (const key of keys) {
        expect(typeof common.availability?.[key]).toBe("string");
      }
    }
  });
});

describe("locale parity for the namespaces this change touched", () => {
  function flatten(value: unknown, prefix = ""): string[] {
    if (typeof value !== "object" || value === null) return [prefix];
    return Object.entries(value).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
  }

  for (const ns of ["common", "dashboard", "serviceNodes", "home", "register"]) {
    test(`${ns}: every locale has exactly the English keys`, () => {
      const en = flatten(JSON.parse(readFileSync(join(LOCALES, "en", `${ns}.json`), "utf8"))).sort();
      expect(en.length).toBeGreaterThan(3);
      for (const lang of ["zh", "es", "hi", "fr"]) {
        const other = flatten(JSON.parse(readFileSync(join(LOCALES, lang, `${ns}.json`), "utf8"))).sort();
        expect(other).toEqual(en);
      }
    });
  }
});
