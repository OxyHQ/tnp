import { describe, expect, test } from "bun:test";
import {
  decideParkingPage,
  decideResolution,
  PARKING_TTL_SECONDS,
  type NameFacts,
  type ResolutionSettings,
  type ServiceNodeFacts,
} from "./resolve.js";

const NOW = new Date("2026-09-17T12:00:00.000Z");
const PARKING = "203.0.113.10";
const DAY = 24 * 60 * 60 * 1000;

const settings: ResolutionSettings = { parkingIp: PARKING, expiryEnforced: false, now: NOW };
const noParking: ResolutionSettings = { ...settings, parkingIp: "" };
const enforced: ResolutionSettings = { ...settings, expiryEnforced: true };

type Registered = NonNullable<Extract<NameFacts, { kind: "native" }>["domain"]>;

function registered(overrides: Partial<Registered> = {}, fqdn = "nate.ox"): NameFacts {
  return {
    kind: "native",
    fqdn,
    tldCustom: true,
    domain: {
      expiresAt: null,
      label: "@",
      records: [],
      hasDescendants: false,
      node: null,
      ...overrides,
    },
  };
}

const unregistered: NameFacts = { kind: "native", fqdn: "free.ox", tldCustom: true, domain: null };

function node(overrides: Partial<ServiceNodeFacts> = {}): ServiceNodeFacts {
  return {
    publicKey: "cHVibGljLWtleQ==",
    connectedRelay: "wss://relay.example.test",
    status: "online",
    lastSeen: new Date(NOW.getTime() - 10_000),
    ...overrides,
  };
}

const parkingAnswer = (name: string) => [
  { name, type: "A", value: PARKING, ttl: PARKING_TTL_SECONDS },
];

describe("names TNP does not answer for", () => {
  test("are NXDOMAIN with no answers", () => {
    expect(decideResolution({ kind: "not-native", fqdn: "google.com" }, "A", settings)).toEqual({
      name: "google.com",
      type: "A",
      answers: [],
      rcode: "NXDOMAIN",
    });
  });
});

describe("unregistered native names", () => {
  test("are synthesized to the parking address for A and ANY", () => {
    for (const qtype of ["A", "ANY"]) {
      expect(decideResolution(unregistered, qtype, settings)).toEqual({
        name: "free.ox",
        type: qtype,
        answers: parkingAnswer("free.ox"),
        rcode: "NOERROR",
      });
    }
  });

  test("are NODATA for other types, because parking makes the name exist", () => {
    expect(decideResolution(unregistered, "AAAA", settings)).toMatchObject({
      answers: [],
      rcode: "NOERROR",
    });
  });

  test("are NXDOMAIN when no parking address is configured", () => {
    expect(decideResolution(unregistered, "A", noParking)).toMatchObject({
      answers: [],
      rcode: "NXDOMAIN",
    });
  });
});

describe("registered names", () => {
  test("answer records of the queried type", () => {
    const facts = registered({
      records: [
        { type: "A", value: "192.0.2.1", ttl: 60 },
        { type: "TXT", value: "hello", ttl: 60 },
      ],
    });
    expect(decideResolution(facts, "A", settings)).toEqual({
      name: "nate.ox",
      type: "A",
      answers: [{ name: "nate.ox", type: "A", value: "192.0.2.1", ttl: 60 }],
      rcode: "NOERROR",
    });
  });

  test("an A query on a name with only a CNAME gets the CNAME, never parking", () => {
    const facts = registered({ label: "www", records: [{ type: "CNAME", value: "host.example.ox", ttl: 300 }] }, "www.nate.ox");
    for (const qtype of ["A", "AAAA", "MX", "TXT"]) {
      expect(decideResolution(facts, qtype, settings)).toEqual({
        name: "www.nate.ox",
        type: qtype,
        answers: [{ name: "www.nate.ox", type: "CNAME", value: "host.example.ox", ttl: 300 }],
        rcode: "NOERROR",
      });
    }
  });

  test("a name with records of other types is NODATA, not parking and not NXDOMAIN", () => {
    const facts = registered({ records: [{ type: "TXT", value: "v=spf1 -all", ttl: 60 }] });
    expect(decideResolution(facts, "A", settings)).toEqual({
      name: "nate.ox",
      type: "A",
      answers: [],
      rcode: "NOERROR",
    });
  });

  test("a label with nothing at all is parked for A when parking is configured", () => {
    const facts = registered({ label: "empty" }, "empty.nate.ox");
    expect(decideResolution(facts, "A", settings)).toMatchObject({
      answers: parkingAnswer("empty.nate.ox"),
      rcode: "NOERROR",
    });
  });

  test("without parking: the registered name itself is NODATA, an unknown label NXDOMAIN", () => {
    expect(decideResolution(registered(), "A", noParking)).toMatchObject({ answers: [], rcode: "NOERROR" });
    expect(decideResolution(registered({ label: "nope" }, "nope.nate.ox"), "A", noParking)).toMatchObject({
      answers: [],
      rcode: "NXDOMAIN",
    });
  });

  test("an empty non-terminal exists", () => {
    const facts = registered({ label: "b", hasDescendants: true }, "b.nate.ox");
    expect(decideResolution(facts, "A", noParking)).toMatchObject({ answers: [], rcode: "NOERROR" });
  });

  test("ANY returns every record at the name", () => {
    const facts = registered({
      records: [
        { type: "A", value: "192.0.2.1", ttl: 60 },
        { type: "AAAA", value: "2001:db8::1", ttl: 60 },
      ],
    });
    expect(decideResolution(facts, "ANY", settings).answers).toHaveLength(2);
  });
});

describe("service nodes", () => {
  test("an online node with a fresh heartbeat attaches the overlay and suppresses parking", () => {
    expect(decideResolution(registered({ node: node() }), "A", settings)).toEqual({
      name: "nate.ox",
      type: "A",
      answers: [],
      rcode: "NOERROR",
      overlay: {
        serviceNodePubKey: "cHVibGljLWtleQ==",
        relay: "wss://relay.example.test",
        available: true,
      },
    });
  });

  test("a node marked offline counts for nothing: the name parks", () => {
    const response = decideResolution(registered({ node: node({ status: "offline" }) }), "A", settings);
    expect(response.overlay).toBeUndefined();
    expect(response.answers).toEqual(parkingAnswer("nate.ox"));
  });

  test("an 'online' node whose heartbeat is stale counts for nothing either", () => {
    const stale = node({ lastSeen: new Date(NOW.getTime() - 91_000) });
    const response = decideResolution(registered({ node: stale }), "A", settings);
    expect(response.overlay).toBeUndefined();
    expect(response.answers).toEqual(parkingAnswer("nate.ox"));

    const fresh = node({ lastSeen: new Date(NOW.getTime() - 90_000) });
    expect(decideResolution(registered({ node: fresh }), "A", settings).overlay).toBeDefined();
  });

  test("records are still answered alongside an online node", () => {
    const facts = registered({ node: node(), records: [{ type: "A", value: "192.0.2.1", ttl: 60 }] });
    const response = decideResolution(facts, "A", settings);
    expect(response.answers).toHaveLength(1);
    expect(response.overlay).toBeDefined();
  });
});

describe("expiry", () => {
  const lapsed = registered({
    expiresAt: new Date(NOW.getTime() - 31 * DAY),
    records: [{ type: "A", value: "192.0.2.1", ttl: 60 }],
    node: node(),
  });
  const inGrace = registered({
    expiresAt: new Date(NOW.getTime() - 29 * DAY),
    records: [{ type: "A", value: "192.0.2.1", ttl: 60 }],
  });

  test("is not enforced by default: an expired name still resolves", () => {
    expect(decideResolution(lapsed, "A", settings).answers[0]?.value).toBe("192.0.2.1");
    expect(decideParkingPage(lapsed, { ...settings })).toBeNull();
  });

  test("when enforced, an expired name is withheld: no records, no overlay, parking only", () => {
    const response = decideResolution(lapsed, "A", enforced);
    expect(response.answers).toEqual(parkingAnswer("nate.ox"));
    expect(response.overlay).toBeUndefined();
    expect(decideParkingPage(lapsed, enforced)).toBe("held");
  });

  test("when enforced, grace still resolves", () => {
    expect(decideResolution(inGrace, "A", enforced).answers[0]?.value).toBe("192.0.2.1");
  });
});

describe("decideParkingPage", () => {
  test("mirrors resolution", () => {
    expect(decideParkingPage({ kind: "not-native", fqdn: "google.com" }, settings)).toBeNull();
    expect(decideParkingPage(unregistered, settings)).toBe("available");
    expect(decideParkingPage(registered(), settings)).toBe("registered");
    expect(decideParkingPage(registered({ node: node() }), settings)).toBeNull();
    expect(decideParkingPage(registered({ node: node({ status: "offline" }) }), settings)).toBe("registered");
  });

  test("a held name is never offered as available", () => {
    const held = registered({ expiresAt: new Date(NOW.getTime() - 400 * DAY) });
    expect(decideParkingPage(held, enforced)).toBe("held");
  });
});
