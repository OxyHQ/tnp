/**
 * The public directory and search against a real server: unlisted names are
 * hidden from browsing and nowhere else.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  listPublicDomains,
  searchPublicDomains,
  updateDomainSettings,
} from '../src/registry/domains.js';
import { decideResolution, loadNameFacts } from '../src/registry/resolve.js';
import { dnsRecords } from '../src/db/schema/index.js';
import { seedDomain, seedTld } from './fixtures.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
  await seedTld(t.db, 'ox');
});

afterAll(async () => {
  await t.drop();
});

describe('unlisted names', () => {
  test('are excluded from the directory and search but still resolve', async () => {
    const listed = await seedDomain(t.db, { name: 'listedname', oxyUserId: 'owner-a' });
    const hidden = await seedDomain(t.db, { name: 'hiddenname', oxyUserId: 'owner-b' });
    await t.db
      .insert(dnsRecords)
      .values({ domainId: hidden.id, type: 'A', name: '@', value: '192.0.2.10', ttl: 300 });

    // The owner unlists it.
    const outcome = await updateDomainSettings(t.db, {
      domainId: hidden.id,
      oxyUserId: 'owner-b',
      unlisted: true,
    });
    expect(outcome.ok && outcome.domain.unlisted).toBe(true);

    const page = await listPublicDomains(t.db, { page: 1, limit: 50 });
    const names = page.rows.map((row) => row.name);
    expect(names).toContain(listed.name);
    expect(names).not.toContain('hiddenname');
    expect(page.total).toBe(page.rows.length);

    expect(
      (await searchPublicDomains(t.db, { query: 'name', limit: 50 })).map((r) => r.name),
    ).toEqual(['listedname']);
    expect(await searchPublicDomains(t.db, { query: 'hidden', limit: 50 })).toEqual([]);

    // Resolution is unaffected: unlisting hides a name from browsing, not from
    // anyone who already knows it.
    const answer = decideResolution(await loadNameFacts(t.db, 'hiddenname.ox'), 'A', {
      parkingIp: '',
      expiryEnforced: false,
      now: new Date(),
    });
    expect(answer.rcode).toBe('NOERROR');
    expect(answer.answers.map((a) => a.value)).toEqual(['192.0.2.10']);

    // And the owner can list it again.
    await updateDomainSettings(t.db, {
      domainId: hidden.id,
      oxyUserId: 'owner-b',
      unlisted: false,
    });
    const relisted = await listPublicDomains(t.db, { page: 1, limit: 50 });
    expect(relisted.rows.map((row) => row.name)).toContain('hiddenname');
  });

  test('only the owner can change the setting', async () => {
    const domain = await seedDomain(t.db, { name: 'guarded', oxyUserId: 'owner-c' });
    expect(
      await updateDomainSettings(t.db, {
        domainId: domain.id,
        oxyUserId: 'someone-else',
        unlisted: true,
      }),
    ).toEqual({ ok: false, status: 403, error: 'You do not own this domain' });
    expect(
      await updateDomainSettings(t.db, {
        domainId: crypto.randomUUID(),
        oxyUserId: 'owner-c',
        unlisted: true,
      }),
    ).toEqual({ ok: false, status: 404, error: 'Domain not found' });

    const page = await listPublicDomains(t.db, { page: 1, limit: 50 });
    expect(page.rows.map((row) => row.name)).toContain('guarded');
  });

  test('a new name is listed by default', async () => {
    const domain = await seedDomain(t.db, { name: 'fresh' });
    expect(domain.unlisted).toBe(false);
  });
});

describe('directory order', () => {
  test('is by name, not by registration time', async () => {
    // Registered in reverse alphabetical order: a newest-first directory
    // would list them in exactly the order they were registered.
    for (const name of ['order-c', 'order-b', 'order-a']) {
      await seedDomain(t.db, { name });
    }
    const results = await searchPublicDomains(t.db, { query: 'order-', limit: 50 });
    expect(results.map((r) => r.name)).toEqual(['order-a', 'order-b', 'order-c']);
  });
});
