import { describe, expect, test } from "bun:test";
import {
  classifyName,
  isReservedTld,
  normalizeName,
  tldOf,
  validateNativeTld,
  RESERVED_TLD_COUNT,
  SPECIAL_USE_TLDS,
} from "./policy.js";

/** The TLD policy table a client would have cached. */
const NATIVE = ["ox"];

describe("reserved TLD set", () => {
  test("is populated — a truncated snapshot would fail open", () => {
    // Without a floor, an empty or truncated iana-root-zone.ts would make every
    // assertion below pass while TNP quietly started accepting .com again.
    expect(RESERVED_TLD_COUNT).toBeGreaterThan(1000);
  });

  test("covers the TLDs TNP currently ships as its own", () => {
    // These are seeded as active TNP TLDs on any database created before this
    // change, which is the live namespace collision (audit S4).
    expect(isReservedTld("com")).toBe(true);
    expect(isReservedTld("app")).toBe(true);
  });

  test("covers ordinary public TLDs", () => {
    for (const tld of ["net", "org", "dev", "io", "uk", "de", "xyz"]) {
      expect(isReservedTld(tld)).toBe(true);
    }
  });

  test("covers IETF special-use names absent from the root zone", () => {
    for (const tld of SPECIAL_USE_TLDS) {
      expect(isReservedTld(tld)).toBe(true);
    }
    expect(isReservedTld("localhost")).toBe(true);
    expect(isReservedTld("onion")).toBe(true);
    expect(isReservedTld("internal")).toBe(true);
  });

  test("does not reserve TNP's own native TLD", () => {
    expect(isReservedTld("ox")).toBe(false);
  });

  test("normalizes case and the trailing root dot", () => {
    expect(isReservedTld("COM")).toBe(true);
    expect(isReservedTld("Com")).toBe(true);
    expect(isReservedTld(" com ")).toBe(true);
  });
});

describe("classifyName", () => {
  test("a native TLD is TNP's", () => {
    expect(classifyName("example.ox", NATIVE)).toBe("tnp-native");
    expect(classifyName("www.example.ox", NATIVE)).toBe("tnp-native");
    expect(classifyName("EXAMPLE.OX", NATIVE)).toBe("tnp-native");
    expect(classifyName("example.ox.", NATIVE)).toBe("tnp-native");
  });

  test("a public TLD is never TNP's", () => {
    for (const name of ["google.com", "example.app", "a.b.co.uk", "news.ycombinator.com"]) {
      expect(classifyName(name, NATIVE)).toBe("public-dns");
    }
  });

  test("classification does not depend on registration state", () => {
    // Whether example.ox is registered changes what it resolves to. It never
    // changes whether it is a TNP name — otherwise resolution behaviour leaks
    // the registry's contents, and an unregistered native name would fall
    // through to public DNS.
    expect(classifyName("definitely-not-registered-xyz.ox", NATIVE)).toBe("tnp-native");
  });

  test("a reserved TLD stays public even if the registry claims it", () => {
    // The load-bearing case. This is the exact state a database seeded before
    // this change is in: `.com` and `.app` present in the TLD policy table the
    // client fetches from /dns/tlds. The client must not shadow public names on
    // the server's say-so.
    const compromisedTable = ["ox", "com", "app", "net"];
    expect(classifyName("google.com", compromisedTable)).toBe("public-dns");
    expect(classifyName("example.app", compromisedTable)).toBe("public-dns");
    expect(classifyName("example.net", compromisedTable)).toBe("public-dns");
    expect(classifyName("example.ox", compromisedTable)).toBe("tnp-native");
  });

  test("a single-label name is public", () => {
    expect(classifyName("localhost", NATIVE)).toBe("public-dns");
    expect(classifyName("myprinter", NATIVE)).toBe("public-dns");
    expect(classifyName("ox", NATIVE)).toBe("public-dns");
    expect(classifyName("", NATIVE)).toBe("public-dns");
  });

  test("an empty policy table makes everything public", () => {
    expect(classifyName("example.ox", [])).toBe("public-dns");
  });

  test("does not match a TLD as a substring of a longer label", () => {
    expect(classifyName("example.oxy", NATIVE)).toBe("public-dns");
    expect(classifyName("example.xox", NATIVE)).toBe("public-dns");
  });
});

describe("tldOf", () => {
  test("returns the last label", () => {
    expect(tldOf("a.b.example.ox")).toBe("ox");
    expect(tldOf("example.ox.")).toBe("ox");
    expect(tldOf("EXAMPLE.OX")).toBe("ox");
  });

  test("returns empty for a single label", () => {
    expect(tldOf("localhost")).toBe("");
    expect(tldOf("")).toBe("");
  });
});

describe("normalizeName", () => {
  test("lowercases, trims and drops one trailing dot", () => {
    expect(normalizeName("  Example.OX.  ")).toBe("example.ox");
    expect(normalizeName("example.ox")).toBe("example.ox");
  });
});

describe("validateNativeTld", () => {
  test("accepts a plausible native TLD", () => {
    const result = validateNativeTld("ox");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tld).toBe("ox");
  });

  test("normalizes before validating", () => {
    const result = validateNativeTld("  OX  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tld).toBe("ox");
  });

  test("rejects a TLD the public root delegates, and says why", () => {
    for (const tld of ["com", "app", "net", "dev"]) {
      const result = validateNativeTld(tld);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("reserved");
        expect(result.detail).toContain(tld);
      }
    }
  });

  test("rejects IETF special-use names as reserved, not as syntax errors", () => {
    // The distinction matters: a syntax error tells the user to pick a valid
    // label, a reserved error tells them the label exists and is not ours.
    for (const tld of ["localhost", "onion", "test", "internal"]) {
      const result = validateNativeTld(tld);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("reserved");
    }
  });

  test("rejects malformed labels as syntax errors", () => {
    const cases = ["", "  ", "a.b", "-ox", "ox-", "o x", "o_x", "o/x", "o<x", "a".repeat(64)];
    for (const input of cases) {
      const result = validateNativeTld(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("syntax");
    }
  });

  test("rejects the IDN prefix", () => {
    // A TNP TLD beginning xn-- would be decoded as Punycode by every resolver
    // that never heard of TNP.
    const result = validateNativeTld("xn--tnptest");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("syntax");
  });

  test("accepts the longest legal label", () => {
    expect(validateNativeTld("a".repeat(63)).ok).toBe(true);
  });
});
