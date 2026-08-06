import { beforeEach, describe, expect, test } from "bun:test";
import type { TnpConfig } from "./config";
import { DnsProxy } from "./proxy";

function makeConfig(): TnpConfig {
  return {
    listenAddr: "127.0.0.1",
    listenPort: 5354,
    apiBaseUrl: "https://api.example.test",
    upstreamDns: "1.1.1.1",
    cacheMaxEntries: 10_000,
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

describe("DnsProxy.classify", () => {
  let proxy: DnsProxy;

  beforeEach(() => {
    proxy = new DnsProxy(makeConfig());
  });

  test("a name under a native TLD belongs to TNP", () => {
    proxy.setTlds(["ox"]);
    expect(proxy.classify("hello.ox")).toBe("tnp-native");
    expect(proxy.classify("a.b.c.ox")).toBe("tnp-native");
  });

  test("normalizes case and the trailing root dot", () => {
    proxy.setTlds(["ox"]);
    expect(proxy.classify("HELLO.OX")).toBe("tnp-native");
    expect(proxy.classify("hello.ox.")).toBe("tnp-native");
  });

  test("an unknown TLD is public", () => {
    proxy.setTlds(["ox"]);
    expect(proxy.classify("example.xyz")).toBe("public-dns");
  });

  test("a single-label name is public", () => {
    proxy.setTlds(["ox"]);
    expect(proxy.classify("localhost")).toBe("public-dns");
  });

  test("classification ignores registration state", () => {
    proxy.setTlds(["ox"]);
    expect(proxy.classify("never-registered-anywhere.ox")).toBe("tnp-native");
  });

  test("setTlds replaces the previous table rather than merging", () => {
    proxy.setTlds(["ox"]);
    expect(proxy.classify("hello.ox")).toBe("tnp-native");
    proxy.setTlds(["zzt"]);
    expect(proxy.classify("hello.ox")).toBe("public-dns");
    expect(proxy.classify("hello.zzt")).toBe("tnp-native");
  });
});

describe("DnsProxy namespace policy", () => {
  let proxy: DnsProxy;

  beforeEach(() => {
    proxy = new DnsProxy(makeConfig());
  });

  test("refuses reserved TLDs the API offers, in either wire form", () => {
    // The live collision (audit S4): a database seeded before the namespace
    // policy still holds `.com` and `.app` rows. Even if a stale or hostile API
    // publishes them, the client must not shadow public names on its say-so.
    proxy.setTlds([
      "ox",
      "com",
      { name: "app", custom: false },
      { name: "net", custom: true },
    ]);

    expect(proxy.classify("google.com")).toBe("public-dns");
    expect(proxy.classify("example.app")).toBe("public-dns");
    expect(proxy.classify("example.net")).toBe("public-dns");
    expect(proxy.classify("example.ox")).toBe("tnp-native");
  });

  test("a custom:true flag does not make a reserved TLD TNP-native", () => {
    // `custom` was the old gate and is not a namespace authority — the reserved
    // set is. Marking `.com` custom must not re-enable shadowing.
    proxy.setTlds([{ name: "com", custom: true }]);
    expect(proxy.classify("google.com")).toBe("public-dns");
  });

  test("refuses IETF special-use names", () => {
    proxy.setTlds(["localhost", "onion", "test", "internal", "ox"]);
    expect(proxy.classify("foo.localhost")).toBe("public-dns");
    expect(proxy.classify("foo.onion")).toBe("public-dns");
    expect(proxy.classify("foo.test")).toBe("public-dns");
    expect(proxy.classify("foo.internal")).toBe("public-dns");
    expect(proxy.classify("foo.ox")).toBe("tnp-native");
  });

  test("an all-reserved table leaves the client resolving nothing as TNP", () => {
    proxy.setTlds(["com", "app", "net", "org", "dev"]);
    for (const name of ["a.com", "a.app", "a.net", "a.org", "a.dev"]) {
      expect(proxy.classify(name)).toBe("public-dns");
    }
  });
});

describe("DnsProxy.getOverlayInfo", () => {
  test("returns undefined for a domain with no cached overlay", () => {
    const proxy = new DnsProxy(makeConfig());
    expect(proxy.getOverlayInfo("unknown.ox")).toBeUndefined();
  });
});
