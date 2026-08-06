/**
 * The client/API contract gate.
 *
 * `TnpApiClient` is the only thing in the client that talks to the registry,
 * and every one of its writes is parsed on the other side by a function in
 * `@tnp/shared-types`. This suite runs the real client methods, captures the
 * bytes they actually put on the wire, and feeds those bytes to the registry's
 * real parser.
 *
 * That is deliberately not a test of the types. The types already make the
 * drift hard to write; this makes it observable. If someone changes what
 * `registerRelay` sends, or what the registry accepts, one side of this
 * round trip stops matching the other and the test names the field.
 *
 * The drift it exists to prevent is not hypothetical: `registerRelay` sent
 * `{ port, location }` to an endpoint that required
 * `{ endpoint, publicKey, operator, capacity }` for the entire life of the
 * feature, so `tnp relay` could never register (audit finding B2).
 */

import { describe, expect, test } from "bun:test";
import {
  parseRegisterRelayRequest,
  parseRelayHeartbeatRequest,
  parseRegisterServiceNodeRequest,
  parseServiceNodeHeartbeatRequest,
  type ParseResult,
} from "@tnp/shared-types";
import { TnpApiClient } from "./api";

const BASE_URL = "https://api.example.test";
const AUTH_TOKEN = "test-auth-token";
const DOMAIN_ID = "9f8d3b1c-2e4a-4d6b-8c7e-1a2b3c4d5e6f";

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Run a client call against a stub transport and return what it sent.
 *
 * The stub answers with `response` so the method under test completes
 * normally; what is asserted on is the request, not the reply.
 */
async function capture(
  call: (client: TnpApiClient) => Promise<unknown>,
  response: unknown,
): Promise<CapturedRequest> {
  const realFetch = globalThis.fetch;
  let captured: CapturedRequest | null = null;

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured = {
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  globalThis.fetch = stub as typeof fetch;
  try {
    await call(new TnpApiClient(BASE_URL));
  } finally {
    globalThis.fetch = realFetch;
  }

  if (captured === null) {
    throw new Error("the client made no request at all");
  }
  return captured;
}

/**
 * Assert the registry accepts what the client sent, and say what it rejected
 * when it does not — a bare `expect(parsed.ok).toBe(true)` on a failed parse
 * reports "expected true, got false" and hides the one useful fact.
 */
function expectAccepted<T>(parsed: ParseResult<T>, endpoint: string): T {
  if (!parsed.ok) {
    throw new Error(
      `the client's ${endpoint} request is one the API rejects: ${parsed.error}`,
    );
  }
  return parsed.value;
}

describe("relay registration", () => {
  test("registerRelay sends a body POST /relays/register accepts", async () => {
    const sent = await capture(
      (client) =>
        client.registerRelay(
          {
            endpoint: "wss://relay.example.test:8443",
            publicKey: "Zm9vYmFyLXB1YmxpYy1rZXk=",
            operator: "community",
            capacity: { maxConnections: 100, bandwidth: 250 },
            location: "eu-west",
          },
          AUTH_TOKEN,
        ),
      {
        endpoint: "wss://relay.example.test:8443",
        publicKey: "Zm9vYmFyLXB1YmxpYy1rZXk=",
        operator: "community",
        capacity: { maxConnections: 100, bandwidth: 250 },
        location: "eu-west",
        status: "active",
      },
    );

    expect(sent.url).toBe(`${BASE_URL}/relays/register`);
    expect(sent.method).toBe("POST");

    const accepted = expectAccepted(
      parseRegisterRelayRequest(sent.body),
      "POST /relays/register",
    );

    // Not just "it parsed": every value the operator supplied has to survive
    // the trip, or the relay is published as something other than itself.
    expect(accepted).toEqual({
      endpoint: "wss://relay.example.test:8443",
      publicKey: "Zm9vYmFyLXB1YmxpYy1rZXk=",
      operator: "community",
      capacity: { maxConnections: 100, bandwidth: 250 },
      location: "eu-west",
    });
  });

  test("sendRelayHeartbeat sends a body POST /relays/heartbeat accepts", async () => {
    const sent = await capture(
      (client) => client.sendRelayHeartbeat("wss://relay.example.test:8443", AUTH_TOKEN),
      { status: "ok" },
    );

    expect(sent.url).toBe(`${BASE_URL}/relays/heartbeat`);
    expect(sent.method).toBe("POST");

    const accepted = expectAccepted(
      parseRelayHeartbeatRequest(sent.body),
      "POST /relays/heartbeat",
    );
    expect(accepted).toEqual({ endpoint: "wss://relay.example.test:8443" });
  });

  test("the shapes the client used to send are still rejected", () => {
    // Pinned so a revert reads as a failure rather than as a passing test:
    // these two bodies are audit B2 verbatim, and if either starts parsing,
    // the contract has been widened back to accept the broken client.
    expect(parseRegisterRelayRequest({ port: 8080, location: "eu-west" }).ok).toBe(false);
    expect(
      parseRelayHeartbeatRequest({
        relayId: "68b0f0a4c1f0a4a9b7d2e3f4",
        serviceNodes: 2,
        activeCircuits: 5,
      }).ok,
    ).toBe(false);
  });
});

describe("service node registration", () => {
  test("registerServiceNode sends a body POST /nodes/register accepts", async () => {
    const sent = await capture(
      (client) => client.registerServiceNode(DOMAIN_ID, "cHVibGljLWtleQ==", AUTH_TOKEN),
      { domainId: DOMAIN_ID, publicKey: "cHVibGljLWtleQ==", connectedRelay: "", status: "offline" },
    );

    expect(sent.url).toBe(`${BASE_URL}/nodes/register`);
    expect(sent.method).toBe("POST");

    const accepted = expectAccepted(
      parseRegisterServiceNodeRequest(sent.body),
      "POST /nodes/register",
    );
    expect(accepted).toEqual({ domainId: DOMAIN_ID, publicKey: "cHVibGljLWtleQ==" });
  });

  test("sendHeartbeat sends a body POST /nodes/heartbeat accepts", async () => {
    const sent = await capture(
      (client) => client.sendHeartbeat(DOMAIN_ID, "wss://relay.example.test", AUTH_TOKEN),
      { status: "ok" },
    );

    expect(sent.url).toBe(`${BASE_URL}/nodes/heartbeat`);
    expect(sent.method).toBe("POST");

    const accepted = expectAccepted(
      parseServiceNodeHeartbeatRequest(sent.body),
      "POST /nodes/heartbeat",
    );
    expect(accepted).toEqual({
      domainId: DOMAIN_ID,
      connectedRelay: "wss://relay.example.test",
    });
  });
});

describe("the gate itself", () => {
  test("a client that sends nothing fails instead of passing vacuously", async () => {
    // `capture` returning a null body would make every assertion above run
    // against `undefined`, and `parseRegisterRelayRequest(undefined)` failing
    // would then read as drift. It has to fail as what it is.
    await expect(capture(async () => undefined, {})).rejects.toThrow(
      "the client made no request at all",
    );
  });

  test("expectAccepted reports the rejected field, not just a boolean", () => {
    expect(() =>
      expectAccepted(parseRegisterRelayRequest({ port: 8080 }), "POST /relays/register"),
    ).toThrow("endpoint is required");
  });
});
