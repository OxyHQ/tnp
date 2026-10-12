/**
 * The registry half of the contract gate for `/me/vpn` and `/exit/peers`.
 *
 * The web dashboard (`apps/web/tests/vpn.test.ts`), the CLI
 * (`packages/client/src/api.contract.test.ts`) and the exit agent
 * (`apps/exit/src/agent.test.ts`) prove they build or read what
 * `@tnp/shared-types` describes. This proves the routes accept that shape —
 * over HTTP, through the real routers — refuse everything else before the
 * database is touched, stay shut while the feature is off, and let no exit in
 * without its token.
 *
 * No database: a rejected request is a 4xx/503 from the route; an accepted one
 * reaches the handler and fails at `getDb()` with a 500. Allocation, the cap
 * and the peer listing need PostgreSQL: `test-db/vpn-devices.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { generateWireGuardKeyPair } from '@tnp/crypto/wireguard';
import type { CreateVpnDeviceRequest } from '@tnp/shared-types';
import { digestToken, type VpnConfig } from '../vpn.js';
import { createExitRouter } from './exit.js';
import { createMeRouter } from './me.js';

const REACHED_HANDLER = 500;
const DEVICE_ID = '9f8d3b1c-2e4a-4d6b-8c7e-1a2b3c4d5e6f';
const EXIT_TOKEN = 'e'.repeat(48);

const CONFIG: VpnConfig = {
  exits: [
    {
      id: 'usw2-1',
      region: 'us-west-2',
      endpoint: 'usw2-1.exit.example:51820',
      publicKey: generateWireGuardKeyPair().publicKey,
    },
  ],
  dns: ['198.51.100.53'],
  exitTokenDigests: [digestToken(EXIT_TOKEN)],
  maxDevices: 10,
};

let enabled = true;
const vpn = () => (enabled ? CONFIG : null);

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

async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await fn();
  } finally {
    logged.mockRestore();
  }
}

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/me', (req, _res, next) => {
    (req as OxyAuthRequest).userId = 'oxy-user-under-test';
    next();
  });
  app.use('/me', createMeRouter(undefined, vpn));
  app.use('/exit', createExitRouter({ vpn }));
  ({ server, base } = await listen(app));
});

afterAll(() => close(server));

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await quiet(() =>
    fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, body: payload, headers: res.headers };
}

const validBody = (): CreateVpnDeviceRequest => ({
  name: 'Home router',
  publicKey: generateWireGuardKeyPair().publicKey,
});

describe('POST /me/vpn/devices', () => {
  test('accepts a name and a WireGuard public key', async () => {
    enabled = true;
    const res = await call('POST', '/me/vpn/devices', validBody());
    expect(res.status).toBe(REACHED_HANDLER);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('refuses a bad key, a bad name and any private key before the database', async () => {
    enabled = true;
    const pair = generateWireGuardKeyPair();
    const cases: Array<[unknown, string]> = [
      [
        { name: 'phone', publicKey: 'AAAA' },
        'publicKey must be a WireGuard public key: canonical base64 of 32 bytes',
      ],
      [
        { name: 'phone', publicKey: btoa(String.fromCharCode(...new Uint8Array(32))) },
        'publicKey must be a WireGuard public key: canonical base64 of 32 bytes',
      ],
      [{ publicKey: pair.publicKey }, 'name is required'],
      [
        { name: 'phone', publicKey: pair.publicKey, privateKey: pair.privateKey },
        'never send a private key; send only publicKey',
      ],
      [[pair.publicKey], 'body must be a JSON object'],
    ];
    for (const [body, error] of cases) {
      const res = await call('POST', '/me/vpn/devices', body);
      expect({ status: res.status, error: res.body.error }).toEqual({ status: 400, error });
    }
  });
});

describe('the other /me/vpn routes', () => {
  test('GET and PATCH reach the handler; a malformed id is a 404 without a query', async () => {
    enabled = true;
    expect((await call('GET', '/me/vpn/devices')).status).toBe(REACHED_HANDLER);
    expect((await call('PATCH', `/me/vpn/devices/${DEVICE_ID}`, { name: 'Laptop' })).status).toBe(
      REACHED_HANDLER,
    );
    expect((await call('PATCH', `/me/vpn/devices/${DEVICE_ID}`, { name: '' })).status).toBe(400);
    expect((await call('PATCH', '/me/vpn/devices/not-a-uuid', { name: 'Laptop' })).status).toBe(
      404,
    );
    expect((await call('DELETE', `/me/vpn/devices/${DEVICE_ID}`)).status).toBe(REACHED_HANDLER);
    expect((await call('DELETE', '/me/vpn/devices/1')).status).toBe(404);
  });

  test('while the VPN is off: 503 vpn_not_configured, except DELETE', async () => {
    enabled = false;
    try {
      for (const [method, path, body] of [
        ['GET', '/me/vpn/devices', undefined],
        ['POST', '/me/vpn/devices', validBody()],
        ['PATCH', `/me/vpn/devices/${DEVICE_ID}`, { name: 'Laptop' }],
      ] as const) {
        const res = await call(method, path, body);
        expect({ status: res.status, code: res.body.code }).toEqual({
          status: 503,
          code: 'vpn_not_configured',
        });
      }
      // Removing your own data is never switched off.
      expect((await call('DELETE', `/me/vpn/devices/${DEVICE_ID}`)).status).toBe(REACHED_HANDLER);
    } finally {
      enabled = true;
    }
  });

  test('an unauthenticated request never reaches validation or the database', async () => {
    const app = express();
    app.use(express.json());
    app.use('/me', createMeRouter(undefined, vpn));
    const guarded = await listen(app);
    try {
      for (const [method, path] of [
        ['GET', '/me/vpn/devices'],
        ['POST', '/me/vpn/devices'],
        ['PATCH', `/me/vpn/devices/${DEVICE_ID}`],
        ['DELETE', `/me/vpn/devices/${DEVICE_ID}`],
      ]) {
        const res = await fetch(`${guarded.base}${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: method === 'POST' || method === 'PATCH' ? JSON.stringify(validBody()) : undefined,
        });
        expect(res.status).toBe(401);
      }
    } finally {
      await close(guarded.server);
    }
  });
});

describe('GET /exit/peers', () => {
  test('without the exit token: 401, whatever is sent', async () => {
    enabled = true;
    const cases: Array<Record<string, string>> = [
      {},
      { Authorization: '' },
      { Authorization: 'Bearer wrong-token-wrong-token-wrong-token' },
      { Authorization: `Bearer ${EXIT_TOKEN.slice(1)}` },
      { Authorization: EXIT_TOKEN },
    ];
    for (const headers of cases) {
      const res = await call('GET', '/exit/peers', undefined, headers);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  test('with the exit token: reaches the database', async () => {
    enabled = true;
    const res = await call('GET', '/exit/peers', undefined, {
      Authorization: `Bearer ${EXIT_TOKEN}`,
    });
    expect(res.status).toBe(REACHED_HANDLER);
  });

  test('an Oxy session is not an exit token', async () => {
    enabled = true;
    const app = express();
    app.use((req, _res, next) => {
      (req as OxyAuthRequest).userId = 'oxy-user-under-test';
      next();
    });
    app.use('/exit', createExitRouter({ vpn }));
    const withSession = await listen(app);
    try {
      expect((await fetch(`${withSession.base}/exit/peers`)).status).toBe(401);
    } finally {
      await close(withSession.server);
    }
  });

  test('while the VPN is off: 503 for everyone, token or not', async () => {
    enabled = false;
    try {
      const res = await call('GET', '/exit/peers', undefined, {
        Authorization: `Bearer ${EXIT_TOKEN}`,
      });
      expect({ status: res.status, code: res.body.code }).toEqual({
        status: 503,
        code: 'vpn_not_configured',
      });
    } finally {
      enabled = true;
    }
  });
});
