/** Consumer's real middleware + installed candidate SDK over HTTP.
 * Issuer authority is synthetic; no production credentials, product DB or effects.
 */
import assert from 'node:assert/strict';
import { getRequiredOxyUserId, requireOxyAuth } from '@oxy.so/core/server';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request as ExpressRequest, type Response as ExpressResponse } from 'express';

let issuer: Server;
let receiver: Server;
let receiverOrigin = '';
let active = true;
let validations = 0;
let admitted = 0;

function bearer(userId = 'receiver-owner', includeSession = true): string {
  const payload = {
    userId,
    ...(includeSession ? { sessionId: 'receiver-session' } : {}),
    exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000),
  };
  return `e30.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.synthetic-issuer-boundary`;
}
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
function request(token?: string): Promise<Response> {
  return fetch(`${receiverOrigin}/owned-fixture`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}
const originalFetch = globalThis.fetch;
let blockedNetwork = 0;
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, thisArg, args: Parameters<typeof fetch>) {
    const [input] = args;
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
      blockedNetwork += 1;
      return Promise.reject(new Error('Receiver probe refuses non-loopback fetch'));
    }
    return Reflect.apply(target, thisArg, args);
  },
});

async function run(): Promise<void> {
  try {
    issuer = createServer((req, res) => {
      if (!req.url?.startsWith('/session/validate/receiver-session')) {
        res.writeHead(404).end();
        return;
      }
      validations += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          valid: active,
          user: { id: 'receiver-owner' },
          sessionId: 'receiver-session',
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          lastActivity: new Date().toISOString(),
        }),
      );
    });
    process.env.OXY_API_URL = await listen(issuer);
    // Configuration syntax only: this test never opens a product database.
    process.env.DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/receiver_fixture_unused';
    const { oxyAuthOptional } = await import('../../middleware/auth.js');
    const middleware = [oxyAuthOptional, requireOxyAuth];
    const app = express();
    app.get('/owned-fixture', middleware, (req: ExpressRequest, res: ExpressResponse) => {
      admitted += 1;
      res.json({ userId: getRequiredOxyUserId(req) });
    });
    receiver = createServer(app);
    receiverOrigin = await listen(receiver);

    // refuses missing and sessionless bearers before the protected handler
    {
      const before = admitted;
      assert.equal((await request()).status, 401);
      assert.equal((await request(bearer('receiver-owner', false))).status, 401);
      assert.equal(admitted, before);
    }

    // uses the live validated owner and rejects a conflicting token claim
    {
      active = true;
      const response = await request(bearer());
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { userId: 'receiver-owner' });
      const before = admitted;
      assert.equal((await request(bearer('other-owner'))).status, 401);
      assert.equal(admitted, before);
    }

    // revalidates on the next call and refuses revocation without a cached admit
    {
      active = true;
      assert.equal((await request(bearer())).status, 200);
      const before = admitted;
      const checks = validations;
      active = false;
      assert.equal((await request(bearer())).status, 401);
      assert.equal(validations, checks + 1);
      assert.equal(admitted, before);
    }
    assert.equal(blockedNetwork, 0);
    process.stdout.write(
      JSON.stringify({ controls: 3, validations, admitted, nonLoopbackRequests: blockedNetwork }) +
        '\n',
    );
  } finally {
    try {
      await close(receiver);
    } finally {
      await close(issuer);
    }
    globalThis.fetch = originalFetch;
  }
}
void run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Receiver probe failed');
  process.exitCode = 1;
});
