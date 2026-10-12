import { describe, expect, test } from 'bun:test';
import {
  type DnsRule,
  normalizeRuleName,
  parseDnsRule,
  parseDnsRuleSet,
  parseDnsRuleTargetInput,
  parseDnsRulesRecord,
  parsePutDnsRulesRequest,
  serializeDnsRuleSet,
} from './dns-rules';
import { exportAdGuard, exportDnsmasq, exportHosts, exportUci } from './dns-rules-export';

const isNative = (name: string) => name === 'ox' || name.endsWith('.ox');

/** base64 of `n` zero bytes. */
const zeros = (n: number) => btoa(String.fromCharCode(...new Uint8Array(n)));

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    kdfParams: { alg: 'argon2id', m: 65_536, t: 3, p: 1 },
    salt: zeros(16),
    wrappedKey: zeros(72),
    nonce: zeros(24),
    ciphertext: btoa('\0'.repeat(4096 + 16)),
    version: 1,
    ...overrides,
  };
}

describe('normalizeRuleName', () => {
  test('lowercases, drops the root dot and converts IDNA to ASCII', () => {
    expect(normalizeRuleName('Google.COM.')).toEqual({ ok: true, name: 'google.com' });
    expect(normalizeRuleName(' bücher.de ')).toEqual({ ok: true, name: 'xn--bcher-kva.de' });
    expect(normalizeRuleName('ＥＸＡＭＰＬＥ．ｃｏｍ')).toEqual({ ok: true, name: 'example.com' });
  });

  test('refuses IP literals, including the forms the URL parser rewrites', () => {
    for (const input of ['1.2.3.4', '1.2.3', '0x7f.1', '::1', '[2001:db8::1]']) {
      expect(normalizeRuleName(input)).toEqual({ ok: false, code: 'name_ip' });
    }
    expect(normalizeRuleName('a.123').ok).toBe(false);
  });

  test('refuses a whole TLD, empty input and non-hostnames', () => {
    expect(normalizeRuleName('com')).toEqual({ ok: false, code: 'name_single_label' });
    expect(normalizeRuleName('  ')).toEqual({ ok: false, code: 'name_required' });
    for (const input of [
      'a..b',
      '-a.com',
      'a_b.com',
      'exa mple.com',
      'a.com:80',
      'x%41.com',
      'a/b.com',
    ]) {
      expect(normalizeRuleName(input)).toEqual({ ok: false, code: 'name_invalid' });
    }
  });
});

describe('parseDnsRuleTargetInput', () => {
  test('reads addresses and names', () => {
    expect(parseDnsRuleTargetInput('192.168.1.10')).toEqual({
      kind: 'ipv4',
      value: '192.168.1.10',
    });
    expect(parseDnsRuleTargetInput('[2001:DB8::1]')).toEqual({
      kind: 'ipv6',
      value: '2001:db8::1',
    });
    expect(parseDnsRuleTargetInput('NAS.Home.Arpa')).toEqual({
      kind: 'name',
      value: 'nas.home.arpa',
    });
    expect(parseDnsRuleTargetInput('not a target')).toBeNull();
    expect(parseDnsRuleTargetInput('')).toBeNull();
  });
});

describe('parseDnsRule', () => {
  test('a block rule, with or without subdomains', () => {
    expect(parseDnsRule({ type: 'block', name: 'Ads.Example.com' }, isNative)).toEqual({
      ok: true,
      value: { type: 'block', name: 'ads.example.com', subdomains: false },
    });
    expect(
      parseDnsRule({ type: 'block', name: 'x.example', subdomains: true }, isNative),
    ).toMatchObject({
      ok: true,
      value: { subdomains: true },
    });
  });

  test('a native name may be blocked but never redirected', () => {
    expect(parseDnsRule({ type: 'block', name: 'ads.ox' }, isNative).ok).toBe(true);
    expect(
      parseDnsRule(
        { type: 'redirect', name: 'nate.ox', target: { kind: 'ipv4', value: '10.0.0.1' } },
        isNative,
      ),
    ).toMatchObject({ ok: false, code: 'redirect_native', field: 'name' });
  });

  test('redirect targets are validated', () => {
    expect(
      parseDnsRule(
        { type: 'redirect', name: 'google.com', target: { kind: 'ipv4', value: '300.1.1.1' } },
        isNative,
      ),
    ).toMatchObject({ ok: false, code: 'target_invalid' });
    expect(parseDnsRule({ type: 'redirect', name: 'google.com' }, isNative)).toMatchObject({
      ok: false,
      code: 'target_required',
    });
    expect(
      parseDnsRule(
        { type: 'redirect', name: 'google.com', target: { kind: 'name', value: 'GOOGLE.com' } },
        isNative,
      ),
    ).toMatchObject({ ok: false, code: 'target_self' });
    expect(parseDnsRule({ type: 'allow', name: 'google.com' }, isNative)).toMatchObject({
      code: 'type_invalid',
    });
  });
});

describe('parseDnsRuleSet', () => {
  test('keeps good rules and reports the unusable ones without failing the set', () => {
    const parsed = parseDnsRuleSet(
      {
        rules: [
          { type: 'block', name: 'a.example' },
          { type: 'redirect', name: 'b.ox', target: { kind: 'ipv4', value: '10.0.0.1' } },
          { type: 'block', name: 'A.example' },
          { type: 'block', name: 'not valid' },
        ],
      },
      isNative,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.rules).toEqual([{ type: 'block', name: 'a.example', subdomains: false }]);
    expect(parsed.value.rejected.map((r) => [r.index, r.code])).toEqual([
      [1, 'redirect_native'],
      [2, 'duplicate'],
      [3, 'name_invalid'],
    ]);
  });

  test('structure errors fail the whole set', () => {
    expect(parseDnsRuleSet({ rules: 'nope' }, isNative).ok).toBe(false);
    expect(parseDnsRuleSet([], isNative).ok).toBe(false);
    expect(
      parseDnsRuleSet({ rules: new Array(2001).fill({ type: 'block', name: 'a.b' }) }, isNative).ok,
    ).toBe(false);
  });

  test('serialization is deterministic and round-trips', () => {
    const rules: DnsRule[] = [
      { type: 'redirect', name: 'z.example', target: { kind: 'name', value: 'y.example' } },
      { type: 'block', name: 'a.example', subdomains: true },
    ];
    const text = serializeDnsRuleSet(rules);
    expect(text).toBe(serializeDnsRuleSet([...rules].reverse()));
    const back = parseDnsRuleSet(JSON.parse(text), isNative);
    expect(back.ok && back.value.rules).toEqual([rules[1], rules[0]]);
  });
});

describe('envelope contract', () => {
  test('accepts a well-formed envelope and drops unknown fields', () => {
    const parsed = parsePutDnsRulesRequest({ ...envelope(), ruleCount: 12, names: ['google.com'] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(Object.keys(parsed.value).sort()).toEqual([
        'ciphertext',
        'kdfParams',
        'nonce',
        'salt',
        'v',
        'version',
        'wrappedKey',
      ]);
  });

  test('rejects wrong versions, KDFs, lengths and non-canonical base64', () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ v: 2 }, /^v must be 1$/],
      [{ kdfParams: { alg: 'argon2id', m: 1024, t: 3, p: 1 } }, /kdfParams/],
      [{ kdfParams: { alg: 'pbkdf2', m: 65_536, t: 3, p: 1 } }, /kdfParams/],
      [{ salt: zeros(15) }, /salt/],
      [{ wrappedKey: zeros(32) }, /wrappedKey/],
      [{ nonce: zeros(12) }, /nonce/],
      [{ salt: `${zeros(16).slice(0, -3)}B==` }, /salt/],
      [{ ciphertext: 'not base64!' }, /ciphertext must be canonical/],
      [{ ciphertext: zeros(100) }, /too short/],
      [{ ciphertext: btoa('\0'.repeat(256 * 1024 + 1)) }, /larger than 262144/],
      [{ version: 0 }, /version/],
      [{ version: 1.5 }, /version/],
    ];
    for (const [override, error] of cases) {
      const parsed = parsePutDnsRulesRequest(envelope(override));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toMatch(error);
    }
    expect(parsePutDnsRulesRequest('x').ok).toBe(false);
  });

  test('a record also carries the user id and a timestamp', () => {
    expect(
      parseDnsRulesRecord({ ...envelope(), userId: 'u1', updatedAt: '2026-10-12T00:00:00.000Z' })
        .ok,
    ).toBe(true);
    expect(parseDnsRulesRecord({ ...envelope(), updatedAt: '2026-10-12T00:00:00.000Z' }).ok).toBe(
      false,
    );
  });
});

describe('router exports', () => {
  const fixture: DnsRule[] = [
    { type: 'redirect', name: 'google.com', target: { kind: 'ipv4', value: '192.168.1.10' } },
    { type: 'block', name: 'ads.example.com', subdomains: true },
    { type: 'redirect', name: 'v6.example.org', target: { kind: 'ipv6', value: '2001:db8::10' } },
    { type: 'block', name: 'tracker.example.net', subdomains: false },
    {
      type: 'redirect',
      name: 'media.example.org',
      target: { kind: 'name', value: 'nas.home.arpa' },
    },
  ];

  test('dnsmasq', () => {
    const lines = exportDnsmasq(fixture)
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('# ') && line !== '#');
    expect(lines).toEqual([
      'address=/ads.example.com/',
      'address=/tracker.example.net/',
      'address=/google.com/192.168.1.10',
      'address=/v6.example.org/2001:db8::10',
    ]);
    expect(exportDnsmasq(fixture)).toContain('# cname=media.example.org,nas.home.arpa');
    expect(exportDnsmasq(fixture)).toContain('matches the name AND every name under it');
  });

  test('uci', () => {
    const commands = exportUci(fixture)
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(commands).toEqual([
      "uci add_list dhcp.@dnsmasq[0].address='/ads.example.com/'",
      "uci add_list dhcp.@dnsmasq[0].address='/tracker.example.net/'",
      "uci add_list dhcp.@dnsmasq[0].address='/google.com/192.168.1.10'",
      "uci add_list dhcp.@dnsmasq[0].address='/v6.example.org/2001:db8::10'",
      'uci commit dhcp',
      '/etc/init.d/dnsmasq restart',
    ]);
  });

  test('AdGuard Home', () => {
    const rules = exportAdGuard(fixture)
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('!'));
    expect(rules).toEqual([
      '||ads.example.com^$dnsrewrite=NXDOMAIN;;',
      '|tracker.example.net^$dnsrewrite=NXDOMAIN;;',
      '|google.com^$dnsrewrite=NOERROR;A;192.168.1.10',
      '|media.example.org^$dnsrewrite=NOERROR;CNAME;nas.home.arpa',
      '|v6.example.org^$dnsrewrite=NOERROR;AAAA;2001:db8::10',
    ]);
  });

  test('hosts', () => {
    const entries = exportHosts(fixture)
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(entries).toEqual([
      '0.0.0.0 ads.example.com',
      ':: ads.example.com',
      '0.0.0.0 tracker.example.net',
      ':: tracker.example.net',
      '192.168.1.10 google.com',
      '2001:db8::10 v6.example.org',
    ]);
    expect(exportHosts(fixture)).toContain('(\\.|^)ads\\.example\\.com$');
  });

  test('an empty rule set still produces a valid file', () => {
    expect(exportDnsmasq([])).toContain('# (no rules)');
    expect(exportUci([])).toContain('uci commit dhcp');
  });
});
