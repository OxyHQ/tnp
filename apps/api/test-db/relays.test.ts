/**
 * The relay directory against a real server: who is published as Oxy-operated,
 * which relays are live, and the order clients see them in.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import type { RegisterRelayRequest } from '@tnp/shared-types';
import { relays } from '../src/db/schema/index.js';
import {
  listRelayDirectory,
  RELAY_STALE_AFTER_SECONDS,
  recordRelayHeartbeat,
  registerRelay,
} from '../src/registry/relays.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.delete(relays);
});

const OXY = new Set(['oxy-staff']);

function request(endpoint: string): RegisterRelayRequest {
  return {
    endpoint,
    publicKey: 'Zm9vYmFyLXB1YmxpYy1rZXk=',
    capacity: { maxConnections: 100, bandwidth: 0 },
    location: '',
  };
}

/** Register and heartbeat: what a running relay does before it is listed. */
async function live(endpoint: string, operatorUserId: string) {
  const registration = await registerRelay(t.db, {
    request: request(endpoint),
    operatorUserId,
    oxyOperators: OXY,
  });
  await recordRelayHeartbeat(t.db, { endpoint, operatorUserId });
  return registration;
}

describe('operator', () => {
  test('is decided by the allowlist, not by the relay', async () => {
    const community = await live('wss://anyone.example.test', 'some-account');
    const oxy = await live('wss://oxy.example.test', 'oxy-staff');
    expect(community?.operator).toBe('community');
    expect(oxy?.operator).toBe('oxy');

    const [stored] = await t.db
      .select({ operator: relays.operator })
      .from(relays)
      .where(eq(relays.endpoint, 'wss://anyone.example.test'));
    expect(stored?.operator).toBe('community');
  });

  test('a row that claimed oxy before the registry decided is listed as community', async () => {
    // Written the way the old route wrote it: the relay said `oxy` and the
    // registry believed it.
    await t.db.insert(relays).values({
      endpoint: 'wss://impostor.example.test',
      publicKey: 'Zm9vYmFyLXB1YmxpYy1rZXk=',
      operator: 'oxy',
      operatorUserId: 'some-account',
      maxConnections: 100,
      bandwidth: 0,
      status: 'active',
      lastSeen: sql`now()`,
    });

    const directory = await listRelayDirectory(t.db, { oxyOperators: OXY, operator: null });
    expect(directory.map((r) => [r.endpoint, r.operator])).toEqual([
      ['wss://impostor.example.test', 'community'],
    ]);
    expect(await listRelayDirectory(t.db, { oxyOperators: OXY, operator: 'oxy' })).toEqual([]);
  });

  test('with an empty allowlist there are no Oxy relays at all', async () => {
    await live('wss://oxy.example.test', 'oxy-staff');
    const none = new Set<string>();
    expect(await listRelayDirectory(t.db, { oxyOperators: none, operator: 'oxy' })).toEqual([]);
    const all = await listRelayDirectory(t.db, { oxyOperators: none, operator: null });
    expect(all.map((r) => r.operator)).toEqual(['community']);
  });

  test("re-registering another account's endpoint is refused", async () => {
    await live('wss://taken.example.test', 'first');
    expect(
      await registerRelay(t.db, {
        request: request('wss://taken.example.test'),
        operatorUserId: 'oxy-staff',
        oxyOperators: OXY,
      }),
    ).toBeNull();
  });
});

describe('liveness', () => {
  test('a registered relay is not listed until it heartbeats', async () => {
    await registerRelay(t.db, {
      request: request('wss://quiet.example.test'),
      operatorUserId: 'a',
      oxyOperators: OXY,
    });
    expect(await listRelayDirectory(t.db, { oxyOperators: OXY, operator: null })).toEqual([]);
  });

  test('a relay whose last heartbeat is stale is excluded, whatever its stored status', async () => {
    await live('wss://fresh.example.test', 'a');
    await live('wss://stale.example.test', 'b');
    await t.db
      .update(relays)
      .set({ lastSeen: sql`now() - make_interval(secs => ${RELAY_STALE_AFTER_SECONDS + 1})` })
      .where(eq(relays.endpoint, 'wss://stale.example.test'));

    const directory = await listRelayDirectory(t.db, { oxyOperators: OXY, operator: null });
    expect(directory.map((r) => r.endpoint)).toEqual(['wss://fresh.example.test']);

    // A heartbeat brings it back.
    await recordRelayHeartbeat(t.db, { endpoint: 'wss://stale.example.test', operatorUserId: 'b' });
    const again = await listRelayDirectory(t.db, { oxyOperators: OXY, operator: null });
    expect(again).toHaveLength(2);
  });
});

describe('order', () => {
  test('Oxy-operated first, then by tenure — never by endpoint string', async () => {
    // Registered in this order; the community endpoints are chosen so that a
    // sort by endpoint string would put the newest first.
    await live('wss://zzz-oldest.example.test', 'a');
    await live('wss://mmm-middle.example.test', 'b');
    await live('wss://aaa-newest.example.test', 'c');
    await live('wss://oxy.example.test', 'oxy-staff');

    const directory = await listRelayDirectory(t.db, { oxyOperators: OXY, operator: null });
    expect(directory.map((r) => r.endpoint)).toEqual([
      'wss://oxy.example.test',
      'wss://zzz-oldest.example.test',
      'wss://mmm-middle.example.test',
      'wss://aaa-newest.example.test',
    ]);
  });

  test('the listing publishes no account and no timestamp', async () => {
    await live('wss://relay.example.test', 'secret-account');
    const [entry] = await listRelayDirectory(t.db, { oxyOperators: OXY, operator: null });
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      ['endpoint', 'location', 'operator', 'publicKey', 'status'].sort(),
    );
    expect(JSON.stringify(entry)).not.toContain('secret-account');
  });
});
