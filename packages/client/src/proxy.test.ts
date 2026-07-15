import { beforeEach, describe, expect, test } from "bun:test";
import type { TnpConfig } from "./config";
import { DnsProxy } from "./proxy";

function makeConfig(): TnpConfig {
  return {
    listenAddr: "127.0.0.1",
    listenPort: 5354,
    apiBaseUrl: "https://api.example.test",
    upstreamDns: "1.1.1.1",
    cacheTtlSeconds: 300,
    privacyLevel: "access",
    socksPort: 1080,
    relayPreference: "oxy",
    identityKeyPath: "/tmp/tnp-test-identity.key",
    relayPort: 8080,
    relayLocation: "",
    relayMaxConnections: 100,
    relayAuthToken: "",
    autoConnect: false,
    killSwitch: false,
    publicDnsIp: "",
  };
}

describe("DnsProxy.isCustomTld", () => {
  let proxy: DnsProxy;

  beforeEach(() => {
    proxy = new DnsProxy(makeConfig());
  });

  test("treats string-form TLDs as custom by default", () => {
    proxy.setTlds(["ox"]);
    expect(proxy.isCustomTld("hello.ox")).toBe(true);
  });

  test("respects an explicit custom:false object TLD (standard TLD)", () => {
    proxy.setTlds([{ name: "com", custom: false }]);
    expect(proxy.isCustomTld("example.com")).toBe(false);
  });

  test("defaults object TLDs without a custom flag to custom", () => {
    proxy.setTlds([{ name: "app" }]);
    expect(proxy.isCustomTld("my.app")).toBe(true);
  });

  test("returns false for a TLD that was never registered", () => {
    proxy.setTlds(["ox"]);
    expect(proxy.isCustomTld("example.xyz")).toBe(false);
  });

  test("returns false for a single-label name with no TLD", () => {
    proxy.setTlds(["ox"]);
    expect(proxy.isCustomTld("localhost")).toBe(false);
  });

  test("ignores a trailing dot (FQDN root)", () => {
    proxy.setTlds(["ox"]);
    expect(proxy.isCustomTld("hello.ox.")).toBe(true);
  });

  test("matches case-insensitively", () => {
    proxy.setTlds(["ox"]);
    expect(proxy.isCustomTld("HELLO.OX")).toBe(true);
  });

  test("matches on the final label for a multi-level subdomain", () => {
    proxy.setTlds(["ox"]);
    expect(proxy.isCustomTld("a.b.c.ox")).toBe(true);
  });

  test("distinguishes custom from standard when both are registered", () => {
    proxy.setTlds([{ name: "ox", custom: true }, { name: "com", custom: false }]);
    expect(proxy.isCustomTld("site.ox")).toBe(true);
    expect(proxy.isCustomTld("site.com")).toBe(false);
  });

  test("setTlds replaces the previous set rather than merging", () => {
    proxy.setTlds(["ox"]);
    expect(proxy.isCustomTld("hello.ox")).toBe(true);
    proxy.setTlds(["app"]);
    expect(proxy.isCustomTld("hello.ox")).toBe(false);
    expect(proxy.isCustomTld("hello.app")).toBe(true);
  });
});

describe("DnsProxy.getOverlayInfo", () => {
  test("returns undefined for a domain with no cached overlay", () => {
    const proxy = new DnsProxy(makeConfig());
    expect(proxy.getOverlayInfo("unknown.ox")).toBeUndefined();
  });
});
