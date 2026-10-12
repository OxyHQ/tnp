/**
 * The registry half of the contract gate for `/me/dns-rules`.
 *
 * `packages/client/src/api.contract.test.ts` and the web's
 * `tests/dns-rules.test.ts` prove the client and the dashboard build what
 * `@tnp/shared-types` describes (from a real `@tnp/crypto` envelope). This
 * proves the route accepts that shape — over HTTP, through the real router —
 * and refuses everything else before the database is touched.
 *
 * No database: a rejected body is a 400 from the contract; an accepted one
 * reaches the handler and fails at `getDb()` with a 500. Conflicts (409),
 * creation and deletion need PostgreSQL: `test-db/dns-rules.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import type { PutDnsRulesRequest } from '@tnp/shared-types';
import fixture from './fixtures/dns-rules-envelope.json';
import meRouter, { DNS_RULES_BODY_LIMIT, dnsRulesBodyParser } from './me.js';

const REACHED_HANDLER = 500;
const envelope = fixture as PutDnsRulesRequest;

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP port');
  return { server, base: `http://127.0.0.1:${address.port}` };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  // The same order as app.ts: the path-scoped parser, then the default one.
  app.use('/me/dns-rules', dnsRulesBodyParser);
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as OxyAuthRequest).userId = 'oxy-user-under-test';
    next();
  });
  app.use('/me', meRouter);
  ({ server, base } = await listen(app));
});

afterAll(() => close(server));

async function put(body: unknown): Promise<{ status: number; error?: string }> {
  const res = await fetch(`${base}/me/dns-rules`, {
    method: 'PUT',
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

describe('PUT /me/dns-rules', () => {
  test('accepts a real envelope made by @tnp/crypto', async () => {
    expect((await quiet(() => put(envelope))).status).toBe(REACHED_HANDLER);
  });

  test('accepts an envelope at the 256 KiB ciphertext cap, past the default 100 KB body limit', async () => {
    const ciphertext = btoa('\0'.repeat(256 * 1024));
    expect((await quiet(() => put({ ...envelope, ciphertext, version: 2 }))).status).toBe(
      REACHED_HANDLER,
    );
  });

  test('refuses a ciphertext one byte over the cap', async () => {
    const ciphertext = btoa('\0'.repeat(256 * 1024 + 1));
    expect(await put({ ...envelope, ciphertext })).toEqual({
      status: 400,
      error: 'ciphertext is larger than 262144 bytes',
    });
  });

  test('refuses a body over the route limit before parsing it', async () => {
    const res = await quiet(() =>
      fetch(`${base}/me/dns-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...envelope, ciphertext: 'A'.repeat(DNS_RULES_BODY_LIMIT) }),
      }),
    );
    expect(res.status).toBe(413);
  });

  test('refuses anything that is not the envelope', async () => {
    const cases: Array<[unknown, string]> = [
      [{ rules: [{ type: 'block', name: 'example.com' }] }, 'v must be 1'],
      [{ ...envelope, v: 2 }, 'v must be 1'],
      [{ ...envelope, version: 0 }, 'version must be an integer between 1 and 2147483647'],
      [{ ...envelope, version: 2 ** 31 }, 'version must be an integer between 1 and 2147483647'],
      [{ ...envelope, wrappedKey: 'AAAA' }, 'wrappedKey must be 72 bytes of canonical base64'],
      [
        { ...envelope, kdfParams: { alg: 'argon2id', m: 8, t: 1, p: 1 } },
        'kdfParams must be argon2id with m 19456-1048576 KiB, t 2-10, p 1-4',
      ],
    ];
    for (const [body, error] of cases) {
      expect(await put(body)).toEqual({ status: 400, error });
    }
  });
});

describe('GET and DELETE /me/dns-rules', () => {
  test('reach the handler for an authenticated caller', async () => {
    const get = await quiet(() => fetch(`${base}/me/dns-rules`));
    expect(get.status).toBe(REACHED_HANDLER);
    expect(get.headers.get('cache-control')).toBe('no-store');
    const del = await quiet(() => fetch(`${base}/me/dns-rules`, { method: 'DELETE' }));
    expect(del.status).toBe(REACHED_HANDLER);
  });
});

describe('the gate itself', () => {
  test('an unauthenticated request never reaches validation or the database', async () => {
    const app = express();
    app.use('/me/dns-rules', dnsRulesBodyParser);
    app.use('/me', meRouter);
    const guarded = await listen(app);
    try {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const res = await fetch(`${guarded.base}/me/dns-rules`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: method === 'PUT' ? JSON.stringify(envelope) : undefined,
        });
        expect(res.status).toBe(401);
      }
    } finally {
      await close(guarded.server);
    }
  });
});
