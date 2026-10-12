/**
 * Encrypted personal DNS rules against a real server: the version
 * compare-and-set (what makes two devices saving at once a 409 rather than a
 * lost write), owner isolation, and deletion — through the shipped statements
 * and through the real router.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { OxyAuthRequest } from '@oxy.so/core/server';
import type { PutDnsRulesRequest } from '@tnp/shared-types';
import { dnsRuleSets } from '../src/db/schema/index.js';
import { deleteDnsRuleSet, getDnsRuleSet, putDnsRuleSet } from '../src/registry/dnsRules.js';
import fixture from '../src/routes/fixtures/dns-rules-envelope.json';
import { createMeRouter, dnsRulesBodyParser } from '../src/routes/me.js';
import { createTestDatabase, type TestDatabase } from './harness.js';

const envelope = fixture as PutDnsRulesRequest;

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.delete(dnsRuleSets);
});

const at = (version: number, nonceByte = 0): PutDnsRulesRequest => ({
  ...envelope,
  version,
  // A different nonce per write, as a real reseal has.
  nonce: btoa(String.fromCharCode(...new Uint8Array(24).fill(nonceByte))),
});

describe('putDnsRuleSet', () => {
  test('the first write must be version 1, and each next write exactly +1', async () => {
    expect(await putDnsRuleSet(t.db, 'alice', at(2))).toEqual({ ok: false, currentVersion: 0 });
    const first = await putDnsRuleSet(t.db, 'alice', at(1));
    expect(first.ok && first.record.version).toBe(1);
    expect(await putDnsRuleSet(t.db, 'alice', at(1))).toEqual({ ok: false, currentVersion: 1 });
    expect(await putDnsRuleSet(t.db, 'alice', at(3))).toEqual({ ok: false, currentVersion: 1 });
    const second = await putDnsRuleSet(t.db, 'alice', at(2, 7));
    expect(second.ok && second.record.version).toBe(2);
  });

  test('of two concurrent writes of the same next version, exactly one wins', async () => {
    await putDnsRuleSet(t.db, 'alice', at(1));
    const results = await Promise.all([1, 2, 3].map((n) => putDnsRuleSet(t.db, 'alice', at(2, n))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, currentVersion: 2 },
      { ok: false, currentVersion: 2 },
    ]);
  });

  test('stores the envelope verbatim and nothing derived from it', async () => {
    await putDnsRuleSet(t.db, 'alice', at(1));
    const stored = await getDnsRuleSet(t.db, 'alice');
    expect(stored).toMatchObject({ ...at(1), userId: 'alice' });
    const columns = await t.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'dns_rule_sets'
      order by column_name
    `;
    expect(columns.map((c) => c.column_name)).toEqual([
      'ciphertext',
      'envelope_version',
      'kdf_params',
      'nonce',
      'oxy_user_id',
      'salt',
      'updated_at',
      'version',
      'wrapped_key',
    ]);
  });

  test('accounts are isolated and delete removes only the caller', async () => {
    await putDnsRuleSet(t.db, 'alice', at(1));
    await putDnsRuleSet(t.db, 'bob', at(1));
    expect(await deleteDnsRuleSet(t.db, 'alice')).toBe(true);
    expect(await deleteDnsRuleSet(t.db, 'alice')).toBe(false);
    expect(await getDnsRuleSet(t.db, 'alice')).toBeNull();
    expect((await getDnsRuleSet(t.db, 'bob'))?.version).toBe(1);
    // After a delete the account starts over at version 1.
    expect((await putDnsRuleSet(t.db, 'alice', at(1))).ok).toBe(true);
  });
});

describe('through the router', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use('/me/dns-rules', dnsRulesBodyParser);
    app.use(express.json());
    app.use((req, _res, next) => {
      const user = req.get('x-test-user');
      if (user) (req as OxyAuthRequest).userId = user;
      next();
    });
    app.use(
      '/me',
      createMeRouter(() => t.db),
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP port');
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  const call = (method: string, user: string, body?: unknown) =>
    fetch(`${base}/me/dns-rules`, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-test-user': user },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test('create, read, conflict, update, delete', async () => {
    expect((await call('GET', 'carol')).status).toBe(404);

    const created = await call('PUT', 'carol', at(1));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ version: 1, userId: 'carol' });

    const stale = await call('PUT', 'carol', at(1, 9));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: 'version must be 2: the stored rule set is version 1',
      code: 'version_conflict',
      currentVersion: 1,
    });

    expect((await call('PUT', 'carol', at(2, 3))).status).toBe(200);
    const read = await call('GET', 'carol');
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ version: 2, userId: 'carol' });

    // Another account sees nothing of carol's.
    expect((await call('GET', 'dave')).status).toBe(404);

    expect((await call('DELETE', 'carol')).status).toBe(204);
    expect((await call('GET', 'carol')).status).toBe(404);
  });
});
