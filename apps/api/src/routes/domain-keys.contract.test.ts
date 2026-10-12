/**
 * The registry half of the domain-key contract gate.
 *
 * Same shape as `nodes.contract.test.ts`: the real router over real HTTP with
 * no database. A body the contract refuses is a 400 naming the field; one it
 * accepts reaches the handler and fails at `getDb()` with a 500. The client
 * half (`packages/client/src/api.contract.test.ts`) feeds the bytes the real
 * client sends through the same parser.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Server } from 'node:http';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { encodeBase64, generateSigningKeyPair, signDomainKeyRotation } from '@tnp/crypto';
import type { RegisterDomainKeyRequest } from '@tnp/shared-types';
import express from 'express';
import domainKeysRouter from './domain-keys.js';

const REACHED_HANDLER = 500;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as OxyAuthRequest).userId = 'oxy-user-under-test';
    next();
  });
  app.use('/domain-keys', domainKeysRouter);

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

async function post(body: unknown): Promise<{ status: number; error?: string }> {
  const res = await fetch(`${baseUrl}/domain-keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as { error?: string };
  return { status: res.status, error: payload.error };
}

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    logged.mockRestore();
  }
}

const a = generateSigningKeyPair();
const b = generateSigningKeyPair();

describe('POST /domain-keys', () => {
  test('accepts a first registration', async () => {
    const request: RegisterDomainKeyRequest = {
      name: 'example.ox',
      domainKey: encodeBase64(a.publicKey),
    };
    expect((await quiet(() => post(request))).status).toBe(REACHED_HANDLER);
  });

  test('accepts a rotation', async () => {
    const request: RegisterDomainKeyRequest = {
      name: 'example.ox',
      domainKey: encodeBase64(b.publicKey),
      rotation: signDomainKeyRotation(
        {
          name: 'example.ox',
          previousKey: encodeBase64(a.publicKey),
          nextKey: encodeBase64(b.publicKey),
          issuedAt: 1_800_000_000,
        },
        a.secretKey,
      ),
    };
    expect((await quiet(() => post(request))).status).toBe(REACHED_HANDLER);
  });

  test('names the field it rejects', async () => {
    const cases: Array<[unknown, string]> = [
      [{ domainKey: encodeBase64(a.publicKey) }, 'name must be a canonical name'],
      [{ name: 'example.ox' }, 'domainKey must be a base64 key'],
      [
        { name: 'example.ox', domainKey: encodeBase64(a.publicKey), rotation: 'yes' },
        'rotation must be an object',
      ],
      [
        { name: 'example.ox', domainKey: encodeBase64(a.publicKey), reset: true },
        'unexpected field reset',
      ],
    ];
    for (const [body, error] of cases) {
      expect(await post(body)).toEqual({ status: 400, error });
    }
  });

  test('refuses a name that is not label.tld, and a non-canonical key, before any query', async () => {
    expect(
      await post({ name: 'www.example.ox', domainKey: encodeBase64(a.publicKey) }),
    ).toMatchObject({ status: 400 });
    expect(await post({ name: 'example.com', domainKey: encodeBase64(a.publicKey) })).toMatchObject(
      { status: 400 },
    );
    expect(await post({ name: 'example.ox', domainKey: 'AAAA' })).toEqual({
      status: 400,
      error: 'domainKey must be canonical base64 of 32 bytes',
    });
  });
});

describe('GET /domain-keys/:name', () => {
  test('a name that cannot carry a key is a 404 without a query', async () => {
    for (const name of ['example.com', 'a.b.ox', 'nodot']) {
      expect((await fetch(`${baseUrl}/domain-keys/${name}`)).status).toBe(404);
    }
  });

  test('a valid name reaches the handler', async () => {
    const status = await quiet(
      async () => (await fetch(`${baseUrl}/domain-keys/example.ox`)).status,
    );
    expect(status).toBe(REACHED_HANDLER);
  });
});
