/**
 * Domain keys against a real registry: first registration, signed rotation,
 * and every way a replacement without the current key's signature is refused.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  type DomainKeyRotation,
  encodeBase64,
  generateSigningKeyPair,
  MAX_DOMAIN_KEY_ROTATIONS,
  signDomainKeyRotation,
} from '@tnp/crypto';
import { makeTestCredentials } from '@tnp/crypto/testing';
import { eq } from 'drizzle-orm';
import { serviceNodes } from '../src/db/schema/index.js';
import { lookupDomainKey, registerDomainKey } from '../src/registry/domainKeys.js';
import { seedDomain, seedTld } from './fixtures.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const OWNER = 'owner-under-test';
const NOW = 1_800_000_000;

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  await seedTld(t.db, 'ox');
  await seedDomain(t.db, { name: 'keyed', oxyUserId: OWNER });
  await seedDomain(t.db, { name: 'history', oxyUserId: OWNER });
  await seedDomain(t.db, { name: 'theirs', oxyUserId: 'someone-else' });
});

afterAll(async () => {
  await t.drop();
});

function key() {
  const kp = generateSigningKeyPair();
  return { ...kp, b64: encodeBase64(kp.publicKey) };
}

function rotation(
  name: string,
  from: ReturnType<typeof key>,
  to: ReturnType<typeof key>,
  issuedAt: number,
): DomainKeyRotation {
  return signDomainKeyRotation(
    { name, previousKey: from.b64, nextKey: to.b64, issuedAt },
    from.secretKey,
  );
}

const register = (name: string, domainKey: string, rot?: DomainKeyRotation, userId = OWNER) =>
  registerDomainKey(t.db, {
    userId,
    request: rot ? { name, domainKey, rotation: rot } : { name, domainKey },
    now: NOW,
  });

describe('domain keys', () => {
  const a = key();
  const b = key();
  const c = key();

  test('the owner registers the first key; the record is public', async () => {
    expect(await register('keyed.ox', a.b64)).toEqual({
      status: 201,
      record: { name: 'keyed.ox', domainKey: a.b64, rotations: [] },
    });
    expect(await lookupDomainKey(t.db, 'keyed.ox')).toEqual({
      name: 'keyed.ox',
      domainKey: a.b64,
      rotations: [],
    });
    // Re-registering the same key is idempotent.
    expect((await register('keyed.ox', a.b64)).status).toBe(200);
  });

  test('only the owner may register', async () => {
    expect(await register('theirs.ox', a.b64)).toMatchObject({ status: 403 });
    expect(await register('missing.ox', a.b64)).toMatchObject({ status: 404 });
  });

  test('a replacement without a statement signed by the current key is refused', async () => {
    expect(await register('keyed.ox', b.b64)).toMatchObject({ status: 403 });
    // Signed by the wrong key (the new one vouching for itself).
    const selfSigned = signDomainKeyRotation(
      { name: 'keyed.ox', previousKey: b.b64, nextKey: c.b64, issuedAt: NOW },
      b.secretKey,
    );
    expect(await register('keyed.ox', c.b64, selfSigned)).toMatchObject({ status: 403 });
    // Signed by the current key, but for another name or to another key.
    expect(await register('keyed.ox', b.b64, rotation('other.ox', a, b, NOW))).toMatchObject({
      status: 403,
    });
    expect(await register('keyed.ox', b.b64, rotation('keyed.ox', a, c, NOW))).toMatchObject({
      status: 403,
    });
    // Too far in the future.
    expect(await register('keyed.ox', b.b64, rotation('keyed.ox', a, b, NOW + 3600))).toMatchObject(
      { status: 403 },
    );
    expect((await lookupDomainKey(t.db, 'keyed.ox'))?.domainKey).toBe(a.b64);
  });

  test('a signed rotation is accepted and recorded; a stale one is not', async () => {
    const ab = rotation('keyed.ox', a, b, NOW);
    expect(await register('keyed.ox', b.b64, ab)).toEqual({
      status: 200,
      record: { name: 'keyed.ox', domainKey: b.b64, rotations: [ab] },
    });
    // b → c issued no later than a → b: refused.
    expect(await register('keyed.ox', c.b64, rotation('keyed.ox', b, c, NOW))).toMatchObject({
      status: 403,
    });
    const bc = rotation('keyed.ox', b, c, NOW + 1);
    expect(await register('keyed.ox', c.b64, bc)).toMatchObject({ status: 200 });
    expect(await lookupDomainKey(t.db, 'keyed.ox')).toEqual({
      name: 'keyed.ox',
      domainKey: c.b64,
      rotations: [ab, bc],
    });
  });

  test('a rotation stops publishing key material chained under the old key', async () => {
    const domain = await seedDomain(t.db, { name: 'retire', oxyUserId: OWNER });
    const creds = makeTestCredentials('retire.ox', { domainKey: a });
    expect((await register('retire.ox', a.b64)).status).toBe(201);
    await t.db.insert(serviceNodes).values({
      domainId: domain.id,
      oxyUserId: OWNER,
      publicKey: creds.kaCert.signer,
      chain: creds.chain,
      kaCert: creds.kaCert,
    });
    expect(await register('retire.ox', b.b64, rotation('retire.ox', a, b, NOW))).toMatchObject({
      status: 200,
    });
    const [node] = await t.db
      .select({ chain: serviceNodes.chain, kaCert: serviceNodes.kaCert })
      .from(serviceNodes)
      .where(eq(serviceNodes.domainId, domain.id));
    expect(node).toEqual({ chain: [], kaCert: null });
  });

  test('a rotation with no key yet is refused', async () => {
    expect(await register('history.ox', b.b64, rotation('history.ox', a, b, NOW))).toMatchObject({
      status: 400,
    });
  });

  test('the history keeps only the most recent statements', async () => {
    let current = key();
    expect((await register('history.ox', current.b64)).status).toBe(201);
    for (let i = 0; i < MAX_DOMAIN_KEY_ROTATIONS + 2; i++) {
      const next = key();
      const result = await register(
        'history.ox',
        next.b64,
        rotation('history.ox', current, next, NOW - 1000 + i),
      );
      expect(result.status).toBe(200);
      current = next;
    }
    const record = await lookupDomainKey(t.db, 'history.ox');
    expect(record?.domainKey).toBe(current.b64);
    expect(record?.rotations).toHaveLength(MAX_DOMAIN_KEY_ROTATIONS);
  });
});
