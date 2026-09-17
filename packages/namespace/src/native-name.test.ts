import { describe, expect, test } from "bun:test";
import { parseNativeDomainName, validateNativeLabel } from "./policy.js";

describe("validateNativeLabel", () => {
  test("accepts and lowercases a legal label", () => {
    expect(validateNativeLabel("Example-1")).toEqual({ ok: true, label: "example-1" });
    expect(validateNativeLabel("a".repeat(63)).ok).toBe(true);
  });

  test("refuses what registration refuses", () => {
    for (const input of ["", " ", "-a", "a-", "a_b", "a.b", "a b", "a".repeat(64), "ñ"]) {
      expect(validateNativeLabel(input).ok).toBe(false);
    }
  });
});

describe("parseNativeDomainName", () => {
  test("splits a registrable native name, normalizing case and the root dot", () => {
    expect(parseNativeDomainName("Nate.OX.")).toEqual({ ok: true, name: "nate", tld: "ox" });
  });

  test("a subdomain is invalid and says it is a record, never a crash or a split", () => {
    const parsed = parseNativeDomainName("a.b.ox");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("syntax");
    expect(parsed.detail).toContain("subdomain");
    expect(parsed.detail).toContain("b.ox");
  });

  test("a single label or an empty label is a format error", () => {
    for (const input of ["nate", "", ".ox", "nate.", "a..ox"]) {
      const parsed = parseNativeDomainName(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe("syntax");
    }
  });

  test("a reserved TLD is reported as reserved, whatever the label", () => {
    for (const input of ["google.com", "bad_label.com", "x.localhost"]) {
      const parsed = parseNativeDomainName(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toBe("reserved");
    }
  });

  test("an illegal label under a native TLD is a syntax error", () => {
    const parsed = parseNativeDomainName("-bad.ox");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("syntax");
  });
});
