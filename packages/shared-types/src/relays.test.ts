import { describe, expect, test } from "bun:test";
import {
  MAX_RELAY_BANDWIDTH_MBPS,
  MAX_RELAY_CONNECTIONS,
  normalizeRelayEndpoint,
  parseRegisterRelayRequest,
  parseRelayHeartbeatRequest,
  type RegisterRelayRequest,
} from "./relays.js";

/** A registration the registry must accept, used as the base for mutations. */
function validRequest(): RegisterRelayRequest {
  return {
    endpoint: "wss://relay.example.test",
    publicKey: "Zm9vYmFyLXB1YmxpYy1rZXk=",
    operator: "community",
    capacity: { maxConnections: 100, bandwidth: 0 },
    location: "eu-west",
  };
}

describe("normalizeRelayEndpoint", () => {
  test("keeps a canonical endpoint untouched", () => {
    expect(normalizeRelayEndpoint("wss://relay.example.test")).toBe(
      "wss://relay.example.test",
    );
  });

  test("collapses the spellings that would otherwise be different relays", () => {
    const canonical = "wss://relay.example.test:8443";
    for (const spelling of [
      "wss://relay.example.test:8443/",
      "wss://RELAY.Example.Test:8443",
      "  wss://relay.example.test:8443//  ",
    ]) {
      expect(normalizeRelayEndpoint(spelling)).toBe(canonical);
    }
  });

  test("keeps a path, because a relay may be mounted under one", () => {
    expect(normalizeRelayEndpoint("wss://edge.example.test/relay/")).toBe(
      "wss://edge.example.test/relay",
    );
  });

  test("refuses anything that is not a bare ws endpoint", () => {
    for (const bad of [
      "relay.example.test",
      "https://relay.example.test",
      "http://relay.example.test",
      "wss://user:pass@relay.example.test",
      "wss://relay.example.test?token=abc",
      "wss://relay.example.test#frag",
      "wss://",
      "",
    ]) {
      expect(normalizeRelayEndpoint(bad)).toBeNull();
    }
  });
});

describe("parseRegisterRelayRequest", () => {
  test("accepts the contract shape and returns a canonical endpoint", () => {
    const parsed = parseRegisterRelayRequest({
      ...validRequest(),
      endpoint: "WSS://Relay.Example.Test/",
    });

    expect(parsed).toEqual({
      ok: true,
      value: {
        endpoint: "wss://relay.example.test",
        publicKey: "Zm9vYmFyLXB1YmxpYy1rZXk=",
        operator: "community",
        capacity: { maxConnections: 100, bandwidth: 0 },
        location: "eu-west",
      },
    });
  });

  test("rejects the body the client sent before @tnp/shared-types existed", () => {
    // Audit B2 verbatim: this is what `TnpApiClient.registerRelay` used to
    // send, and it is why no community relay ever registered.
    const parsed = parseRegisterRelayRequest({ port: 8080, location: "eu-west" });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toBe("endpoint is required");
  });

  test("names the missing field for every field the registry depends on", () => {
    const cases: Array<[Partial<Record<string, unknown>>, string]> = [
      [{ endpoint: undefined }, "endpoint is required"],
      [{ endpoint: "relay.example.test" }, "endpoint must be a ws:// or wss:// URL with no credentials, query or fragment"],
      [{ publicKey: undefined }, "publicKey is required"],
      [{ publicKey: "   " }, "publicKey is required"],
      [{ operator: undefined }, "operator must be 'oxy' or 'community'"],
      [{ operator: "someone-else" }, "operator must be 'oxy' or 'community'"],
      [{ capacity: undefined }, "capacity with maxConnections and bandwidth is required"],
      [{ capacity: [] }, "capacity with maxConnections and bandwidth is required"],
      [
        { capacity: { bandwidth: 0 } },
        `capacity.maxConnections must be an integer between 1 and ${MAX_RELAY_CONNECTIONS}`,
      ],
      [
        { capacity: { maxConnections: 100 } },
        `capacity.bandwidth must be an integer between 0 and ${MAX_RELAY_BANDWIDTH_MBPS}`,
      ],
      [{ location: 42 }, "location must be a string"],
    ];

    for (const [override, error] of cases) {
      const parsed = parseRegisterRelayRequest({ ...validRequest(), ...override });
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? "" : parsed.error).toBe(error);
    }
  });

  test("rejects capacity numbers a Postgres integer column cannot hold", () => {
    // `typeof value === "number"` — the check this parser replaced — accepts
    // every one of these, and each becomes a failed insert, i.e. a 500 for a
    // request that was malformed all along.
    for (const maxConnections of [Number.NaN, Number.POSITIVE_INFINITY, 12.5, 0, -1]) {
      const parsed = parseRegisterRelayRequest({
        ...validRequest(),
        capacity: { maxConnections, bandwidth: 0 },
      });
      expect(parsed.ok).toBe(false);
    }
  });

  test("treats an absent location as unlabelled, not as an error", () => {
    const { location: _location, ...withoutLocation } = validRequest();
    const parsed = parseRegisterRelayRequest(withoutLocation);

    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.value.location : null).toBe("");
  });

  test("rejects bodies that are not objects", () => {
    for (const body of [null, undefined, "endpoint", 7, ["wss://relay.example.test"]]) {
      expect(parseRegisterRelayRequest(body).ok).toBe(false);
    }
  });
});

describe("parseRelayHeartbeatRequest", () => {
  test("accepts an endpoint and canonicalizes it the same way registration did", () => {
    const parsed = parseRelayHeartbeatRequest({ endpoint: "wss://Relay.Example.Test/" });

    expect(parsed).toEqual({ ok: true, value: { endpoint: "wss://relay.example.test" } });
  });

  test("rejects the body the client sent before @tnp/shared-types existed", () => {
    // The heartbeat half of audit B2: a relay id and stats, no endpoint.
    const parsed = parseRelayHeartbeatRequest({
      relayId: "68b0f0a4c1f0a4a9b7d2e3f4",
      serviceNodes: 2,
      activeCircuits: 5,
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toBe("endpoint is required");
  });
});
