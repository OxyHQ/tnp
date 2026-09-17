import { describe, expect, test } from "bun:test";
import { normalizePublicName, splitRegistrableName } from "./publicNames.js";

const offered = new Set(["com", "uk", "co.uk", "xn--p1ai"]);

describe("public name normalization", () => {
  test("case, trailing root dot and whitespace are canonicalized", () => {
    expect(normalizePublicName("  Example.COM. ")).toMatchObject({ ok: true, ascii: "example.com" });
  });

  test("IDN input becomes Punycode for storage and stays Unicode for display", () => {
    const result = normalizePublicName("Bücher.com");
    expect(result).toMatchObject({ ok: true, ascii: "xn--bcher-kva.com", unicode: "bücher.com" });
  });

  test("a TNP-native or special-use TLD is never a public domain", () => {
    expect(normalizePublicName("nate.ox")).toMatchObject({ ok: false, reason: "not_public" });
    expect(normalizePublicName("service.onion")).toMatchObject({ ok: false, reason: "not_public" });
    expect(normalizePublicName("printer.local")).toMatchObject({ ok: false, reason: "not_public" });
  });

  test("syntax errors are refused", () => {
    for (const bad of ["", "com", "a..com", "-a.com", "a-.com", "a b.com", "user@a.com", "http://a.com", `${"a".repeat(64)}.com`]) {
      expect(normalizePublicName(bad).ok).toBe(false);
    }
    expect(normalizePublicName(`${"a.".repeat(126)}com`).ok).toBe(false);
  });
});

describe("registrable split", () => {
  test("uses the longest suffix the provider offers, not split('.')", () => {
    expect(splitRegistrableName("nombre.co.uk", offered)).toEqual({
      ok: true,
      name: { ascii: "nombre.co.uk", unicode: "nombre.co.uk", sld: "nombre", suffix: "co.uk" },
    });
    expect(splitRegistrableName("nombre.uk", offered)).toMatchObject({ ok: true, name: { sld: "nombre", suffix: "uk" } });
  });

  test("a host under a registrable name is refused, not truncated", () => {
    expect(splitRegistrableName("www.example.com", offered)).toMatchObject({ ok: false, reason: "not_registrable" });
  });

  test("an extension the provider does not offer is reported as such", () => {
    expect(splitRegistrableName("example.org", offered)).toMatchObject({ ok: false, reason: "suffix_not_offered" });
  });

  test("IDN TLDs match their Punycode suffix", () => {
    expect(splitRegistrableName("пример.рф", offered)).toMatchObject({ ok: true, name: { suffix: "xn--p1ai", unicode: "пример.рф" } });
  });
});
