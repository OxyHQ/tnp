import { describe, expect, test } from "bun:test";
import {
  isValidIpv4,
  isValidIpv6,
  mergeDnsRecordUpdate,
  normalizeHostname,
  parseCreateDnsRecordRequest,
  parseUpdateDnsRecordRequest,
  type DnsRecordErrorCode,
  type DnsRecordInput,
} from "./dns-records.js";

function expectCode(result: { ok: boolean }, code: DnsRecordErrorCode): void {
  expect(result.ok).toBe(false);
  expect("code" in result ? result.code : "").toBe(code);
}

describe("isValidIpv4", () => {
  test("accepts strict dotted quads", () => {
    for (const ip of ["0.0.0.0", "192.0.2.1", "255.255.255.255", "10.0.0.10"]) {
      expect(isValidIpv4(ip)).toBe(true);
    }
  });

  test("rejects everything a loose parser lets through", () => {
    for (const ip of [
      "256.0.0.1",
      "1.2.3",
      "1.2.3.4.5",
      "01.2.3.4",
      "1.2.3.-4",
      " 1.2.3.4",
      "1.2.3.4 ",
      "1..3.4",
      "0x7f.0.0.1",
      "1e2.0.0.1",
      "example.ox",
      "",
    ]) {
      expect(isValidIpv4(ip)).toBe(false);
    }
  });
});

describe("isValidIpv6", () => {
  test("accepts every legal text form", () => {
    for (const ip of [
      "2001:db8:0:0:0:0:0:1",
      "2001:db8::1",
      "::1",
      "::",
      "1::",
      "fe80::",
      "1:2:3:4:5:6:7::",
      "::2:3:4:5:6:7:8",
      "1:2:3:4:5:6::8",
      "::ffff:192.0.2.1",
      "1:2:3:4:5:6:192.0.2.1",
      "2001:DB8::ABCD",
    ]) {
      expect(isValidIpv6(ip)).toBe(true);
    }
  });

  test("rejects malformed addresses", () => {
    for (const ip of [
      "",
      ":",
      ":::",
      "1:::2",
      "1::2::3",
      ":1::",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8::",
      "::1:2:3:4:5:6:7:8",
      "12345::",
      "g::1",
      "192.0.2.1",
      "::192.0.2.1:1",
      "1:2:3:4:5:6:7:192.0.2.1",
      "::ffff:256.0.0.1",
      "fe80::1%eth0",
      " ::1",
    ]) {
      expect(isValidIpv6(ip)).toBe(false);
    }
  });
});

describe("normalizeHostname", () => {
  test("lowercases and drops one trailing root dot", () => {
    expect(normalizeHostname("Mail.Example.OX.")).toBe("mail.example.ox");
    expect(normalizeHostname("host")).toBe("host");
  });

  test("enforces label and total length and LDH syntax", () => {
    expect(normalizeHostname(`${"a".repeat(63)}.ox`)).toBe(`${"a".repeat(63)}.ox`);
    expect(normalizeHostname(`${"a".repeat(64)}.ox`)).toBeNull();
    const long = Array.from({ length: 64 }, () => "abc").join(".");
    expect(long.length).toBeGreaterThan(253);
    expect(normalizeHostname(long)).toBeNull();
    expect(normalizeHostname("1password.ox")).toBe("1password.ox");
    for (const bad of ["", ".", "a..b", "-a.ox", "a-.ox", "a_b.ox", "a b.ox", "a.ox..", "http://a.ox", "192.0.2.1", "42"]) {
      expect(normalizeHostname(bad)).toBeNull();
    }
  });
});

describe("parseCreateDnsRecordRequest", () => {
  test("accepts one well-formed record of every type, normalized", () => {
    expect(parseCreateDnsRecordRequest({ type: "A", name: "@", value: "192.0.2.1" })).toEqual({
      ok: true,
      value: { type: "A", name: "@", value: "192.0.2.1", ttl: 3600 },
    });
    expect(parseCreateDnsRecordRequest({ type: "aaaa", name: "WWW", value: "2001:DB8::1", ttl: 60 })).toEqual({
      ok: true,
      value: { type: "AAAA", name: "www", value: "2001:db8::1", ttl: 60 },
    });
    expect(parseCreateDnsRecordRequest({ type: "CNAME", name: "blog", value: "Host.Example.OX." })).toEqual({
      ok: true,
      value: { type: "CNAME", name: "blog", value: "host.example.ox", ttl: 3600 },
    });
    expect(parseCreateDnsRecordRequest({ type: "NS", name: "sub", value: "ns1.example.ox", ttl: 86400 })).toEqual({
      ok: true,
      value: { type: "NS", name: "sub", value: "ns1.example.ox", ttl: 86400 },
    });
    expect(parseCreateDnsRecordRequest({ type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none" })).toEqual({
      ok: true,
      value: { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none", ttl: 3600 },
    });
  });

  test("MX takes a structured priority and stores the resolver's form", () => {
    expect(parseCreateDnsRecordRequest({ type: "MX", name: "@", value: "Mail.Example.OX", priority: 10 })).toEqual({
      ok: true,
      value: { type: "MX", name: "@", value: "10 mail.example.ox", ttl: 3600 },
    });
    expect(parseCreateDnsRecordRequest({ type: "MX", name: "@", value: "0 mail.example.ox" })).toEqual({
      ok: true,
      value: { type: "MX", name: "@", value: "0 mail.example.ox", ttl: 3600 },
    });
  });

  test("MX without a priority, or with one out of range, is refused", () => {
    expectCode(parseCreateDnsRecordRequest({ type: "MX", name: "@", value: "mail.example.ox" }), "priority_invalid");
    expectCode(
      parseCreateDnsRecordRequest({ type: "MX", name: "@", value: "mail.example.ox", priority: 65536 }),
      "priority_invalid",
    );
    expectCode(
      parseCreateDnsRecordRequest({ type: "MX", name: "@", value: "mail.example.ox", priority: 1.5 }),
      "priority_invalid",
    );
    expectCode(parseCreateDnsRecordRequest({ type: "MX", name: "@", value: "70000 mail.example.ox" }), "priority_invalid");
    expectCode(parseCreateDnsRecordRequest({ type: "MX", name: "@", value: "10 not a host" }), "priority_invalid");
    expectCode(parseCreateDnsRecordRequest({ type: "MX", name: "@", value: "10 bad_host" }), "hostname_invalid");
  });

  test("TTL defaults only when absent; out of range is an error, not a silent replacement", () => {
    for (const absent of [undefined, null]) {
      const parsed = parseCreateDnsRecordRequest({ type: "A", name: "@", value: "192.0.2.1", ttl: absent });
      expect(parsed.ok && parsed.value.ttl).toBe(3600);
    }
    for (const ttl of [0, 59, 86401, -1, 3600.5, "3600", Number.NaN]) {
      expectCode(parseCreateDnsRecordRequest({ type: "A", name: "@", value: "192.0.2.1", ttl }), "ttl_invalid");
    }
  });

  test("names: @ or relative labels, lowercased; wildcards refused because the resolver cannot answer them", () => {
    const named = parseCreateDnsRecordRequest({ type: "A", name: "A.B", value: "192.0.2.1" });
    expect(named.ok && named.value.name).toBe("a.b");
    expectCode(parseCreateDnsRecordRequest({ type: "A", name: "*", value: "192.0.2.1" }), "name_wildcard");
    expectCode(parseCreateDnsRecordRequest({ type: "A", name: "*.www", value: "192.0.2.1" }), "name_wildcard");
    for (const name of ["-a", "a..b", "www.", "a b", "a/b", `${"a".repeat(64)}`, "__a", "a_"]) {
      expectCode(parseCreateDnsRecordRequest({ type: "A", name, value: "192.0.2.1" }), "name_invalid");
    }
    for (const name of ["", "  ", undefined, 3]) {
      expectCode(parseCreateDnsRecordRequest({ type: "A", name, value: "192.0.2.1" }), "name_required");
    }
  });

  test("each type refuses a value of another type's shape", () => {
    expectCode(parseCreateDnsRecordRequest({ type: "A", name: "@", value: "2001:db8::1" }), "ipv4_invalid");
    expectCode(parseCreateDnsRecordRequest({ type: "AAAA", name: "@", value: "192.0.2.1" }), "ipv6_invalid");
    expectCode(parseCreateDnsRecordRequest({ type: "CNAME", name: "www", value: "192.0.2.1 x" }), "hostname_invalid");
    expectCode(parseCreateDnsRecordRequest({ type: "NS", name: "sub", value: "ns_1.example.ox" }), "hostname_invalid");
  });

  test("TXT is bounded and free of control characters", () => {
    const ok = parseCreateDnsRecordRequest({ type: "TXT", name: "@", value: "x".repeat(2048) });
    expect(ok.ok).toBe(true);
    expectCode(parseCreateDnsRecordRequest({ type: "TXT", name: "@", value: "x".repeat(2049) }), "txt_too_long");
    for (const code of [0, 9, 10, 27, 0x7f]) {
      const value = `a${String.fromCharCode(code)}b`;
      expect(value.length).toBe(3);
      expectCode(parseCreateDnsRecordRequest({ type: "TXT", name: "@", value }), "txt_invalid_chars");
    }
  });

  test("type, value and body shape", () => {
    expectCode(parseCreateDnsRecordRequest({ type: "SRV", name: "@", value: "x" }), "type_invalid");
    expectCode(parseCreateDnsRecordRequest({ name: "@", value: "x" }), "type_invalid");
    expectCode(parseCreateDnsRecordRequest({ type: "A", name: "@", value: "" }), "value_required");
    expectCode(parseCreateDnsRecordRequest({ type: "A", name: "@", value: 192 }), "value_required");
    expectCode(parseCreateDnsRecordRequest(["A"]), "body_invalid");
    expectCode(parseCreateDnsRecordRequest(null), "body_invalid");
  });

  test("names the field each error belongs to", () => {
    const parsed = parseCreateDnsRecordRequest({ type: "A", name: "@", value: "nope" });
    expect(parsed.ok ? "" : parsed.field).toBe("value");
  });
});

describe("parseUpdateDnsRecordRequest", () => {
  test("validates only the fields present", () => {
    expect(parseUpdateDnsRecordRequest({ ttl: 120 })).toEqual({ ok: true, value: { ttl: 120 } });
    expect(parseUpdateDnsRecordRequest({})).toEqual({ ok: true, value: {} });
    expectCode(parseUpdateDnsRecordRequest({ ttl: 5 }), "ttl_invalid");
    expectCode(parseUpdateDnsRecordRequest({ ttl: null }), "ttl_invalid");
    expectCode(parseUpdateDnsRecordRequest({ type: "SRV" }), "type_invalid");
    expectCode(parseUpdateDnsRecordRequest({ name: "*" }), "name_wildcard");
    expectCode(parseUpdateDnsRecordRequest({ value: "" }), "value_required");
  });
});

describe("mergeDnsRecordUpdate", () => {
  const a: DnsRecordInput = { type: "A", name: "@", value: "192.0.2.1", ttl: 3600 };
  const mx: DnsRecordInput = { type: "MX", name: "@", value: "10 mail.example.ox", ttl: 3600 };

  test("validates the resulting record, not the patch alone", () => {
    // The patch is a valid type on its own; the record it produces is not.
    expectCode(mergeDnsRecordUpdate(a, { type: "CNAME" }), "hostname_invalid");
    expect(mergeDnsRecordUpdate(a, { type: "CNAME", value: "host.example.ox" })).toEqual({
      ok: true,
      value: { type: "CNAME", name: "@", value: "host.example.ox", ttl: 3600 },
    });
    expect(mergeDnsRecordUpdate(a, { ttl: 300 })).toEqual({ ok: true, value: { ...a, ttl: 300 } });
  });

  test("MX keeps the half of its value the update does not send", () => {
    expect(mergeDnsRecordUpdate(mx, { priority: 20 })).toEqual({
      ok: true,
      value: { ...mx, value: "20 mail.example.ox" },
    });
    expect(mergeDnsRecordUpdate(mx, { value: "mx2.example.ox" })).toEqual({
      ok: true,
      value: { ...mx, value: "10 mx2.example.ox" },
    });
    expect(mergeDnsRecordUpdate(mx, { value: "5 mx3.example.ox" })).toEqual({
      ok: true,
      value: { ...mx, value: "5 mx3.example.ox" },
    });
  });

  test("a legacy record that was never valid cannot be carried through an unrelated edit", () => {
    const legacy: DnsRecordInput = { type: "MX", name: "@", value: "mail.example.ox", ttl: 3600 };
    expectCode(mergeDnsRecordUpdate(legacy, { ttl: 300 }), "priority_invalid");
    expectCode(mergeDnsRecordUpdate({ ...a, value: "not-an-ip" }, { ttl: 300 }), "ipv4_invalid");
  });

  test("changing an A record to MX needs a priority", () => {
    expectCode(mergeDnsRecordUpdate(a, { type: "MX", value: "mail.example.ox" }), "priority_invalid");
    expect(mergeDnsRecordUpdate(a, { type: "MX", value: "mail.example.ox", priority: 1 }).ok).toBe(true);
  });
});
