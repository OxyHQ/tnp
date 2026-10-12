/**
 * Requests from TNP's WireGuard exits: every VPN user shares the exit's
 * address, so it is metered per Oxy account when authenticated and against a
 * larger shared tier otherwise — and never exempt.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AUTHENTICATED_PREFIXES,
  createNetworkLimits,
  EXIT_SHARED_MULTIPLIER,
} from './networkLimits';

const tier = { capacity: 2, refillPerSecond: 0.000001 };
const TIERS = { resolve: tier, read: tier, heartbeat: tier, register: tier, write: tier };

async function serve(exitAddresses: string[]): Promise<{ server: Server; base: string }> {
  const limits = createNetworkLimits({
    trustProxyHops: 0,
    trustCloudflareHeader: false,
    cloudflareIpRanges: [],
    exempt: [],
    vpnExitAddresses: exitAddresses,
    addressTiers: TIERS,
    userTiers: {},
    exitAuthAttemptTier: { capacity: 6, refillPerSecond: 0.000001 },
    now: () => 0,
  });
  const app = express();
  app.use(limits.perAddress);
  app.get('/dns/resolve', (_req, res) => {
    res.json({ ok: true });
  });
  // Stand-in for the optional Oxy auth: `Bearer user-<id>` authenticates, anything else does not.
  const auth: express.RequestHandler = (req, _res, next) => {
    const match = /^Bearer user-(\w+)$/.exec(req.get('authorization') ?? '');
    if (match) (req as OxyAuthRequest).userId = match[1];
    next();
  };
  app.use('/me', auth, limits.perUser, (_req, res) => {
    res.json({ ok: true });
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { server, base: `http://127.0.0.1:${address.port}` };
}

async function statuses(base: string, path: string, n: number, token?: string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${base}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    await res.body?.cancel();
    out.push(res.status);
  }
  return out;
}

const count = (list: number[], status: number) => list.filter((s) => s === status).length;

describe('requests from a VPN exit address', () => {
  let exit: { server: Server; base: string };
  let plain: { server: Server; base: string };

  beforeAll(async () => {
    // In these tests every request comes from 127.0.0.1.
    exit = await serve(['127.0.0.1']);
    plain = await serve([]);
  });
  afterAll(() => {
    exit.server.close();
    plain.server.close();
  });

  test('an ordinary address gets the ordinary tier', async () => {
    expect(count(await statuses(plain.base, '/dns/resolve', 5), 200)).toBe(2);
  });

  test('anonymous users of an exit share a larger tier, and are still limited', async () => {
    const got = await statuses(exit.base, '/dns/resolve', 2 * EXIT_SHARED_MULTIPLIER + 3);
    expect(count(got, 200)).toBe(2 * EXIT_SHARED_MULTIPLIER);
    expect(count(got, 429)).toBe(3);
  });

  test('each authenticated user of an exit has an own budget, unaffected by the others', async () => {
    const alice = await statuses(exit.base, '/me/x', 3, 'user-alice');
    const bob = await statuses(exit.base, '/me/x', 2, 'user-bob');
    expect(alice).toEqual([200, 200, 429]);
    expect(bob).toEqual([200, 200]);
  });

  test('made-up tokens are bounded before validation, then charged as anonymous', async () => {
    const fresh = await serve(['127.0.0.1']);
    try {
      // 6 validation attempts, then the shared anonymous tier (40 reads here).
      const got = await statuses(fresh.base, '/me/x', 2 * EXIT_SHARED_MULTIPLIER + 10, 'fake');
      expect(count(got, 200)).toBe(2 * EXIT_SHARED_MULTIPLIER);
      // A real user of the same exit is refused only because that shared tier
      // is now empty too; it was never blocked by the validation budget alone.
      expect(await statuses(fresh.base, '/me/x', 1, 'user-carol')).toEqual([429]);
    } finally {
      fresh.server.close();
    }
  });

  test('when only the validation budget is spent, signed-in users still get through', async () => {
    const fresh = await serve(['127.0.0.1']);
    try {
      await statuses(fresh.base, '/me/x', 6, 'fake'); // spends the validation budget; 6 shared reads
      expect(await statuses(fresh.base, '/me/x', 1, 'user-erin')).toEqual([200]);
    } finally {
      fresh.server.close();
    }
  });

  test('a bearer header on a public route does not escape metering', async () => {
    const fresh = await serve(['127.0.0.1']);
    try {
      const got = await statuses(
        fresh.base,
        '/dns/resolve',
        2 * EXIT_SHARED_MULTIPLIER + 1,
        'user-dave',
      );
      expect(count(got, 429)).toBe(1);
    } finally {
      fresh.server.close();
    }
  });
});

test('AUTHENTICATED_PREFIXES is exactly what app.ts mounts behind auth and perUser', () => {
  const source = readFileSync(join(import.meta.dir, '..', 'app.ts'), 'utf8');
  const mounted = [...source.matchAll(/app\.use\('([^']+)', auth, limits\.perUser/g)].map(
    (m) => m[1],
  );
  expect(mounted.sort()).toEqual([...AUTHENTICATED_PREFIXES].sort());
});
