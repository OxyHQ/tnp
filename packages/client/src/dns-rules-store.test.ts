import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeBase64Strict, encodeBase64 } from '@tnp/crypto';
import {
  createRulesEnvelope,
  resealRulesEnvelope,
  type RulesKdfParams,
} from '@tnp/crypto/dns-rules';
import { type DnsRule, type DnsRulesRecord, serializeDnsRuleSet } from '@tnp/shared-types';
import {
  acceptPulledRules,
  approveRedirects,
  currentRulesView,
  forgetRules,
  revokeRedirect,
  type RulesPaths,
  RulesStoreError,
} from './dns-rules-store';

const FAST: RulesKdfParams = { alg: 'argon2id', m: 19_456, t: 2, p: 1 };
const USER = 'oxy-user-store';
const PASSPHRASE = 'the sync passphrase';
const isNative = (name: string) => name.endsWith('.ox');
const enc = (rules: DnsRule[]) => new TextEncoder().encode(serializeDnsRuleSet(rules));

const RULES: DnsRule[] = [
  { type: 'block', name: 'ads.example.com', subdomains: true },
  { type: 'redirect', name: 'google.com', target: { kind: 'ipv4', value: '192.168.1.10' } },
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempPaths(): RulesPaths {
  const dir = mkdtempSync(join(tmpdir(), 'tnp-rules-store-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { secretDir: join(dir, 'secret'), activeFile: join(dir, 'dns-rules.conf') };
}

const asRecord = (
  envelope: ReturnType<typeof createRulesEnvelope>['envelope'],
  userId = USER,
): DnsRulesRecord => ({
  ...envelope,
  userId,
  updatedAt: '2026-10-12T00:00:00.000Z',
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof RulesStoreError) return err.code;
    throw err;
  }
  throw new Error('expected a RulesStoreError');
}

async function setup() {
  const paths = tempPaths();
  const v1 = createRulesEnvelope({
    passphrase: PASSPHRASE,
    userId: USER,
    body: enc(RULES),
    kdfParams: FAST,
  });
  await acceptPulledRules({
    paths,
    record: asRecord(v1.envelope),
    isNative,
    askPassphrase: async () => PASSPHRASE,
  });
  const v2 = resealRulesEnvelope({
    rulesKey: v1.rulesKey,
    userId: USER,
    previous: v1.envelope,
    body: enc(RULES),
  });
  return { paths, v1, v2 };
}

describe('acceptPulledRules', () => {
  test('a wrong passphrase on first pull writes nothing', async () => {
    const paths = tempPaths();
    const { envelope } = createRulesEnvelope({
      passphrase: PASSPHRASE,
      userId: USER,
      body: enc(RULES),
      kdfParams: FAST,
    });
    expect(
      await codeOf(
        acceptPulledRules({
          paths,
          record: asRecord(envelope),
          isNative,
          askPassphrase: async () => 'nope nope',
        }),
      ),
    ).toBe('wrong-passphrase');
    expect(existsSync(paths.activeFile)).toBe(false);
    expect(existsSync(paths.secretDir)).toBe(false);
  });

  test('without a stored key and without a way to ask, it says to pull with the passphrase', async () => {
    const paths = tempPaths();
    const { envelope } = createRulesEnvelope({
      passphrase: PASSPHRASE,
      userId: USER,
      body: enc(RULES),
      kdfParams: FAST,
    });
    expect(
      await codeOf(
        acceptPulledRules({ paths, record: asRecord(envelope), isNative, askPassphrase: null }),
      ),
    ).toBe('no-key');
  });

  test('later pulls need no passphrase', async () => {
    const { paths, v2 } = await setup();
    const result = await acceptPulledRules({
      paths,
      record: asRecord(v2),
      isNative,
      askPassphrase: null,
    });
    expect(result.view.version).toBe(2);
  });

  test('an older version than one accepted is refused as a rollback', async () => {
    const { paths, v1, v2 } = await setup();
    await acceptPulledRules({ paths, record: asRecord(v2), isNative, askPassphrase: null });
    expect(
      await codeOf(
        acceptPulledRules({ paths, record: asRecord(v1.envelope), isNative, askPassphrase: null }),
      ),
    ).toBe('rollback');
    expect(currentRulesView(paths, isNative)?.version).toBe(2);
  });

  test('the same version with different bytes is refused as a fork', async () => {
    const { paths, v1 } = await setup();
    const forked = resealRulesEnvelope({
      rulesKey: v1.rulesKey,
      userId: USER,
      previous: v1.envelope,
      body: enc([]),
    });
    await acceptPulledRules({ paths, record: asRecord(forked), isNative, askPassphrase: null });
    const sibling = resealRulesEnvelope({
      rulesKey: v1.rulesKey,
      userId: USER,
      previous: v1.envelope,
      body: enc(RULES),
    });
    expect(
      await codeOf(
        acceptPulledRules({ paths, record: asRecord(sibling), isNative, askPassphrase: null }),
      ),
    ).toBe('fork');
  });

  test('a tampered rule set is refused, even when the passphrase is offered', async () => {
    const { paths, v2 } = await setup();
    const bytes = decodeBase64Strict(v2.ciphertext);
    bytes[100] ^= 1;
    const tampered = asRecord({ ...v2, ciphertext: encodeBase64(bytes) });
    expect(
      await codeOf(acceptPulledRules({ paths, record: tampered, isNative, askPassphrase: null })),
    ).toBe('needs-passphrase');
    expect(
      await codeOf(
        acceptPulledRules({
          paths,
          record: tampered,
          isNative,
          askPassphrase: async () => PASSPHRASE,
        }),
      ),
    ).toBe('tampered');
  });

  test("another account's rule set is refused while this device holds a key", async () => {
    const { paths } = await setup();
    const other = createRulesEnvelope({
      passphrase: PASSPHRASE,
      userId: 'someone-else',
      body: enc(RULES),
      kdfParams: FAST,
    });
    expect(
      await codeOf(
        acceptPulledRules({
          paths,
          record: asRecord(other.envelope, 'someone-else'),
          isNative,
          askPassphrase: null,
        }),
      ),
    ).toBe('other-account');
  });

  test('a rule set re-created under a new passphrase is a reset: version 1 accepted, approvals cleared', async () => {
    const { paths, v2 } = await setup();
    await acceptPulledRules({ paths, record: asRecord(v2), isNative, askPassphrase: null });
    approveRedirects(paths, ['google.com'], isNative);
    const fresh = createRulesEnvelope({
      passphrase: 'a brand new passphrase',
      userId: USER,
      body: enc(RULES),
      kdfParams: FAST,
    });
    const result = await acceptPulledRules({
      paths,
      record: asRecord(fresh.envelope),
      isNative,
      askPassphrase: async () => 'a brand new passphrase',
    });
    expect(result.reset).toBe(true);
    expect(result.view.version).toBe(1);
    expect(result.view.pending.map((r) => r.name)).toEqual(['google.com']);
  });
});

describe('approvals', () => {
  test('approve, then revoke', async () => {
    const { paths } = await setup();
    expect(approveRedirects(paths, ['google.com'], isNative).pending).toEqual([]);
    expect(revokeRedirect(paths, 'google.com', isNative).pending.map((r) => r.name)).toEqual([
      'google.com',
    ]);
    expect(() => revokeRedirect(paths, 'google.com', isNative)).toThrow('not an approved redirect');
  });

  test('forget removes the key, the state and the active file', async () => {
    const { paths } = await setup();
    expect(forgetRules(paths).sort()).toEqual([paths.activeFile, paths.secretDir].sort());
    expect(currentRulesView(paths, isNative)).toBeNull();
    expect(forgetRules(paths)).toEqual([]);
  });
});
