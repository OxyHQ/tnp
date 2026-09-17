import { describe, expect, test } from "bun:test";
import { isPublicIPv4 } from "./config.js";
import { namecheapFactory } from "./factory.js";
import { FAKE_API_KEY, createHarness, errorStrings, fakeAccount, providerError } from "./testHarness.js";

describe("ClientIp validation", () => {
  test("accepts public IPv4 literals", () => {
    for (const ip of ["44.0.0.1", "1.1.1.1", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "223.255.255.254"]) {
      expect({ ip, ok: isPublicIPv4(ip) }).toEqual({ ip, ok: true });
    }
  });

  test("rejects private, loopback, link-local, CGNAT, documentation, multicast and malformed values", () => {
    for (const ip of [
      "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.109", // private (the docs' own example IP)
      "127.0.0.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0",
      "192.0.2.1", "198.51.100.7", "203.0.113.9", "198.18.0.1", "224.0.0.1", "255.255.255.255",
      "::1", "2001:db8::1", "1.2.3", "1.2.3.4.5", "01.2.3.4", "1.2.3.256", " 1.2.3.4", "1.2.3.4 ", "0x01.2.3.4", "",
    ]) {
      expect({ ip, ok: isPublicIPv4(ip) }).toEqual({ ip, ok: false });
    }
  });
});

describe("namecheapFactory", () => {
  test("is named for the adapter and builds both families", () => {
    const h = createHarness();
    expect(namecheapFactory.adapter).toBe("namecheap");
    const registrar = namecheapFactory.createRegistrar?.(fakeAccount(), h.deps);
    const dns = namecheapFactory.createDns?.(fakeAccount(), h.deps);
    expect(registrar?.account.environment).toBe("sandbox");
    expect(dns?.supportedRecordTypes).toContain("MX");
  });

  test("refuses bad configuration with a credentials error and no request", async () => {
    const cases = [
      fakeAccount("sandbox", { clientIp: "10.0.0.5" }),
      fakeAccount("sandbox", { clientIp: undefined }),
      fakeAccount("sandbox", { apiUser: "" }),
      fakeAccount("sandbox", { apiUser: "a".repeat(21) }),
      fakeAccount("sandbox", { userName: 42 }),
      fakeAccount("sandbox", {}, null),
      fakeAccount("sandbox", {}, "env:UNSET_FIXTURE_KEY"),
      { ...fakeAccount(), ref: { ...fakeAccount().ref, adapter: "other" } },
    ];
    for (const account of cases) {
      const h = createHarness();
      for (const build of [namecheapFactory.createRegistrar, namecheapFactory.createDns]) {
        const err = await providerError(async () => build?.(account, h.deps));
        expect(err.code).toBe("credentials");
        expect(errorStrings(err)).not.toContain(FAKE_API_KEY);
      }
      expect(h.requests).toHaveLength(0);
    }
  });
});
