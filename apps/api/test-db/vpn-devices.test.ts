/**
 * WireGuard VPN devices against a real server: address allocation and the
 * per-account cap under concurrency (an advisory lock and two unique indexes
 * are server behaviour), owner isolation, and the exit peer listing — through
 * the shipped statements and through the real routers.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import { generateWireGuardKeyPair } from '@tnp/crypto/wireguard';
import {
  isVpnDeviceIpv4,
  parseExitPeersResponse,
  type VpnDeviceList,
  type VpnDeviceResponse,
  vpnIpv6ForIpv4,
} from '@tnp/shared-types';
import { vpnAddressQuarantine, vpnDevices } from '../src/db/schema/index.js';
import {
  createVpnDevice,
  deleteVpnDevice,
  listExitPeers,
  listVpnDevices,
  renameVpnDevice,
} from '../src/registry/vpnDevices.js';
import { createExitRouter } from '../src/routes/exit.js';
import { createMeRouter } from '../src/routes/me.js';
import { digestToken, type VpnConfig } from '../src/vpn.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.delete(vpnDevices);
  await t.db.delete(vpnAddressQuarantine);
});

const key = () => generateWireGuardKeyPair().publicKey;
const device = (name = 'phone') => ({ name, publicKey: key() });
const CAP = { maxDevices: 10 };

describe('createVpnDevice', () => {
  test('allocates a pool address and stores only the contract fields', async () => {
    const result = await createVpnDevice(t.db, 'alice', device('Home router'), CAP);
    if (!result.ok) throw new Error(result.code);
    expect(isVpnDeviceIpv4(result.device.ipv4)).toBe(true);
    expect(result.device.ipv6).toBe(vpnIpv6ForIpv4(result.device.ipv4));
    expect(result.device.name).toBe('Home router');

    const columns = await t.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'vpn_devices'
      order by column_name`;
    expect(columns.map((c) => c.column_name)).toEqual([
      'address',
      'created_at',
      'id',
      'name',
      'oxy_user_id',
      'public_key',
    ]);
  });

  test('a public key is one device, across accounts', async () => {
    const shared = device();
    expect((await createVpnDevice(t.db, 'alice', shared, CAP)).ok).toBe(true);
    expect(await createVpnDevice(t.db, 'bob', shared, CAP)).toEqual({
      ok: false,
      code: 'public_key_in_use',
    });
    expect(await createVpnDevice(t.db, 'alice', shared, CAP)).toEqual({
      ok: false,
      code: 'public_key_in_use',
    });
  });

  test('an address clash draws again instead of failing', async () => {
    const draws = [100, 100, 100, 101];
    expect(
      (await createVpnDevice(t.db, 'alice', device(), { ...CAP, drawIndex: () => 100 })).ok,
    ).toBe(true);
    const second = await createVpnDevice(t.db, 'bob', device(), {
      ...CAP,
      drawIndex: () => draws.shift() ?? 102,
    });
    expect(second.ok && second.device.ipv4).toBe('10.77.0.101');
  });

  test('a pool with no free draw answers address_pool_exhausted', async () => {
    await createVpnDevice(t.db, 'alice', device(), { ...CAP, drawIndex: () => 7 });
    expect(await createVpnDevice(t.db, 'bob', device(), { ...CAP, drawIndex: () => 7 })).toEqual({
      ok: false,
      code: 'address_pool_exhausted',
    });
  });

  test('concurrent creates from many accounts never share an address, even on colliding draws', async () => {
    // Twelve draws over eight addresses: collisions are guaranteed, and every
    // one must be resolved by a fresh draw rather than a duplicate or an error.
    let n = 0;
    const drawIndex = () => 200 + (n++ % 8);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createVpnDevice(t.db, `user-${i}`, device(), { ...CAP, drawIndex }),
      ),
    );
    const addresses = results.map((r) => (r.ok ? r.device.ipv4 : r.code));
    expect(new Set(addresses).size).toBe(8);
    expect(addresses.every((a) => isVpnDeviceIpv4(a))).toBe(true);

    const random = await Promise.all(
      Array.from({ length: 40 }, (_, i) => createVpnDevice(t.db, `random-${i}`, device(), CAP)),
    );
    expect(random.every((r) => r.ok)).toBe(true);
    const [{ total, distinct }] = await t.sql<{ total: number; distinct: number }[]>`
      select count(*)::int as total, count(distinct address)::int as distinct from vpn_devices`;
    expect({ total, distinct }).toEqual({ total: 48, distinct: 48 });
  });

  test('the cap holds against concurrent creates from one account', async () => {
    const results = await Promise.all(
      Array.from({ length: 15 }, () => createVpnDevice(t.db, 'alice', device(), CAP)),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(results.filter((r) => !r.ok)).toEqual(
      Array.from({ length: 5 }, () => ({ ok: false, code: 'device_limit' })),
    );
    expect(await listVpnDevices(t.db, 'alice')).toHaveLength(10);
    // Another account is unaffected.
    expect((await createVpnDevice(t.db, 'bob', device(), CAP)).ok).toBe(true);
  });
});

describe('address quarantine', () => {
  test('the address of a revoked device is held for 24 h, keeping only address and time', async () => {
    const first = await createVpnDevice(t.db, 'alice', device(), { ...CAP, drawIndex: () => 300 });
    if (!first.ok) throw new Error(first.code);
    expect(await deleteVpnDevice(t.db, 'alice', first.device.id)).toBe(true);

    const rows = await t.sql<Record<string, unknown>[]>`select * from vpn_address_quarantine`;
    expect(rows.map((r) => Object.keys(r).sort())).toEqual([['address', 'released_at']]);
    expect(rows[0]?.address).toBe(first.device.ipv4);

    // Only that address is ever drawn: it is held, so the pool reads as exhausted.
    expect(await createVpnDevice(t.db, 'bob', device(), { ...CAP, drawIndex: () => 300 })).toEqual({
      ok: false,
      code: 'address_pool_exhausted',
    });
    // Other addresses are unaffected.
    const draws = [300, 301];
    const other = await createVpnDevice(t.db, 'bob', device(), {
      ...CAP,
      drawIndex: () => draws.shift() ?? 302,
    });
    expect(other.ok && other.device.ipv4).toBe('10.77.1.45');
  });

  test('after the hold the address is reusable and its quarantine row is deleted', async () => {
    await t.db.insert(vpnAddressQuarantine).values({ address: '10.77.1.44' });
    await t.sql`update vpn_address_quarantine set released_at = now() - interval '25 hours'`;
    const reused = await createVpnDevice(t.db, 'carol', device(), { ...CAP, drawIndex: () => 300 });
    expect(reused.ok && reused.device.ipv4).toBe('10.77.1.44');
    expect(await t.sql`select 1 from vpn_address_quarantine`).toHaveLength(0);
  });

  test('a delete racing a create never hands out the freed address', async () => {
    const victim = await createVpnDevice(t.db, 'alice', device(), { ...CAP, drawIndex: () => 400 });
    if (!victim.ok) throw new Error(victim.code);
    const [, raced] = await Promise.all([
      deleteVpnDevice(t.db, 'alice', victim.device.id),
      createVpnDevice(t.db, 'bob', device(), { ...CAP, drawIndex: () => 400 }),
    ]);
    expect(raced).toEqual({ ok: false, code: 'address_pool_exhausted' });
  });
});

describe('rename, delete and isolation', () => {
  test('an owner can rename and delete their own device, nobody else can', async () => {
    const created = await createVpnDevice(t.db, 'alice', device('old'), CAP);
    if (!created.ok) throw new Error(created.code);
    const id = created.device.id;

    expect(await renameVpnDevice(t.db, 'bob', id, 'stolen')).toBeNull();
    expect(await deleteVpnDevice(t.db, 'bob', id)).toBe(false);
    expect(await listVpnDevices(t.db, 'bob')).toEqual([]);

    const renamed = await renameVpnDevice(t.db, 'alice', id, 'new');
    expect(renamed).toEqual({ ...created.device, name: 'new' });

    expect(await deleteVpnDevice(t.db, 'alice', id)).toBe(true);
    expect(await deleteVpnDevice(t.db, 'alice', id)).toBe(false);
    expect(await listExitPeers(t.db)).toEqual([]);
  });

  test("the exits' peer list holds only allowlisted accounts' devices", async () => {
    const a = await createVpnDevice(t.db, 'alice', device('a'), CAP);
    const b = await createVpnDevice(t.db, 'bob', device('b'), CAP);
    if (!a.ok || !b.ok) throw new Error('create failed');
    const keys = async (allowed: string[] | null) =>
      (await listExitPeers(t.db, allowed)).map((p) => p.publicKey).sort();
    expect(await keys(null)).toEqual([a.device.publicKey, b.device.publicKey].sort());
    expect(await keys(['alice'])).toEqual([a.device.publicKey]);
    expect(await keys(['carol'])).toEqual([]);
    expect(await keys([])).toEqual([]);
    await deleteVpnDevice(t.db, 'alice', a.device.id);
    await deleteVpnDevice(t.db, 'bob', b.device.id);
  });
});

describe('through the real routers', () => {
  const EXIT_TOKEN = 'x'.repeat(48);
  const config: VpnConfig = {
    exits: [
      {
        id: 'usw2-1',
        region: 'us-west-2',
        endpoint: 'usw2-1.exit.example:51820',
        endpointIp: '203.0.113.10',
        publicKey: key(),
      },
    ],
    dns: ['198.51.100.53'],
    exitTokenDigests: [digestToken(EXIT_TOKEN)],
    maxDevices: 2,
    allowedUsers: null,
  };
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/me', (req, _res, next) => {
      (req as OxyAuthRequest).userId = req.get('x-test-user') ?? 'alice';
      next();
    });
    app.use(
      '/me',
      createMeRouter(
        () => t.db,
        () => config,
      ),
    );
    app.use('/exit', createExitRouter({ db: () => t.db, vpn: () => config }));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const post = (body: unknown, user = 'alice') =>
    fetch(`${base}/me/vpn/devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Test-User': user },
      body: JSON.stringify(body),
    });

  test('register, list, cap, conflict, revoke — and the exit sees keys and addresses only', async () => {
    const first = await post(device('router'));
    expect(first.status).toBe(201);
    const created = (await first.json()) as VpnDeviceResponse;
    expect(created.network).toEqual({
      exits: config.exits,
      dns: ['198.51.100.53'],
      allowedIPs: ['0.0.0.0/0', '::/0'],
      maxDevices: 2,
    });

    const again = await post({ name: 'dup', publicKey: created.device.publicKey }, 'bob');
    expect(again.status).toBe(409);
    expect(((await again.json()) as { code: string }).code).toBe('public_key_in_use');

    expect((await post(device('laptop'))).status).toBe(201);
    const capped = await post(device('third'));
    expect(capped.status).toBe(409);
    expect(((await capped.json()) as { code: string }).code).toBe('device_limit');

    const list = (await (
      await fetch(`${base}/me/vpn/devices`, { headers: { 'X-Test-User': 'alice' } })
    ).json()) as VpnDeviceList;
    expect(list.devices.map((d) => d.name)).toEqual(['router', 'laptop']);

    const peersRes = await fetch(`${base}/exit/peers`, {
      headers: { Authorization: `Bearer ${EXIT_TOKEN}` },
    });
    expect(peersRes.status).toBe(200);
    const raw = (await peersRes.json()) as { peers: Array<Record<string, unknown>> };
    for (const peer of raw.peers)
      expect(Object.keys(peer).sort()).toEqual(['ipv4', 'ipv6', 'publicKey']);
    const parsed = parseExitPeersResponse(raw);
    expect(parsed.ok && parsed.value.rejected).toBe(0);
    expect(parsed.ok && parsed.value.peers.map((p) => p.publicKey).sort()).toEqual(
      list.devices.map((d) => d.publicKey).sort(),
    );

    const del = await fetch(`${base}/me/vpn/devices/${created.device.id}`, {
      method: 'DELETE',
      headers: { 'X-Test-User': 'alice' },
    });
    expect(del.status).toBe(204);
    const after = parseExitPeersResponse(
      await (
        await fetch(`${base}/exit/peers`, { headers: { Authorization: `Bearer ${EXIT_TOKEN}` } })
      ).json(),
    );
    expect(after.ok && after.value.peers.map((p) => p.publicKey)).not.toContain(
      created.device.publicKey,
    );
  });
});
