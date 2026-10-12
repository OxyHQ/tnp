import { describe, expect, test } from 'bun:test';
import {
  encodeBase64,
  generateSigningKeyPair,
  type SignedRelayDirectory,
  type VerifiedRelayDirectory,
} from '@tnp/crypto';
import {
  chooseServiceRelays,
  NO_AUTOMATIC_RELAY_MESSAGE,
  resolveExplicitRelay,
  selectAutomaticRelays,
} from './relay-select';

type Op = 'oxy' | 'community';

function directory(entries: Array<[string, Op, string[]?]>): VerifiedRelayDirectory {
  const relays = entries.map(([endpoint, operator, capabilities]) => {
    const key = generateSigningKeyPair().publicKey;
    return {
      endpoint,
      relayKey: encodeBase64(key),
      key,
      operator,
      capabilities: capabilities ?? ['service', 'tunnel'],
      region: '',
    };
  });
  return {
    serial: 1,
    issuedAt: 1,
    expiresAt: 2,
    relays,
    signedBy: new Uint8Array(32),
    document: {} as SignedRelayDirectory,
  };
}

const allFast = async () => 10;

describe('selectAutomaticRelays', () => {
  test('never picks a community relay, even when it is listed first', async () => {
    const d = directory([
      ['wss://attacker.example.test', 'community'],
      ['wss://oxy.example.test', 'oxy'],
    ]);
    const s = await selectAutomaticRelays(d, allFast);
    expect(s.ok && s.candidates.map((c) => c.endpoint)).toEqual(['wss://oxy.example.test']);
    expect(s.ok && s.candidates[0].relayKey).toEqual(d.relays[1].key);
  });

  test('refuses rather than falling back when only community relays exist', async () => {
    expect(
      await selectAutomaticRelays(directory([['wss://c.example.test', 'community']]), allFast),
    ).toEqual({ ok: false, message: NO_AUTOMATIC_RELAY_MESSAGE });
    expect(await selectAutomaticRelays(directory([]), allFast)).toEqual({
      ok: false,
      message: NO_AUTOMATIC_RELAY_MESSAGE,
    });
  });

  test('skips Oxy relays that do not serve service nodes', async () => {
    const s = await selectAutomaticRelays(
      directory([
        ['wss://tunnel-only.example.test', 'oxy', ['tunnel']],
        ['wss://oxy.example.test', 'oxy'],
      ]),
      allFast,
    );
    expect(s.ok && s.candidates.map((c) => c.endpoint)).toEqual(['wss://oxy.example.test']);
  });

  test('fastest first; relays that failed the probe go last, in directory order', async () => {
    const latency: Record<string, number | null> = {
      'wss://a.example.test': null,
      'wss://b.example.test': 80,
      'wss://c.example.test': 20,
      'wss://d.example.test': null,
    };
    const d = directory(Object.keys(latency).map((e) => [e, 'oxy'] as [string, Op]));
    const s = await selectAutomaticRelays(d, async (endpoint) => latency[endpoint] ?? null);
    expect(s.ok && s.candidates.map((c) => c.endpoint)).toEqual([
      'wss://c.example.test',
      'wss://b.example.test',
      'wss://a.example.test',
      'wss://d.example.test',
    ]);
  });

  test('the refusal says why and what to do', () => {
    expect(NO_AUTOMATIC_RELAY_MESSAGE).toContain('--relay');
    expect(NO_AUTOMATIC_RELAY_MESSAGE).toContain('Community relays are never selected');
    expect(NO_AUTOMATIC_RELAY_MESSAGE).toContain('signed relay directory');
  });
});

describe('--relay', () => {
  const d = directory([['wss://community.example.test', 'community']]);

  test('a listed relay must prove the directory key, without a warning', () => {
    const r = resolveExplicitRelay('wss://Community.Example.Test/', d, null);
    expect(r).toEqual({
      ok: true,
      candidate: { endpoint: 'wss://community.example.test', relayKey: d.relays[0].key },
      warning: null,
    });
  });

  test('a --relay-key that contradicts the directory is refused', () => {
    const other = encodeBase64(generateSigningKeyPair().publicKey);
    const r = resolveExplicitRelay('wss://community.example.test', d, other);
    expect(r.ok).toBe(false);
    expect(resolveExplicitRelay('wss://community.example.test', d, d.relays[0].relayKey).ok).toBe(
      true,
    );
  });

  test('an unlisted relay is used only with a loud warning', () => {
    const r = resolveExplicitRelay('wss://unlisted.example.test', d, null);
    expect(r.ok && r.candidate.relayKey).toBeNull();
    expect(r.ok && r.warning).toContain('NOT in the signed relay directory');
    expect(r.ok && r.warning).toContain('CANNOT be verified');
    const key = generateSigningKeyPair().publicKey;
    const keyed = resolveExplicitRelay('wss://unlisted.example.test', null, encodeBase64(key));
    expect(keyed.ok && keyed.candidate.relayKey).toEqual(key);
    expect(keyed.ok && keyed.warning).toContain('no verified directory');
  });

  test('malformed input is refused', () => {
    expect(resolveExplicitRelay('relay.example.test', d, null).ok).toBe(false);
    expect(resolveExplicitRelay('wss://x.example.test', d, 'AAAA').ok).toBe(false);
  });
});

describe('chooseServiceRelays', () => {
  test('without a verified directory and without --relay, nothing is selected', async () => {
    const s = await chooseServiceRelays({
      relayFlag: null,
      relayKeyFlag: null,
      directory: async () => {
        throw new Error('no verified relay directory: bad signature');
      },
      probe: allFast,
      warn: () => {},
    });
    expect(s.ok).toBe(false);
    expect(!s.ok && s.message).toContain(
      'No relay is selected without a verified signed directory',
    );
  });

  test('blocking the API does not downgrade --relay to no relay authentication', async () => {
    const offline = async () => {
      throw new Error('no verified relay directory: could not fetch');
    };
    const refused = await chooseServiceRelays({
      relayFlag: 'wss://mine.example.test',
      relayKeyFlag: null,
      directory: offline,
      probe: allFast,
      warn: () => {},
    });
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.message).toContain('--allow-unverified-relay');
    // With --relay-key the relay must prove that key: allowed.
    const key = generateSigningKeyPair().publicKey;
    const keyed = await chooseServiceRelays({
      relayFlag: 'wss://mine.example.test',
      relayKeyFlag: encodeBase64(key),
      directory: offline,
      probe: allFast,
      warn: () => {},
    });
    expect(keyed.ok && keyed.candidates[0].relayKey).toEqual(key);
    // An unlisted relay with a verified directory is refused the same way.
    const unlisted = await chooseServiceRelays({
      relayFlag: 'wss://unlisted.example.test',
      relayKeyFlag: null,
      directory: async () => directory([['wss://oxy.example.test', 'oxy']]),
      probe: allFast,
      warn: () => {},
    });
    expect(unlisted.ok).toBe(false);
  });

  test('--allow-unverified-relay: proceeds unverified, loudly (explicit operator choice)', async () => {
    const warnings: string[] = [];
    const s = await chooseServiceRelays({
      relayFlag: 'wss://mine.example.test',
      relayKeyFlag: null,
      allowUnverified: true,
      directory: async () => {
        throw new Error('offline');
      },
      probe: allFast,
      warn: (m) => warnings.push(m),
    });
    expect(s.ok && s.candidates).toEqual([{ endpoint: 'wss://mine.example.test', relayKey: null }]);
    expect(warnings.join('\n')).toContain('WARNING');
  });
});
