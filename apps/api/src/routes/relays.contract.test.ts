/**
 * The registry half of the client/API contract gate.
 *
 * `packages/client/src/api.contract.test.ts` proves the client sends what
 * `@tnp/shared-types` describes. This proves the route ACCEPTS what
 * `@tnp/shared-types` describes — over real HTTP, through the real router,
 * rather than by calling the parser directly, which would only prove the
 * parser agrees with itself.
 *
 * Without both halves the gate has a hole: a route that quietly went back to
 * hand-written field checks would drift from the client again while every
 * parser test stayed green. That is precisely how audit B2 happened.
 *
 * No database is provided on purpose. Validation runs before the first query,
 * so a rejected body is a 400 from the contract and an accepted body reaches
 * the handler and fails at `getDb()` — which is what makes "did this body get
 * past validation?" observable without standing up Postgres.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import {
  encodeBase64,
  generateSigningKeyPair,
  signingKeyPairFromSeed,
  signRelayRegistryProof,
} from '@tnp/crypto';
import {
  type RegisterRelayRequest,
  type RelayHeartbeatRequest,
  verifySignedRelayDirectory,
} from '@tnp/shared-types';
import { directorySignerFromSeed } from '../registry/relayDirectory.js';
import relaysRouter, { createRelaysRouter } from './relays.js';

/** Status the handler returns once a body is past validation and hits the absent database. */
const REACHED_HANDLER = 500;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stands in for the app's optional Oxy auth: `requireOxyAuth` authorizes
  // whatever `getOxyUserId` can read off the request, so a userId is all a
  // route test needs to get past the guard.
  app.use((req, _res, next) => {
    (req as OxyAuthRequest).userId = 'oxy-user-under-test';
    next();
  });
  app.use('/relays', relaysRouter);

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test server did not bind a TCP port');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

async function post(path: string, body: unknown): Promise<{ status: number; error?: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, error: payload.error };
}

/**
 * Run a request whose body is valid, silencing the handler's log of the
 * database failure it is expected to hit.
 */
async function postPastValidation(path: string, body: unknown): Promise<number> {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    return (await post(path, body)).status;
  } finally {
    logged.mockRestore();
  }
}

describe('POST /relays/register', () => {
  test('accepts the contract shape', async () => {
    const request: RegisterRelayRequest = {
      endpoint: 'wss://relay.example.test:8443',
      publicKey: 'Zm9vYmFyLXB1YmxpYy1rZXk=',
      capacity: { maxConnections: 100, bandwidth: 250 },
      location: 'eu-west',
    };

    // Past validation and into the handler, where the absent database stops it.
    expect(await postPastValidation('/relays/register', request)).toBe(REACHED_HANDLER);
  });

  test('still accepts a relay released when operator was a request field', async () => {
    // Those relays send `operator`. They keep registering; what they claim is
    // ignored (the registry decides — test-db/relays.test.ts proves the row).
    for (const operator of ['community', 'oxy']) {
      expect(
        await postPastValidation('/relays/register', {
          endpoint: 'wss://relay.example.test:8443',
          publicKey: 'Zm9vYmFyLXB1YmxpYy1rZXk=',
          operator,
          capacity: { maxConnections: 100, bandwidth: 250 },
          location: 'eu-west',
        }),
      ).toBe(REACHED_HANDLER);
    }
  });

  test('refuses a ws:// endpoint and a private host before any query', async () => {
    const base = {
      publicKey: 'Zm9vYmFyLXB1YmxpYy1rZXk=',
      capacity: { maxConnections: 100, bandwidth: 250 },
    };
    expect(
      await post('/relays/register', { ...base, endpoint: 'ws://relay.example.test' }),
    ).toEqual({
      status: 400,
      error: 'endpoint must use wss://; plain ws:// relays are not published',
    });
    for (const endpoint of ['wss://127.0.0.1:8443', 'wss://10.0.0.5', 'wss://[::1]']) {
      expect(await post('/relays/register', { ...base, endpoint })).toEqual({
        status: 400,
        error:
          'endpoint must be a publicly reachable host, not a private, loopback or local address',
      });
    }
  });

  test('rejects the body the client sent before @tnp/shared-types existed', async () => {
    // Audit B2 verbatim. This is the request every `tnp relay` ever made.
    expect(await post('/relays/register', { port: 8080, location: 'eu-west' })).toEqual({
      status: 400,
      error: 'endpoint is required',
    });
  });

  test('rejects a registration missing any field the directory depends on', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ publicKey: undefined }, 'publicKey is required'],
      [{ capacity: undefined }, 'capacity with maxConnections and bandwidth is required'],
      [
        { capacity: { maxConnections: Number.NaN, bandwidth: 0 } },
        'capacity.maxConnections must be an integer between 1 and 1000000',
      ],
      [
        { endpoint: 'https://relay.example.test' },
        'endpoint must be a wss:// URL with no credentials, query or fragment',
      ],
    ];

    for (const [override, error] of cases) {
      const response = await post('/relays/register', {
        endpoint: 'wss://relay.example.test:8443',
        publicKey: 'Zm9vYmFyLXB1YmxpYy1rZXk=',
        capacity: { maxConnections: 100, bandwidth: 250 },
        location: 'eu-west',
        ...override,
      });
      expect(response).toEqual({ status: 400, error });
    }
  });
});

describe('POST /relays/heartbeat', () => {
  test('accepts the contract shape', async () => {
    const request: RelayHeartbeatRequest = { endpoint: 'wss://relay.example.test:8443' };

    expect(await postPastValidation('/relays/heartbeat', request)).toBe(REACHED_HANDLER);
  });

  test('refuses a ws:// endpoint: such a relay can no longer be listed', async () => {
    expect(await post('/relays/heartbeat', { endpoint: 'ws://relay.example.test' })).toEqual({
      status: 400,
      error: 'endpoint must use wss://; plain ws:// relays are not published',
    });
  });

  test('rejects the body the client sent before @tnp/shared-types existed', async () => {
    expect(
      await post('/relays/heartbeat', {
        relayId: '68b0f0a4c1f0a4a9b7d2e3f4',
        serviceNodes: 2,
        activeCircuits: 5,
      }),
    ).toEqual({ status: 400, error: 'endpoint is required' });
  });
});

describe('the gate itself', () => {
  test('an unauthenticated request never reaches validation', async () => {
    // The 500 that stands for "accepted" above must not be reachable any other
    // way, or every acceptance assertion here is vacuous. Mounted without the
    // auth stub, the same valid body stops at the guard.
    const guarded = express();
    guarded.use(express.json());
    guarded.use('/relays', relaysRouter);

    const listening = await new Promise<Server>((resolve) => {
      const s = guarded.listen(0, () => resolve(s));
    });
    const address = listening.address();
    if (address === null || typeof address === 'string') {
      throw new Error('test server did not bind a TCP port');
    }

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/relays/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'wss://relay.example.test:8443',
          publicKey: 'Zm9vYmFyLXB1YmxpYy1rZXk=',
          capacity: { maxConnections: 100, bandwidth: 250 },
          location: 'eu-west',
        }),
      });
      expect(res.status).toBe(401);
    } finally {
      await new Promise<void>((resolve, reject) => {
        listening.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});

const relayKey = generateSigningKeyPair();
const RELAY_ENDPOINT = 'wss://relay.example.test:8443';

function proofFor(purpose: 'register' | 'heartbeat', issuedAt = Math.floor(Date.now() / 1000)) {
  return {
    issuedAt,
    signature: signRelayRegistryProof(
      { purpose, endpoint: RELAY_ENDPOINT, relayKey: relayKey.publicKey, issuedAt },
      relayKey.secretKey,
    ),
  };
}

describe('relay key proofs', () => {
  const registration = {
    endpoint: RELAY_ENDPOINT,
    publicKey: encodeBase64(relayKey.publicKey),
    capacity: { maxConnections: 100, bandwidth: 250 },
    location: 'eu-west',
  };

  test('a registration carrying a valid proof is accepted', async () => {
    const request: RegisterRelayRequest = { ...registration, proof: proofFor('register') };
    expect(await postPastValidation('/relays/register', request)).toBe(REACHED_HANDLER);
  });

  test('a proof that does not verify is refused before any query', async () => {
    const stale = proofFor('register', Math.floor(Date.now() / 1000) - 3600);
    const wrongPurpose = proofFor('heartbeat');
    const otherKey = {
      ...registration,
      publicKey: encodeBase64(generateSigningKeyPair().publicKey),
    };
    for (const body of [
      { ...registration, proof: stale },
      { ...registration, proof: wrongPurpose },
      { ...otherKey, proof: proofFor('register') },
    ]) {
      const res = await post('/relays/register', body);
      expect(res.status).toBe(400);
      expect(res.error).toContain('proof does not verify');
    }
  });

  test('a heartbeat carrying a proof is the contract shape', async () => {
    const request: RelayHeartbeatRequest = {
      endpoint: RELAY_ENDPOINT,
      proof: proofFor('heartbeat'),
    };
    expect(await postPastValidation('/relays/heartbeat', request)).toBe(REACHED_HANDLER);
  });
});

describe('GET /relays/directory', () => {
  async function getFrom(router: express.Router) {
    const app = express();
    app.use('/relays', router);
    const listening = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = listening.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP port');
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/relays/directory`);
      return { status: res.status, body: (await res.json()) as unknown };
    } finally {
      logged.mockRestore();
      await new Promise<void>((resolve) => listening.close(() => resolve()));
    }
  }

  test('without a signing seed it answers 503 and never an unsigned listing', async () => {
    const res = await getFrom(createRelaysRouter(new Set(), { signer: null, oxyRelays: [] }));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'The signed relay directory is not available' });
    // The default router in this test process has no TNP_DIRECTORY_SIGNING_SEED either.
    expect((await getFrom(relaysRouter)).status).toBe(503);
  });

  test('with a seed it serves a document a client verifies with the matching key', async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const signed = directorySignerFromSeed(encodeBase64(seed));
    if (!signed.signer) throw new Error('signer');
    const oxyKey = encodeBase64(generateSigningKeyPair().publicKey);
    // No database here: community relays are unavailable, so the directory
    // degrades to the configured Oxy relays and is still signed.
    const res = await getFrom(
      createRelaysRouter(new Set(), {
        signer: signed.signer,
        oxyRelays: [{ endpoint: 'wss://relay.tnp.network', relayKey: oxyKey, region: 'us-west-2' }],
      }),
    );
    expect(res.status).toBe(200);
    const verified = verifySignedRelayDirectory(res.body, {
      now: Math.floor(Date.now() / 1000),
      trustedKeys: [signingKeyPairFromSeed(seed).publicKey],
    });
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.directory.relays.map((r) => [r.endpoint, r.operator, r.relayKey])).toEqual([
      ['wss://relay.tnp.network', 'oxy', oxyKey],
    ]);
    // And only with that key: the pinned production key does not verify a test signer.
    expect(verifySignedRelayDirectory(res.body, { now: Math.floor(Date.now() / 1000) }).ok).toBe(
      false,
    );
  });
});
