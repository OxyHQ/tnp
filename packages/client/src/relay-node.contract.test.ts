/**
 * `tnp relay`'s registration, end to end on the client side.
 *
 * `api.contract.test.ts` proves `TnpApiClient` serializes the contract
 * correctly. This proves the relay actually supplies one: it starts a real
 * `RelayNode` against a stubbed transport and checks that what reaches the
 * wire is a registration the registry's own parser accepts, with a real
 * endpoint, a real identity key, an operator and a capacity.
 *
 * That is the half audit B2 broke. `RelayNode.start` passed a port and a
 * location, which is not a registration in any version of the contract.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRegisterRelayRequest } from "@tnp/shared-types";
import { TnpApiClient } from "./api";
import { fromBase64 } from "./crypto";
import { RelayNode, type RelayNodeConfig } from "./relay-node";

const ED25519_PUBLIC_KEY_BYTES = 32;

const identityKeyPaths: string[] = [];

function testConfig(overrides: Partial<RelayNodeConfig> = {}): RelayNodeConfig {
  const identityKeyPath = join(
    tmpdir(),
    `tnp-relay-contract-${crypto.randomUUID()}.key`,
  );
  identityKeyPaths.push(identityKeyPath);

  return {
    // Port 0 lets the kernel pick, so the suite never collides with a real
    // relay or with a parallel run of itself.
    port: 0,
    host: "127.0.0.1",
    endpoint: "wss://relay.example.test:8443",
    maxConnections: 100,
    bandwidth: 250,
    authToken: "test-auth-token",
    location: "eu-west",
    apiBaseUrl: "https://api.example.test",
    identityKeyPath,
    ...overrides,
  };
}

afterEach(() => {
  for (const path of identityKeyPaths.splice(0)) {
    rmSync(path, { force: true });
  }
});

/** Start a relay against a stub transport and return the registration it sent. */
async function startAndCaptureRegistration(
  config: RelayNodeConfig,
): Promise<unknown> {
  const realFetch = globalThis.fetch;
  let body: unknown = null;

  const stub = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    if (!url.endsWith("/relays/register")) {
      throw new Error(`unexpected request during startup: ${url}`);
    }
    body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    return new Response(JSON.stringify(body), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };

  globalThis.fetch = stub as typeof fetch;
  const relay = new RelayNode(config);
  try {
    await relay.start(new TnpApiClient(config.apiBaseUrl));
  } finally {
    relay.stop();
    globalThis.fetch = realFetch;
  }

  if (body === null) {
    throw new Error("the relay started without registering at all");
  }
  return body;
}

describe("RelayNode.start", () => {
  test("registers with a body POST /relays/register accepts", async () => {
    const body = await startAndCaptureRegistration(testConfig());

    const parsed = parseRegisterRelayRequest(body);
    if (!parsed.ok) {
      throw new Error(`the registry would reject what the relay sent: ${parsed.error}`);
    }

    expect(parsed.value.endpoint).toBe("wss://relay.example.test:8443");
    expect(parsed.value.operator).toBe("community");
    expect(parsed.value.capacity).toEqual({ maxConnections: 100, bandwidth: 250 });
    expect(parsed.value.location).toBe("eu-west");

    // A real key, not a placeholder: clients authenticate the relay by the key
    // the directory publishes, so a wrong-length or non-base64 value would be
    // a relay nobody can verify.
    expect(fromBase64(parsed.value.publicKey).length).toBe(ED25519_PUBLIC_KEY_BYTES);
  });

  test("publishes the canonical form of the endpoint the operator typed", async () => {
    // Registration stores the endpoint and heartbeat looks it up by exact
    // match, so the two have to agree on spelling.
    const body = await startAndCaptureRegistration(
      testConfig({ endpoint: "WSS://Relay.Example.Test:8443/" }),
    );

    const parsed = parseRegisterRelayRequest(body);
    expect(parsed.ok && parsed.value.endpoint).toBe("wss://relay.example.test:8443");
  });

  test("refuses to start without a public endpoint, before binding a port", async () => {
    for (const endpoint of ["", "relay.example.test", "https://relay.example.test"]) {
      const relay = new RelayNode(testConfig({ endpoint }));
      await expect(relay.start(new TnpApiClient("https://api.example.test"))).rejects.toThrow(
        /is not a ws:\/\/ or wss:\/\/ URL/,
      );
      // A relay that failed to register is stopped, not listening-but-invisible.
      expect(relay.isRunning).toBe(false);
    }
  });

  test("runs unregistered when no auth token is configured", async () => {
    // A relay with no token is a private one. It must not try to register, and
    // must not be held to the directory's requirements.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      throw new Error(`a tokenless relay must not call the API: ${String(input)}`);
    }) as typeof fetch;

    const relay = new RelayNode(testConfig({ authToken: "", endpoint: "" }));
    try {
      await relay.start(new TnpApiClient("https://api.example.test"));
      expect(relay.isRunning).toBe(true);
    } finally {
      relay.stop();
      globalThis.fetch = realFetch;
    }
  });
});
