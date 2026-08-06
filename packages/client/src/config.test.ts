import { describe, expect, test } from "bun:test";
import { applyStoredConfig, parsePrivacyLevel, type TnpConfig } from "./config";

describe("parsePrivacyLevel", () => {
  test("accepts the level the client can actually provide", () => {
    const result = parsePrivacyLevel("access");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.level).toBe("access");
  });

  test('rejects "private" by name, because multi-hop routing is not implemented', () => {
    // The whole point of this function: `--privacy private` used to be accepted,
    // stored, echoed back as `privacy: private`, and then ignored — giving the
    // caller single-hop routing plus a status line claiming otherwise.
    const result = parsePrivacyLevel("private");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("private");
      expect(result.error).toContain("not implemented");
    }
  });

  test("distinguishes a planned level from an unknown one", () => {
    const planned = parsePrivacyLevel("private");
    const unknown = parsePrivacyLevel("paranoid");

    expect(planned.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    if (!planned.ok && !unknown.ok) {
      expect(planned.error).not.toBe(unknown.error);
      expect(unknown.error).toContain("unknown");
    }
  });

  test("rejects near-misses rather than coercing them", () => {
    for (const value of ["", "ACCESS", " access", "access ", "acces", "undefined"]) {
      expect(parsePrivacyLevel(value).ok).toBe(false);
    }
  });

  test("does not inherit a level from Object.prototype", () => {
    // The planned-level lookup is a plain object index; a bare `in`/truthiness
    // check against it would treat "constructor" and "toString" as levels.
    for (const value of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const result = parsePrivacyLevel(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("unknown");
    }
  });
});

describe("applyStoredConfig", () => {
  test("fills defaults for absent keys", () => {
    const config = applyStoredConfig({});
    expect(config.privacyLevel).toBe("access");
    expect(config.listenPort).toBe(5354);
    expect(config.socksPort).toBe(1080);
  });

  test("stored values override defaults", () => {
    const config = applyStoredConfig({ listenPort: 5999, socksPort: 9050 });
    expect(config.listenPort).toBe(5999);
    expect(config.socksPort).toBe(9050);
  });

  test('normalizes a stored "private" back to "access"', () => {
    // A config written by an earlier build can name a level that never worked.
    // Trusting it would put the user back in exactly the state this fixes.
    const stored = { privacyLevel: "private" } as unknown as Partial<TnpConfig>;
    expect(applyStoredConfig(stored).privacyLevel).toBe("access");
  });

  test("normalizes any unusable stored level, not only the known-planned one", () => {
    for (const value of ["paranoid", "", "PRIVATE", 42, null]) {
      const stored = { privacyLevel: value } as unknown as Partial<TnpConfig>;
      expect(applyStoredConfig(stored).privacyLevel).toBe("access");
    }
  });

  test("leaves a valid stored level alone", () => {
    expect(applyStoredConfig({ privacyLevel: "access" }).privacyLevel).toBe("access");
  });
});
