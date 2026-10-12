/**
 * The real app assembly, with no database: headers, rate limits, timeouts and
 * the parking page's policy, observed over HTTP.
 */

import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import type { Server } from 'node:http';
import type { NextFunction, Request, RequestHandler, Response as ExpressResponse } from 'express';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { createApp, type AppOptions } from './app.js';
import { corsOriginsFor } from './config.js';
import { ADDRESS_TIERS, type NetworkLimitSettings } from './middleware/networkLimits.js';
import { DEFAULT_CSP, HSTS } from './middleware/security.js';
import { PARKING_CSP } from './parking.js';
import type { NameFacts } from './registry/resolve.js';

const servers: Server[] = [];

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((err) => (err ? reject(err) : resolve())),
        ),
    ),
  );
});

/** An auth stand-in: `x-test-user` becomes the Oxy user id. */
const testAuth: RequestHandler = (req: Request, _res: ExpressResponse, next: NextFunction) => {
  const user = req.get('x-test-user');
  if (user) (req as OxyAuthRequest).userId = user;
  next();
};

const generousLimits: NetworkLimitSettings = {
  trustProxyHops: 0,
  trustCloudflareHeader: false,
  cloudflareIpRanges: [],
  exempt: [],
};

async function serve(overrides: Partial<AppOptions> = {}): Promise<string> {
  const app = createApp({
    servicesRouter: (_req, res) => {
      res.json({ services: true });
    },
    auth: testAuth,
    // The process-wide publisher is another suite's to start and stub.
    ecosystemActivity: () => undefined,
    limits: generousLimits,
    requestTimeoutMs: 0,
    ...overrides,
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP port');
  return `http://127.0.0.1:${address.port}`;
}

/** Fetch with the expected database failure's log silenced. */
async function quietFetch(url: string, init?: RequestInit): Promise<Response> {
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await fetch(url, init);
  } finally {
    logged.mockRestore();
  }
}

describe('security headers', () => {
  test('every response carries HSTS, nosniff, no-referrer and a deny-all CSP', async () => {
    const base = await serve();
    for (const path of ['/health', '/client/install.sh', '/no-such-route']) {
      const res = await fetch(`${base}${path}`);
      expect(res.headers.get('strict-transport-security')).toBe(HSTS);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('content-security-policy')).toBe(DEFAULT_CSP);
      expect(res.headers.get('x-powered-by')).toBeNull();
    }
  });

  test('the installer is served as text, never as something a browser would sniff', async () => {
    const base = await serve();
    const res = await fetch(`${base}/client/install.sh`);
    expect(res.headers.get('content-type')).toStartWith('text/plain');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('X-Forwarded-Host cannot steer host-based routing', async () => {
    // `trust proxy` would make req.hostname read this client-supplied header.
    const base = await serve();
    const res = await fetch(`${base}/`, { headers: { 'X-Forwarded-Host': 'get.tnp.network' } });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toStartWith('application/json');
  });

  test('the parking page gets a strict CSP that allows only its own stylesheet', async () => {
    const facts: NameFacts = { kind: 'native', fqdn: 'nate.ox', tldCustom: true, domain: null };
    const base = await serve({ loadParkingFacts: async () => facts });
    const res = await fetch(`${base}/`, { headers: { Host: 'nate.ox' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');

    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toBe(PARKING_CSP);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/style-src 'sha256-[A-Za-z0-9+/]+=*'/);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('script-src');
    expect(csp).toContain("frame-ancestors 'none'");

    const html = await res.text();
    expect(html).toContain('<h1>nate.ox</h1>');
    expect(html).not.toContain('<script');
  });
});

describe('CORS', () => {
  test('the local web dev origin is allowed only outside production', () => {
    expect(corsOriginsFor(true)).not.toContain('http://localhost:8170');
    expect(corsOriginsFor(true).every((origin) => origin.startsWith('https://'))).toBe(true);
    expect(corsOriginsFor(false)).toContain('http://localhost:8170');
  });

  test('a production app does not answer a localhost origin', async () => {
    const base = await serve({ corsOrigins: corsOriginsFor(true) });
    const res = await fetch(`${base}/health`, { headers: { Origin: 'http://localhost:8170' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const ok = await fetch(`${base}/health`, { headers: { Origin: 'https://tnp.network' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://tnp.network');
  });
});

describe('rate limits', () => {
  test('/dns/resolve answers 429 with Retry-After once an address spends its burst', async () => {
    const base = await serve({
      limits: {
        ...generousLimits,
        addressTiers: { ...ADDRESS_TIERS, resolve: { capacity: 3, refillPerSecond: 0.01 } },
      },
    });
    for (let i = 0; i < 3; i++) {
      // Past the limiter; the absent database makes it a 500.
      expect((await quietFetch(`${base}/dns/resolve?name=a.ox`)).status).not.toBe(429);
    }
    const limited = await fetch(`${base}/dns/resolve?name=a.ox`);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(await limited.json()).toMatchObject({ error: 'rate_limited', limit: 'address:resolve' });

    // The liveness probe is never metered, or a busy address could get a
    // healthy task killed.
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  test('an exempt address is not metered per address', async () => {
    const base = await serve({
      limits: {
        ...generousLimits,
        exempt: ['127.0.0.1', '::1'],
        addressTiers: { ...ADDRESS_TIERS, resolve: { capacity: 1, refillPerSecond: 0.01 } },
      },
    });
    for (let i = 0; i < 5; i++) {
      expect((await quietFetch(`${base}/dns/resolve?name=a.ox`)).status).not.toBe(429);
    }
  });

  test('registrations are metered per account, across addresses', async () => {
    const base = await serve({
      limits: {
        ...generousLimits,
        userTiers: { register: { capacity: 2, refillPerSecond: 0.001 } },
      },
    });
    const register = (user: string) =>
      quietFetch(`${base}/domains/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-test-user': user },
        body: JSON.stringify({}),
      });
    // A malformed body is a 400 from the handler: past the limiter.
    expect((await register('alice')).status).toBe(400);
    expect((await register('alice')).status).toBe(400);
    const limited = await register('alice');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
    // Another account has its own budget.
    expect((await register('bob')).status).toBe(400);
  });

  test('the address limit runs before authentication', async () => {
    let authCalls = 0;
    const base = await serve({
      auth: (req, res, next) => {
        authCalls++;
        testAuth(req, res, next);
      },
      limits: {
        ...generousLimits,
        addressTiers: { ...ADDRESS_TIERS, read: { capacity: 1, refillPerSecond: 0.01 } },
      },
    });
    await quietFetch(`${base}/domains/search?q=a`);
    const callsAfterFirst = authCalls;
    expect((await fetch(`${base}/domains/search?q=a`)).status).toBe(429);
    expect(authCalls).toBe(callsAfterFirst);
  });
});

describe('request timeout', () => {
  test('a request still running after the timeout gets a 503, not an open connection', async () => {
    const base = await serve({
      requestTimeoutMs: 50,
      servicesRouter: (_req, res) => {
        // Answers far too late, as a handler stuck behind a busy pool would.
        setTimeout(() => res.json({ late: true }), 300);
      },
    });
    const res = await fetch(`${base}/services/anything`);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    expect(await res.json()).toMatchObject({ error: 'timeout' });
    // Let the late handler run: it must not throw on the finished response.
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
});
