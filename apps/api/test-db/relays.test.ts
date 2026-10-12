/**
 * The relay directory against a real server: who is published as Oxy-operated,
 * which relays are live, and the order clients see them in.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { encodeBase64, generateSigningKeyPair, signRelayRegistryProof } from '@tnp/crypto';
import type { RegisterRelayRequest } from '@tnp/shared-types';
import { relays } from '../src/db/schema/index.js';
import {
  listProvenCommunityRelays,
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
  return registration.status === 'ok' ? registration.registration : null;
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
    ).toEqual({ status: 'taken' });
  });

  test('an account may hold at most MAX_RELAYS_PER_ACCOUNT relays; re-registering one is not a new one', async () => {
    for (const n of [1, 2, 3]) await live(`wss://r${n}.example.test`, 'squatter');
    expect(
      await registerRelay(t.db, {
        request: request('wss://r4.example.test'),
        operatorUserId: 'squatter',
        oxyOperators: OXY,
      }),
    ).toEqual({ status: 'cap' });
    expect(
      (
        await registerRelay(t.db, {
          request: request('wss://r2.example.test'),
          operatorUserId: 'squatter',
          oxyOperators: OXY,
        })
      ).status,
    ).toBe('ok');
    // Concurrent registrations cannot all slip under the cap.
    await t.db.delete(relays);
    const results = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((n) =>
        registerRelay(t.db, {
          request: request(`wss://c${n}.example.test`),
          operatorUserId: 'racer',
          oxyOperators: OXY,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(3);
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

describe('key proofs and the signed directory', () => {
  const key = generateSigningKeyPair();
  const publicKey = encodeBase64(key.publicKey);
  const now = () => Math.floor(Date.now() / 1000);
  const proof = (purpose: 'register' | 'heartbeat', endpoint: string, issuedAt = now()) => ({
    issuedAt,
    signature: signRelayRegistryProof(
      { purpose, endpoint, relayKey: key.publicKey, issuedAt },
      key.secretKey,
    ),
  });

  async function proven(endpoint: string, operatorUserId: string) {
    await registerRelay(t.db, {
      request: { ...request(endpoint), publicKey },
      operatorUserId,
      oxyOperators: OXY,
      keyProven: true,
      liveChecked: true,
    });
    return recordRelayHeartbeat(t.db, {
      endpoint,
      operatorUserId,
      proof: proof('heartbeat', endpoint),
    });
  }

  test('only relays that proved their key are offered to the signed directory', async () => {
    expect(await proven('wss://proven.example.test', 'a')).toBe('ok');
    await live('wss://unproven.example.test', 'b');
    const listed = await listProvenCommunityRelays(t.db);
    expect(listed.map((r) => r.endpoint)).toEqual(['wss://proven.example.test']);
    expect(listed[0]?.publicKey).toBe(publicKey);
    // The legacy listing still has both.
    expect(await listRelayDirectory(t.db, { oxyOperators: OXY, operator: null })).toHaveLength(2);
  });

  test("a key proof without the registry's own live check does not list a relay", async () => {
    await registerRelay(t.db, {
      request: { ...request('wss://squat.example.test'), publicKey },
      operatorUserId: 'a',
      oxyOperators: OXY,
      keyProven: true,
      liveChecked: false,
    });
    await recordRelayHeartbeat(t.db, {
      endpoint: 'wss://squat.example.test',
      operatorUserId: 'a',
      proof: proof('heartbeat', 'wss://squat.example.test'),
      liveCheck: async () => false,
    });
    expect(await listProvenCommunityRelays(t.db)).toEqual([]);
    // A heartbeat whose live check passes lists it.
    const checked: string[] = [];
    await recordRelayHeartbeat(t.db, {
      endpoint: 'wss://squat.example.test',
      operatorUserId: 'a',
      proof: proof('heartbeat', 'wss://squat.example.test'),
      liveCheck: async (endpoint, key) => {
        checked.push(`${endpoint} ${key}`);
        return true;
      },
    });
    expect(checked).toEqual([`wss://squat.example.test ${publicKey}`]);
    expect((await listProvenCommunityRelays(t.db)).map((r) => r.endpoint)).toEqual([
      'wss://squat.example.test',
    ]);
    // And it is not re-checked on every heartbeat.
    await recordRelayHeartbeat(t.db, {
      endpoint: 'wss://squat.example.test',
      operatorUserId: 'a',
      proof: proof('heartbeat', 'wss://squat.example.test'),
      liveCheck: async () => {
        throw new Error('must not re-check yet');
      },
    });
    // A live check older than its validity drops it again.
    await t.db
      .update(relays)
      .set({ liveCheckedAt: sql`now() - interval '2 hours'` })
      .where(eq(relays.endpoint, 'wss://squat.example.test'));
    expect(await listProvenCommunityRelays(t.db)).toEqual([]);
  });

  test('a heartbeat does not mark proven a key the row no longer holds (re-registration race)', async () => {
    await proven('wss://race.example.test', 'a');
    // Both marks old, so the heartbeat re-checks (and the check is where the
    // test lands the concurrent re-registration).
    await t.db
      .update(relays)
      .set({
        keyProvenAt: sql`now() - interval '1 hour'`,
        liveCheckedAt: sql`now() - interval '1 hour'`,
      })
      .where(eq(relays.endpoint, 'wss://race.example.test'));
    const other = encodeBase64(generateSigningKeyPair().publicKey);
    // The re-registration lands between the heartbeat's read and its write.
    const outcome = await recordRelayHeartbeat(t.db, {
      endpoint: 'wss://race.example.test',
      operatorUserId: 'a',
      proof: proof('heartbeat', 'wss://race.example.test'),
      liveCheck: async () => {
        await t.db
          .update(relays)
          .set({ publicKey: other })
          .where(eq(relays.endpoint, 'wss://race.example.test'));
        return true;
      },
    });
    expect(outcome).toBe('not-found');
    const [row] = await t.db
      .select({ provenOld: sql<boolean>`${relays.keyProvenAt} < now() - interval '30 minutes'` })
      .from(relays)
      .where(eq(relays.endpoint, 'wss://race.example.test'));
    expect(row?.provenOld).toBe(true);
  });

  test('a heartbeat proof that does not verify against the registered key changes nothing', async () => {
    await proven('wss://relay.example.test', 'a');
    await t.db
      .update(relays)
      .set({ keyProvenAt: sql`now() - interval '1 hour'` })
      .where(eq(relays.endpoint, 'wss://relay.example.test'));
    const other = generateSigningKeyPair();
    const issuedAt = now();
    const forged = {
      issuedAt,
      signature: signRelayRegistryProof(
        {
          purpose: 'heartbeat',
          endpoint: 'wss://relay.example.test',
          relayKey: other.publicKey,
          issuedAt,
        },
        other.secretKey,
      ),
    };
    expect(
      await recordRelayHeartbeat(t.db, {
        endpoint: 'wss://relay.example.test',
        operatorUserId: 'a',
        proof: forged,
      }),
    ).toBe('bad-proof');
    expect(await listProvenCommunityRelays(t.db)).toEqual([]);
    // Another account's heartbeat for it is not found, proof or not.
    expect(
      await recordRelayHeartbeat(t.db, {
        endpoint: 'wss://relay.example.test',
        operatorUserId: 'b',
        proof: proof('heartbeat', 'wss://relay.example.test'),
      }),
    ).toBe('not-found');
  });

  test('a stale proof or a re-registration without one drops the relay from the directory', async () => {
    await proven('wss://relay.example.test', 'a');
    expect(await listProvenCommunityRelays(t.db)).toHaveLength(1);
    await t.db
      .update(relays)
      .set({
        keyProvenAt: sql`now() - make_interval(secs => ${RELAY_STALE_AFTER_SECONDS + 1})`,
      })
      .where(eq(relays.endpoint, 'wss://relay.example.test'));
    expect(await listProvenCommunityRelays(t.db)).toEqual([]);

    await proven('wss://relay.example.test', 'a');
    await registerRelay(t.db, {
      request: request('wss://relay.example.test'),
      operatorUserId: 'a',
      oxyOperators: OXY,
    });
    expect(await listProvenCommunityRelays(t.db)).toEqual([]);
  });
});
