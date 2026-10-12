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

import { describe, expect, test } from 'bun:test';
import { createRulesEnvelope } from '@tnp/crypto/dns-rules';
import {
  parsePutDnsRulesRequest,
  parseRegisterRelayRequest,
  parseRelayHeartbeatRequest,
  parseRegisterServiceNodeRequest,
  parseServiceNodeHeartbeatRequest,
  parseRegisterDomainKeyRequest,
  type RegisterDomainKeyRequest,
  type ParseResult,
  serializeDnsRuleSet,
} from '@tnp/shared-types';
import {
  encodeBase64,
  generateSigningKeyPair,
  signDomainKeyRotation,
  verifyKeyAgreementCertificate,
} from '@tnp/crypto';
import { makeTestCredentials } from '@tnp/crypto/testing';
import { TnpApiClient } from './api';

const BASE_URL = 'https://api.example.test';
const AUTH_TOKEN = 'test-auth-token';
const DOMAIN_ID = '9f8d3b1c-2e4a-4d6b-8c7e-1a2b3c4d5e6f';

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
      url: typeof input === 'string' ? input : input.toString(),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    };
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  globalThis.fetch = stub as typeof fetch;
  try {
    await call(new TnpApiClient(BASE_URL));
  } finally {
    globalThis.fetch = realFetch;
  }

  if (captured === null) {
    throw new Error('the client made no request at all');
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
    throw new Error(`the client's ${endpoint} request is one the API rejects: ${parsed.error}`);
  }
  return parsed.value;
}

describe('relay registration', () => {
  test('registerRelay sends a body POST /relays/register accepts', async () => {
    const sent = await capture(
      (client) =>
        client.registerRelay(
          {
            endpoint: 'wss://relay.example.test:8443',
            publicKey: 'Zm9vYmFyLXB1YmxpYy1rZXk=',
            capacity: { maxConnections: 100, bandwidth: 250 },
            location: 'eu-west',
          },
          AUTH_TOKEN,
        ),
      {
        endpoint: 'wss://relay.example.test:8443',
        publicKey: 'Zm9vYmFyLXB1YmxpYy1rZXk=',
        operator: 'community',
        capacity: { maxConnections: 100, bandwidth: 250 },
        location: 'eu-west',
        status: 'active',
      },
    );

    expect(sent.url).toBe(`${BASE_URL}/relays/register`);
    expect(sent.method).toBe('POST');

    const accepted = expectAccepted(parseRegisterRelayRequest(sent.body), 'POST /relays/register');

    // Not just "it parsed": every value the operator supplied has to survive
    // the trip, or the relay is published as something other than itself.
    expect(accepted).toEqual({
      endpoint: 'wss://relay.example.test:8443',
      publicKey: 'Zm9vYmFyLXB1YmxpYy1rZXk=',
      capacity: { maxConnections: 100, bandwidth: 250 },
      location: 'eu-west',
    });

    // The client no longer claims an operator at all: the registry decides it.
    expect(Object.keys(sent.body as object)).not.toContain('operator');
  });

  test('sendRelayHeartbeat sends a body POST /relays/heartbeat accepts', async () => {
    const sent = await capture(
      (client) => client.sendRelayHeartbeat('wss://relay.example.test:8443', AUTH_TOKEN),
      { status: 'ok' },
    );

    expect(sent.url).toBe(`${BASE_URL}/relays/heartbeat`);
    expect(sent.method).toBe('POST');

    const accepted = expectAccepted(
      parseRelayHeartbeatRequest(sent.body),
      'POST /relays/heartbeat',
    );
    expect(accepted).toEqual({ endpoint: 'wss://relay.example.test:8443' });
  });

  test('the shapes the client used to send are still rejected', () => {
    // Pinned so a revert reads as a failure rather than as a passing test:
    // these two bodies are audit B2 verbatim, and if either starts parsing,
    // the contract has been widened back to accept the broken client.
    expect(parseRegisterRelayRequest({ port: 8080, location: 'eu-west' }).ok).toBe(false);
    expect(
      parseRelayHeartbeatRequest({
        relayId: '68b0f0a4c1f0a4a9b7d2e3f4',
        serviceNodes: 2,
        activeCircuits: 5,
      }).ok,
    ).toBe(false);
  });
});

describe('service node registration', () => {
  test('registerServiceNode sends a body POST /nodes/register accepts', async () => {
    const creds = makeTestCredentials('example.ox');
    const sent = await capture(
      (client) => client.registerServiceNode(DOMAIN_ID, creds.chain, creds.kaCert, AUTH_TOKEN),
      {
        domainId: DOMAIN_ID,
        publicKey: creds.kaCert.signer,
        connectedRelay: '',
        status: 'offline',
      },
    );

    expect(sent.url).toBe(`${BASE_URL}/nodes/register`);
    expect(sent.method).toBe('POST');

    const accepted = expectAccepted(
      parseRegisterServiceNodeRequest(sent.body),
      'POST /nodes/register',
    );
    expect(accepted).toEqual({ domainId: DOMAIN_ID, chain: creds.chain, kaCert: creds.kaCert });
    // What the registry receives is exactly what verifies, not a re-encoding of it.
    const verified = verifyKeyAgreementCertificate(accepted.kaCert, accepted.chain, {
      trustedRoots: [creds.domainKeyB64],
      role: 'service-node',
      name: 'example.ox',
      now: Math.floor(Date.now() / 1000),
    });
    expect(verified.ok).toBe(true);
  });

  test('the pre-v1 bare-key body is rejected', () => {
    expect(
      parseRegisterServiceNodeRequest({ domainId: DOMAIN_ID, publicKey: 'cHVibGljLWtleQ==' }).ok,
    ).toBe(false);
  });

  test('sendHeartbeat sends a body POST /nodes/heartbeat accepts', async () => {
    const sent = await capture(
      (client) => client.sendHeartbeat(DOMAIN_ID, 'wss://relay.example.test', AUTH_TOKEN),
      { status: 'ok' },
    );

    expect(sent.url).toBe(`${BASE_URL}/nodes/heartbeat`);
    expect(sent.method).toBe('POST');

    const accepted = expectAccepted(
      parseServiceNodeHeartbeatRequest(sent.body),
      'POST /nodes/heartbeat',
    );
    expect(accepted).toEqual({
      domainId: DOMAIN_ID,
      connectedRelay: 'wss://relay.example.test',
    });
  });
});

describe('domain keys', () => {
  test('registerDomainKey sends a body POST /domain-keys accepts (first key and rotation)', async () => {
    const a = generateSigningKeyPair();
    const b = generateSigningKeyPair();
    const first: RegisterDomainKeyRequest = {
      name: 'example.ox',
      domainKey: encodeBase64(a.publicKey),
    };
    const record = { name: 'example.ox', domainKey: first.domainKey, rotations: [] };
    const sent = await capture((client) => client.registerDomainKey(first, AUTH_TOKEN), record);
    expect(sent.url).toBe(`${BASE_URL}/domain-keys`);
    expect(sent.method).toBe('POST');
    expect(expectAccepted(parseRegisterDomainKeyRequest(sent.body), 'POST /domain-keys')).toEqual(
      first,
    );

    const rotation = signDomainKeyRotation(
      {
        name: 'example.ox',
        previousKey: first.domainKey,
        nextKey: encodeBase64(b.publicKey),
        issuedAt: 1_800_000_000,
      },
      a.secretKey,
    );
    const rotate: RegisterDomainKeyRequest = {
      name: 'example.ox',
      domainKey: encodeBase64(b.publicKey),
      rotation,
    };
    const sent2 = await capture((client) => client.registerDomainKey(rotate, AUTH_TOKEN), record);
    expect(expectAccepted(parseRegisterDomainKeyRequest(sent2.body), 'POST /domain-keys')).toEqual(
      rotate,
    );
  });
});

describe('personal DNS rules', () => {
  // A real envelope, made the way the dashboard makes one (the web's
  // tests/dns-rules.test.ts captures its PUT body the same way).
  const made = createRulesEnvelope({
    passphrase: 'contract passphrase',
    userId: 'oxy-user-contract',
    body: new TextEncoder().encode(serializeDnsRuleSet([])),
    kdfParams: { alg: 'argon2id', m: 19_456, t: 2, p: 1 },
  });
  const stored = {
    ...made.envelope,
    userId: 'oxy-user-contract',
    updatedAt: '2026-10-12T00:00:00.000Z',
  };

  test('an envelope @tnp/crypto produces is a body PUT /me/dns-rules accepts, field for field', () => {
    const accepted = expectAccepted(parsePutDnsRulesRequest(made.envelope), 'PUT /me/dns-rules');
    expect(accepted).toEqual(made.envelope);
  });

  test('getDnsRules sends an authenticated GET and returns the validated record', async () => {
    let returned: unknown = null;
    const sent = await capture(async (client) => {
      returned = await client.getDnsRules(AUTH_TOKEN);
    }, stored);
    expect(sent.url).toBe(`${BASE_URL}/me/dns-rules`);
    expect(sent.method).toBe('GET');
    expect(sent.body).toBeNull();
    expect(returned).toEqual(stored);
  });

  test('getDnsRules refuses a malformed record instead of decrypting it', async () => {
    await expect(
      capture((client) => client.getDnsRules(AUTH_TOKEN), {
        ...stored,
        kdfParams: { alg: 'argon2id', m: 8, t: 1, p: 1 },
      }),
    ).rejects.toThrow('the API returned a malformed rule set');
  });
});

describe('the gate itself', () => {
  test('a client that sends nothing fails instead of passing vacuously', async () => {
    // `capture` returning a null body would make every assertion above run
    // against `undefined`, and `parseRegisterRelayRequest(undefined)` failing
    // would then read as drift. It has to fail as what it is.
    await expect(capture(async () => undefined, {})).rejects.toThrow(
      'the client made no request at all',
    );
  });

  test('expectAccepted reports the rejected field, not just a boolean', () => {
    expect(() =>
      expectAccepted(parseRegisterRelayRequest({ port: 8080 }), 'POST /relays/register'),
    ).toThrow('endpoint is required');
  });
});
