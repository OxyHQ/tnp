import { describe, expect, test } from "bun:test";
import { parseUpstream } from "./upstream";
import { parseUpstreams } from "../proxy";

describe("parseUpstream", () => {
  test("a bare IPv4 address is classic DNS on port 53", () => {
    expect(parseUpstream("1.1.1.1")).toEqual({
      transport: "classic",
      address: "1.1.1.1",
      port: 53,
    });
  });

  test("an explicit port is honoured", () => {
    expect(parseUpstream("1.1.1.1:5353")).toEqual({
      transport: "classic",
      address: "1.1.1.1",
      port: 5353,
    });
  });

  test("a bracketed IPv6 address parses, with and without a port", () => {
    expect(parseUpstream("[2606:4700:4700::1111]")).toEqual({
      transport: "classic",
      address: "2606:4700:4700::1111",
      port: 53,
    });
    expect(parseUpstream("[2606:4700:4700::1111]:5353")).toEqual({
      transport: "classic",
      address: "2606:4700:4700::1111",
      port: 5353,
    });
  });

  test("a bare IPv6 address is not mistaken for host:port", () => {
    // The colons in an IPv6 literal must not be read as a port separator, or
    // the resolver silently talks to the wrong address on the wrong port.
    expect(parseUpstream("2606:4700:4700::1111")).toEqual({
      transport: "classic",
      address: "2606:4700:4700::1111",
      port: 53,
    });
  });

  test("an https URL is DoH", () => {
    expect(parseUpstream("https://cloudflare-dns.com/dns-query")).toEqual({
      transport: "doh",
      address: "https://cloudflare-dns.com/dns-query",
    });
  });

  test("surrounding whitespace is ignored", () => {
    expect(parseUpstream("  1.1.1.1  ").address).toBe("1.1.1.1");
  });
});

describe("parseUpstreams", () => {
  test("splits a comma-separated list, preserving failover order", () => {
    const list = parseUpstreams("1.1.1.1, 8.8.8.8, https://dns.example/dns-query");
    expect(list).toHaveLength(3);
    expect(list[0].address).toBe("1.1.1.1");
    expect(list[1].address).toBe("8.8.8.8");
    expect(list[2].transport).toBe("doh");
  });

  test("ignores empty entries", () => {
    expect(parseUpstreams("1.1.1.1,,  ,8.8.8.8")).toHaveLength(2);
  });

  test("refuses to start with no upstream rather than picking one silently", () => {
    // A resolver that quietly falls back to a built-in upstream is how every
    // TNP user's public DNS ended up at one hardcoded third party regardless of
    // configuration (audit B4).
    expect(() => parseUpstreams("")).toThrow(/No upstream DNS resolver configured/);
    expect(() => parseUpstreams("   ,  ")).toThrow(/No upstream DNS resolver configured/);
  });
});
