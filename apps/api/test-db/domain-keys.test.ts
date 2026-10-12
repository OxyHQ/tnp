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
import { and, eq } from 'drizzle-orm';
import { domains, serviceNodes } from '../src/db/schema/index.js';
import {
  DEFAULT_RESET_HOLD_SECONDS,
  lookupDomainKey,
  registerDomainKey,
  tombstoneDomainKey,
} from '../src/registry/domainKeys.js';
import { registerServiceNode } from '../src/registry/nodes.js';
import { domainKeyFingerprint, verifyKeyAgreementCertificate } from '@tnp/crypto';
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

const register = (
  name: string,
  domainKey: string,
  rot?: DomainKeyRotation,
  userId = OWNER,
  now = NOW,
) =>
  registerDomainKey(t.db, {
    userId,
    request: rot ? { name, domainKey, rotation: rot } : { name, domainKey },
    now,
  });

/** What `DELETE /domains/:id` does: tombstone the key, delete the row, in one transaction. */
async function release(label: string): Promise<void> {
  const [row] = await t.db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.name, label), eq(domains.tld, 'ox')));
  await t.db.transaction(async (tx) => {
    await tombstoneDomainKey(tx, row.id);
    await tx.delete(domains).where(eq(domains.id, row.id));
  });
}

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

describe('release and re-registration cannot reset a key quietly', () => {
  const original = key();

  test('a released name keeps its key: an unrelated key is refused during the hold', async () => {
    await seedDomain(t.db, { name: 'released', oxyUserId: OWNER });
    expect((await register('released.ox', original.b64)).status).toBe(201);
    await release('released');
    // Anyone — the same session or a new owner — registers the name again.
    await seedDomain(t.db, { name: 'released', oxyUserId: 'new-owner' });
    const attempt = await register(
      'released.ox',
      key().b64,
      undefined,
      'new-owner',
      Math.floor(Date.now() / 1000),
    );
    expect(attempt.status).toBe(403);
    expect('error' in attempt ? attempt.error : '').toContain(
      'rotation statement signed by that key',
    );
    expect(await lookupDomainKey(t.db, 'released.ox')).toBeNull();
  });

  test('the released key itself is accepted again, with its history', async () => {
    expect(await register('released.ox', original.b64, undefined, 'new-owner')).toEqual({
      status: 201,
      record: { name: 'released.ox', domainKey: original.b64, rotations: [] },
    });
  });

  test('a new key with a rotation signed by the released key is accepted, unmarked', async () => {
    await seedDomain(t.db, { name: 'handover', oxyUserId: OWNER });
    expect((await register('handover.ox', original.b64)).status).toBe(201);
    await release('handover');
    await seedDomain(t.db, { name: 'handover', oxyUserId: OWNER });
    const next = key();
    const rot = rotation('handover.ox', original, next, NOW);
    const result = await register('handover.ox', next.b64, rot);
    expect(result).toEqual({
      status: 201,
      record: { name: 'handover.ox', domainKey: next.b64, rotations: [rot] },
    });
  });

  test('after the hold, an unrelated key is accepted but published as a reset', async () => {
    await seedDomain(t.db, { name: 'abandoned', oxyUserId: OWNER });
    expect((await register('abandoned.ox', original.b64)).status).toBe(201);
    await release('abandoned');
    await seedDomain(t.db, { name: 'abandoned', oxyUserId: 'new-owner' });
    const later = Math.floor(Date.now() / 1000) + DEFAULT_RESET_HOLD_SECONDS + 60;
    const fresh = key();
    const result = await register('abandoned.ox', fresh.b64, undefined, 'new-owner', later);
    expect(result.status).toBe(201);
    const record = await lookupDomainKey(t.db, 'abandoned.ox');
    expect(record?.domainKey).toBe(fresh.b64);
    expect(record?.keyReset?.previousKeyFingerprint).toBe(domainKeyFingerprint(original.b64));
  });

  test('a name withheld after expiry publishes no key, as resolve withholds it', async () => {
    await seedDomain(t.db, { name: 'lapsed', oxyUserId: OWNER, expiresAt: new Date('2000-01-01') });
    expect((await register('lapsed.ox', key().b64)).status).toBe(201);
    expect(
      await lookupDomainKey(t.db, 'lapsed.ox', { expiryEnforced: true, now: new Date() }),
    ).toBeNull();
    expect(
      await lookupDomainKey(t.db, 'lapsed.ox', { expiryEnforced: false, now: new Date() }),
    ).not.toBeNull();
  });
});

describe('node registration cannot land under a retired key', () => {
  test('racing a rotation, the stored chain always verifies against the current key', async () => {
    for (let i = 0; i < 8; i++) {
      const label = `race${i}`;
      const domain = await seedDomain(t.db, { name: label, oxyUserId: OWNER });
      const oldKey = key();
      const newKey = key();
      expect((await register(`${label}.ox`, oldKey.b64)).status).toBe(201);
      const creds = makeTestCredentials(`${label}.ox`, { domainKey: oldKey });
      const now = Math.floor(Date.now() / 1000);
      await Promise.all([
        registerServiceNode(t.db, {
          userId: OWNER,
          domainId: domain.id,
          chain: creds.chain,
          kaCert: creds.kaCert,
          now,
        }),
        register(`${label}.ox`, newKey.b64, rotation(`${label}.ox`, oldKey, newKey, now)),
      ]);
      const [row] = await t.db
        .select({ chain: serviceNodes.chain, kaCert: serviceNodes.kaCert })
        .from(serviceNodes)
        .where(eq(serviceNodes.domainId, domain.id));
      const current = (await lookupDomainKey(t.db, `${label}.ox`))?.domainKey;
      expect(current).toBe(newKey.b64);
      if (row?.kaCert && row.chain.length > 0) {
        const verified = verifyKeyAgreementCertificate(row.kaCert, row.chain, {
          trustedRoots: [current as string],
          role: 'service-node',
          name: `${label}.ox`,
          now,
        });
        expect(verified.ok).toBe(true);
      }
    }
  });

  test('a chain under a key that is no longer current is refused', async () => {
    const domain = await seedDomain(t.db, { name: 'stale', oxyUserId: OWNER });
    const oldKey = key();
    const newKey = key();
    expect((await register('stale.ox', oldKey.b64)).status).toBe(201);
    expect(
      (await register('stale.ox', newKey.b64, rotation('stale.ox', oldKey, newKey, NOW))).status,
    ).toBe(200);
    const creds = makeTestCredentials('stale.ox', { domainKey: oldKey });
    const outcome = await registerServiceNode(t.db, {
      userId: OWNER,
      domainId: domain.id,
      chain: creds.chain,
      kaCert: creds.kaCert,
      now: Math.floor(Date.now() / 1000),
    });
    expect(outcome.status).toBe(422);
  });
});
