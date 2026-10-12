import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createRulesEnvelope,
  RulesEnvelopeError,
  type RulesKdfParams,
  unlockRulesKey,
} from '@tnp/crypto/dns-rules';
import {
  type DnsRule,
  type DnsRuleErrorCode,
  exportDnsmasq,
  type PutDnsRulesRequest,
  parsePutDnsRulesRequest,
} from '@tnp/shared-types';
import {
  createRules,
  httpRulesApi,
  isNativeName,
  type RulesApi,
  RulesConflictError,
  type RulesCrypto,
  reloadRules,
  saveRules,
  unlockRules,
} from '../src/lib/dnsRules';

const FAST: RulesKdfParams = { alg: 'argon2id', m: 19_456, t: 2, p: 1 };
const fastCrypto: RulesCrypto = {
  unlock: async (args) => unlockRulesKey(args),
  create: async (args) => createRulesEnvelope({ ...args, kdfParams: FAST }),
};
const USER = 'oxy-user-web';
const PASSPHRASE = 'twelve chars or more';

/** An in-memory API that behaves like `/me/dns-rules` and records every PUT body. */
function memoryApi() {
  let stored: (PutDnsRulesRequest & { userId: string; updatedAt: string }) | null = null;
  const puts: unknown[] = [];
  const api: RulesApi = {
    async get() {
      return stored;
    },
    async put(body) {
      // What the client put on the wire, after JSON, is what the API parses.
      const wire = JSON.parse(JSON.stringify(body));
      puts.push(wire);
      const parsed = parsePutDnsRulesRequest(wire);
      if (!parsed.ok) throw new Error(`the API would reject this body: ${parsed.error}`);
      if (parsed.value.version !== (stored?.version ?? 0) + 1) throw new RulesConflictError();
      stored = { ...parsed.value, userId: USER, updatedAt: new Date().toISOString() };
      return stored;
    },
    async remove() {
      stored = null;
    },
  };
  return { api, puts, peek: () => stored };
}

const RULES: DnsRule[] = [
  { type: 'block', name: 'ads.example.com', subdomains: true },
  { type: 'redirect', name: 'google.com', target: { kind: 'ipv4', value: '192.168.1.10' } },
];

describe('the dashboard rule-set flow', () => {
  test('create, save and unlock: every PUT body is the API contract, and names never leave the browser', async () => {
    const { api, puts, peek } = memoryApi();
    const created = await createRules(api, PASSPHRASE, USER, fastCrypto);
    expect(created.record.version).toBe(1);
    const saved = await saveRules(api, created, RULES);
    expect(saved.record.version).toBe(2);

    expect(puts).toHaveLength(2);
    for (const body of puts) {
      const parsed = parsePutDnsRulesRequest(body);
      expect(parsed.ok).toBe(true);
      expect(JSON.stringify(body)).not.toContain('google.com');
      expect(JSON.stringify(body)).not.toContain('192.168.1.10');
    }

    const record = peek();
    if (!record) throw new Error('nothing stored');
    const reopened = await unlockRules(record, PASSPHRASE, USER, fastCrypto);
    expect(reopened.rules).toEqual(RULES);
  });

  test('a wrong passphrase is refused as such', async () => {
    const { api, peek } = memoryApi();
    await createRules(api, PASSPHRASE, USER, fastCrypto);
    const record = peek();
    if (!record) throw new Error('nothing stored');
    try {
      await unlockRules(record, 'not the passphrase', USER, fastCrypto);
      throw new Error('unlocked with the wrong passphrase');
    } catch (err) {
      expect(err instanceof RulesEnvelopeError && err.code).toBe('wrong-passphrase');
    }
  });

  test("another account's record is refused before any key derivation", async () => {
    const { api, peek } = memoryApi();
    await createRules(api, PASSPHRASE, USER, fastCrypto);
    const record = peek();
    if (!record) throw new Error('nothing stored');
    await expect(unlockRules(record, PASSPHRASE, 'someone-else', fastCrypto)).rejects.toThrow(
      'another account',
    );
  });

  test('a stale save is a conflict, and reload opens the newer set with the key in memory', async () => {
    const { api } = memoryApi();
    const tabA = await createRules(api, PASSPHRASE, USER, fastCrypto);
    const tabB = { ...tabA };
    await saveRules(api, tabA, RULES);
    await expect(saveRules(api, tabB, [])).rejects.toBeInstanceOf(RulesConflictError);
    const reloaded = await reloadRules(api, tabB.rulesKey, USER);
    expect(reloaded?.record.version).toBe(2);
    expect(reloaded?.rules).toEqual(RULES);
  });
});

describe('httpRulesApi', () => {
  class HttpError extends Error {
    constructor(readonly status: number) {
      super(`HTTP ${status}`);
    }
  }
  const statusOf = (err: unknown) => (err instanceof HttpError ? err.status : undefined);

  test('404 on GET is "nothing stored", 409 on PUT a conflict, anything else is thrown', async () => {
    const calls: string[] = [];
    const failing = (status: number) =>
      httpRulesApi(async (method, path) => {
        calls.push(`${method} ${path}`);
        throw new HttpError(status);
      }, statusOf);
    expect(await failing(404).get()).toBeNull();
    await expect(failing(409).put({} as PutDnsRulesRequest)).rejects.toBeInstanceOf(
      RulesConflictError,
    );
    await expect(failing(500).get()).rejects.toThrow('HTTP 500');
    expect(calls).toEqual(['GET /me/dns-rules', 'PUT /me/dns-rules', 'GET /me/dns-rules']);
  });
});

describe('native names', () => {
  test('the built-in native TLD is recognised', () => {
    expect(isNativeName('nate.ox')).toBe(true);
    expect(isNativeName('google.com')).toBe(false);
  });
});

describe('router export (pure, runs in the browser)', () => {
  test('dnsmasq lines for a fixture rule set', () => {
    const lines = exportDnsmasq(RULES)
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines).toEqual(['address=/ads.example.com/', 'address=/google.com/192.168.1.10']);
  });
});

describe('dnsRules locales', () => {
  const localesDir = join(import.meta.dir, '..', 'public', 'locales');
  const locales = readdirSync(localesDir).sort();
  const load = (lng: string) =>
    JSON.parse(readFileSync(join(localesDir, lng, 'dnsRules.json'), 'utf8')) as Record<
      string,
      unknown
    >;

  function flatten(value: unknown, path = '', out = new Map<string, string>()) {
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) flatten(v, path ? `${path}.${k}` : k, out);
    } else {
      out.set(path, String(value));
    }
    return out;
  }
  const tokens = (s: string) => [...s.matchAll(/\{\{\w+\}\}|<\/?\w+>/g)].map((m) => m[0]).sort();
  const en = flatten(load('en'));

  test('all five languages are present', () => {
    expect(locales).toEqual(['en', 'es', 'fr', 'hi', 'zh']);
  });

  test('every locale has exactly the English keys, variables and markup, translated', () => {
    for (const lng of locales) {
      const other = flatten(load(lng));
      expect([...other.keys()].sort()).toEqual([...en.keys()].sort());
      for (const [key, value] of en) {
        expect(tokens(other.get(key) ?? '')).toEqual(tokens(value));
      }
      if (lng !== 'en') {
        expect(other.get('heading')).not.toBe(en.get('heading'));
        expect(other.get('setup.warning')).not.toBe(en.get('setup.warning'));
      }
    }
  });

  test('every rule error code has a message', () => {
    const codes: DnsRuleErrorCode[] = [
      'body_invalid',
      'too_many',
      'type_invalid',
      'name_required',
      'name_invalid',
      'name_single_label',
      'name_ip',
      'target_required',
      'target_invalid',
      'target_self',
      'redirect_native',
      'duplicate',
    ];
    for (const code of codes) expect(en.has(`errors.${code}`)).toBe(true);
  });

  test('every key the page asks for exists', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', 'src', 'pages', 'DnsRules.tsx'),
      'utf8',
    );
    const asked = [...source.matchAll(/(?:t\(|i18nKey=)['"`](?:dnsRules:)?([a-zA-Z.]+)['"`]/g)].map(
      (m) => m[1],
    );
    expect(asked.length).toBeGreaterThan(40);
    for (const key of asked) {
      if (key.startsWith('common')) continue;
      expect(en.has(key) || [...en.keys()].some((k) => k.startsWith(`${key}.`))).toBe(true);
    }
  });
});
