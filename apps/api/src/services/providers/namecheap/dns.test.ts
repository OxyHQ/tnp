import { describe, expect, test } from "bun:test";
import type { Zone } from "../contracts.js";
import { NAMECHEAP_DNS_CAPABILITIES } from "./capabilities.js";
import { createNamecheapDns } from "./factory.js";
import { createHarness, errorXml, fakeAccount, fixture, providerError, publicName } from "./testHarness.js";

function setup() {
  const h = createHarness();
  return { h, dns: createNamecheapDns(fakeAccount(), h.deps) };
}

const held = publicName("held-fixture", "com");

/** The records in `hosts-get.xml`, as a caller should see them. */
const FIXTURE_RECORDS = [
  { host: "@", type: "A", value: "192.0.2.10", ttl: 1800, priority: null },
  { host: "www", type: "CNAME", value: "held-fixture.com.", ttl: 60, priority: null },
  { host: "@", type: "MX", value: "mx1.mail.example.invalid.", ttl: 3600, priority: 5 },
  { host: "@", type: "MX", value: "mx2.mail.example.invalid.", ttl: 3600, priority: 20 },
  { host: "_dmarc", type: "TXT", value: 'v=DMARC1; p=none; rua=mailto:"dmarc"@example.invalid &lt;tag&gt;', ttl: 1800, priority: null },
];

describe("readZone (domains.dns.getHosts)", () => {
  test("records, MX preferences, decoded TXT, EmailType and DNS authority", async () => {
    const { h, dns } = setup();
    h.respond(fixture("hosts-get.xml"));
    const zone = await dns.readZone(h.ctx(), held);
    expect([h.requests[0].body.get("SLD"), h.requests[0].body.get("TLD")]).toEqual(["held-fixture", "com"]);
    expect(zone).toEqual({ records: FIXTURE_RECORDS, settings: { EmailType: "MX" }, servedByProvider: true });
  });

  test("a multi-label suffix is sent as the TLD", async () => {
    const { h, dns } = setup();
    h.respond(fixture("hosts-get.xml"));
    await dns.readZone(h.ctx(), publicName("held-fixture", "co.uk"));
    expect([h.requests[0].body.get("SLD"), h.requests[0].body.get("TLD")]).toEqual(["held-fixture", "co.uk"]);
  });

  test("a domain not on Namecheap DNS reports servedByProvider false", async () => {
    const { h, dns } = setup();
    h.respond(fixture("hosts-get-not-ours.xml"));
    expect((await dns.readZone(h.ctx(), held)).servedByProvider).toBe(false);
  });

  test("the documented 'not using proper DNS servers' error is unsupported", async () => {
    const { h, dns } = setup();
    h.respond(errorXml("2030288", "Cannot complete this command as this domain is not using proper DNS servers"));
    const err = await providerError(() => dns.readZone(h.ctx(), held));
    expect(err.code).toBe("unsupported");
  });
});

describe("replaceZone (domains.dns.setHosts)", () => {
  const zone: Zone = { records: FIXTURE_RECORDS, settings: { EmailType: "MX" }, servedByProvider: true };

  test("sends the complete record set, numbered, with MXPref only on MX, plus EmailType", async () => {
    const { h, dns } = setup();
    h.respond(fixture("hosts-set-ok.xml"));
    await dns.replaceZone(h.ctx(), held, zone);
    const body = h.requests[0].body;
    expect(body.get("Command")).toBe("namecheap.domains.dns.setHosts");
    expect([body.get("SLD"), body.get("TLD"), body.get("EmailType")]).toEqual(["held-fixture", "com", "MX"]);

    const sent = [];
    for (let n = 1; body.has(`HostName${n}`); n++) {
      sent.push({
        host: body.get(`HostName${n}`),
        type: body.get(`RecordType${n}`),
        value: body.get(`Address${n}`),
        ttl: Number(body.get(`TTL${n}`)),
        priority: body.has(`MXPref${n}`) ? Number(body.get(`MXPref${n}`)) : null,
      });
    }
    expect(sent).toEqual(FIXTURE_RECORDS);
    // Nothing beyond the records and the documented zone fields.
    const keys = [...body.keys()].filter((k) => !/^(HostName|RecordType|Address|TTL|MXPref)\d+$/.test(k));
    expect(keys.sort()).toEqual(["ApiKey", "ApiUser", "ClientIp", "Command", "EmailType", "SLD", "TLD", "UserName"]);
  });

  test("a zone read back and replaced unchanged round-trips byte for byte", async () => {
    const { h, dns } = setup();
    h.respond(fixture("hosts-get.xml"), fixture("hosts-set-ok.xml"));
    const read = await dns.readZone(h.ctx(), held);
    await dns.replaceZone(h.ctx(), held, read);
    const body = h.requests[1].body;
    expect(body.get("Address5")).toBe('v=DMARC1; p=none; rua=mailto:"dmarc"@example.invalid &lt;tag&gt;');
    expect(body.get("MXPref3")).toBe("5");
    expect(body.get("MXPref4")).toBe("20");
    expect(body.has("MXPref1")).toBe(false);
  });

  test("refuses, without sending, anything it cannot write faithfully", async () => {
    const cases: Array<[string, Zone]> = [
      ["not served", { ...zone, servedByProvider: false }],
      ["unsupported type", { ...zone, records: [...zone.records, { host: "@", type: "CAA", value: '0 issue "ca.example.invalid"', ttl: 1800, priority: null }] }],
      ["NS type", { ...zone, records: [...zone.records, { host: "sub", type: "NS", value: "ns.example.invalid.", ttl: 1800, priority: null }] }],
      ["missing EmailType", { ...zone, settings: {} }],
      ["unknown setting", { ...zone, settings: { EmailType: "MX", DnssecEnabled: "true" } }],
      ["empty zone", { ...zone, records: [] }],
      ["TTL too low", { ...zone, records: [{ ...zone.records[0], ttl: 59 }] }],
      ["TTL too high", { ...zone, records: [{ ...zone.records[0], ttl: 60001 }] }],
      ["MX without priority", { ...zone, records: [{ ...zone.records[2], priority: null }] }],
      ["priority on A", { ...zone, records: [{ ...zone.records[0], priority: 10 }] }],
      ["newline in value", { ...zone, records: [{ ...zone.records[4], value: "a\nb" }] }],
      ["empty host", { ...zone, records: [{ ...zone.records[0], host: "" }] }],
    ];
    for (const [label, bad] of cases) {
      const { h, dns } = setup();
      h.respond(fixture("hosts-set-ok.xml"));
      let submitted = false;
      const err = await providerError(() =>
        dns.replaceZone(h.ctx({ beforeSubmit: async () => { submitted = true; } }), held, bad),
      );
      expect({ label, code: err.code }).toEqual({ label, code: label === "not served" ? "unsupported" : "validation" });
      expect({ label, requests: h.requests.length, submitted }).toEqual({ label, requests: 0, submitted: false });
    }
  });

  test("IsSuccess other than true is unknown_outcome", async () => {
    const { h, dns } = setup();
    h.respond(fixture("hosts-set-ok.xml").replace('IsSuccess="true"', 'IsSuccess="false"'));
    const err = await providerError(() => dns.replaceZone(h.ctx(), held, zone));
    expect(err.code).toBe("unknown_outcome");
  });

  test("too many records is a refusal, not an unknown outcome", async () => {
    const { h, dns } = setup();
    h.respond(errorXml("4013288", "Too many records"));
    const err = await providerError(() => dns.replaceZone(h.ctx(), held, zone));
    expect(err.code).toBe("validation");
  });

  test("capabilities declare no validation and document the missing compare-and-swap", () => {
    expect(NAMECHEAP_DNS_CAPABILITIES["zone.replace"].validatedAt).toBeNull();
    expect(NAMECHEAP_DNS_CAPABILITIES["zone.read"].validatedIn).toBeNull();
    expect(NAMECHEAP_DNS_CAPABILITIES["zone.replace"].conditions).toContain("compare-and-swap");
  });
});
