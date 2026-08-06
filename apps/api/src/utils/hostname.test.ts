import { describe, expect, test } from "bun:test";
import { escapeHtml, isValidHostname } from "./hostname.js";

describe("isValidHostname", () => {
  test("accepts ordinary hostnames", () => {
    expect(isValidHostname("nate.ox")).toBe(true);
    expect(isValidHostname("www.example.ox")).toBe(true);
    expect(isValidHostname("a-b.c-d.ox")).toBe(true);
    expect(isValidHostname("x1.ox")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isValidHostname("Nate.OX")).toBe(true);
  });

  test("rejects the injection payload that reaches this code path", () => {
    // Verified reachable: Express 5.2.1 returns the raw Host header from
    // req.hostname, and `.ox` is an active TNP TLD, so the parking branch is
    // entered and the value was interpolated into <title>, <h1> and an href.
    expect(isValidHostname("a.ox<script>alert(1)</script>")).toBe(false);
    expect(isValidHostname('a.ox"onload="alert(1)')).toBe(false);
    expect(isValidHostname("a.ox' onmouseover='x")).toBe(false);
  });

  test("rejects characters that are not legal in a DNS label", () => {
    expect(isValidHostname("a b.ox")).toBe(false);
    expect(isValidHostname("a/b.ox")).toBe(false);
    expect(isValidHostname("a\\b.ox")).toBe(false);
    expect(isValidHostname("a\nb.ox")).toBe(false);
    expect(isValidHostname("a_b.ox")).toBe(false);
    expect(isValidHostname("a:b.ox")).toBe(false);
    expect(isValidHostname("a%2e.ox")).toBe(false);
  });

  test("rejects malformed label boundaries", () => {
    expect(isValidHostname("")).toBe(false);
    expect(isValidHostname("ox")).toBe(false); // single label, no dot
    expect(isValidHostname(".ox")).toBe(false); // empty leading label
    expect(isValidHostname("a..ox")).toBe(false); // empty interior label
    expect(isValidHostname("a.ox.")).toBe(false); // trailing dot
    expect(isValidHostname("-a.ox")).toBe(false); // leading hyphen
    expect(isValidHostname("a-.ox")).toBe(false); // trailing hyphen
  });

  test("enforces the 63-character label limit", () => {
    expect(isValidHostname(`${"a".repeat(63)}.ox`)).toBe(true);
    expect(isValidHostname(`${"a".repeat(64)}.ox`)).toBe(false);
  });

  test("enforces the 253-character total limit independently of the label limit", () => {
    // Every label here is within the 63-character limit, so only the total
    // length distinguishes these two — otherwise the label rule would reject
    // the over-limit case and this test would pass without the total ever
    // being checked.
    const atLimit = ["a".repeat(63), "a".repeat(63), "a".repeat(63), "a".repeat(61)].join(".");
    const overLimit = ["a".repeat(63), "a".repeat(63), "a".repeat(63), "a".repeat(62)].join(".");

    expect(atLimit.length).toBe(253);
    expect(overLimit.length).toBe(254);

    expect(isValidHostname(atLimit)).toBe(true);
    expect(isValidHostname(overLimit)).toBe(false);
  });
});

describe("escapeHtml", () => {
  test("escapes every character that can break out of text or an attribute", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
    expect(escapeHtml('a"b')).toBe("a&quot;b");
    expect(escapeHtml("a'b")).toBe("a&#39;b");
    expect(escapeHtml("a&b")).toBe("a&amp;b");
  });

  test("escapes the ampersand first so an escape is not double-encoded into a payload", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  test("escapes every occurrence, not just the first", () => {
    expect(escapeHtml("<a><b>")).toBe("&lt;a&gt;&lt;b&gt;");
  });

  test("leaves an ordinary hostname untouched", () => {
    expect(escapeHtml("nate.ox")).toBe("nate.ox");
  });
});
