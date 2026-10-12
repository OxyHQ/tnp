import { describe, expect, test } from 'bun:test';
import { encodeBase64, generateSigningKeyPair, verifyRelayDirectory } from '@tnp/crypto';
import {
  type CommunityRelayRow,
  directoryRelays,
  directorySignerFromSeed,
  parseOxyRelays,
  RelayDirectoryService,
} from './relayDirectory.js';

const key = () => encodeBase64(generateSigningKeyPair().publicKey);

describe('TNP_OXY_RELAYS', () => {
  test('unset or empty lists no Oxy relay', () => {
    expect(parseOxyRelays(undefined)).toEqual({ ok: true, relays: [] });
    expect(parseOxyRelays('  ')).toEqual({ ok: true, relays: [] });
  });

  test('a valid list is normalized', () => {
    const relayKey = key();
    expect(
      parseOxyRelays(JSON.stringify([{ endpoint: 'wss://Relay.TNP.network/', relayKey }])),
    ).toEqual({
      ok: true,
      relays: [{ endpoint: 'wss://relay.tnp.network', relayKey, region: '' }],
    });
  });

  test('one bad entry rejects the whole value', () => {
    const relayKey = key();
    for (const raw of [
      '{',
      '{}',
      JSON.stringify([{ endpoint: 'ws://relay.tnp.network', relayKey }]),
      JSON.stringify([{ endpoint: 'wss://10.0.0.1', relayKey }]),
      JSON.stringify([{ endpoint: 'wss://relay.tnp.network', relayKey: 'AAAA' }]),
      JSON.stringify([{ endpoint: 'wss://relay.tnp.network', relayKey, operator: 'oxy' }]),
      JSON.stringify([{ endpoint: 'wss://relay.tnp.network', relayKey, region: 'x\n' }]),
      JSON.stringify([
        { endpoint: 'wss://relay.tnp.network', relayKey },
        { endpoint: 'wss://relay.tnp.network/', relayKey },
      ]),
    ]) {
      expect(parseOxyRelays(raw).ok).toBe(false);
    }
  });
});

describe('TNP_DIRECTORY_SIGNING_SEED', () => {
  test('unset or malformed: no signer, and the reason never contains the seed', () => {
    const unset = directorySignerFromSeed(undefined);
    expect(unset.signer).toBeNull();
    const secret = 'bm90LWEtMzItYnl0ZS1zZWVk';
    const bad = directorySignerFromSeed(secret);
    expect(bad.signer).toBeNull();
    if (bad.signer === null) expect(bad.problem).not.toContain(secret);
  });

  test('a fresh seed signs, and is reported as not pinned', () => {
    const signed = directorySignerFromSeed(
      encodeBase64(crypto.getRandomValues(new Uint8Array(32))),
    );
    expect(signed.signer).not.toBeNull();
    if (signed.signer) expect(signed.pinned).toBe(false);
  });
});

describe('directory entries', () => {
  test('Oxy relays first; community relays only when canonical, public and keyed', () => {
    const oxyKey = key();
    const goodKey = key();
    const community: CommunityRelayRow[] = [
      { endpoint: 'wss://community.example.org', publicKey: goodKey, location: 'Lisbon' },
      { endpoint: 'wss://relay.tnp.network', publicKey: key(), location: '' }, // shadows an Oxy relay
      { endpoint: 'ws://plain.example.org', publicKey: key(), location: '' },
      { endpoint: 'wss://WRONG.example.org', publicKey: key(), location: '' },
      { endpoint: 'wss://badkey.example.org', publicKey: 'Zm9vYmFy', location: '' },
      { endpoint: 'wss://ctl.example.org', publicKey: key(), location: 'bad\u0007label' },
    ];
    const relays = directoryRelays(
      [{ endpoint: 'wss://relay.tnp.network', relayKey: oxyKey, region: 'us-west-2' }],
      community,
    );
    expect(relays.map((r) => [r.endpoint, r.operator, r.region])).toEqual([
      ['wss://relay.tnp.network', 'oxy', 'us-west-2'],
      ['wss://community.example.org', 'community', 'Lisbon'],
      ['wss://ctl.example.org', 'community', ''],
    ]);
    expect(relays[0].relayKey).toBe(oxyKey);
  });
});

describe('RelayDirectoryService', () => {
  const directoryKey = generateSigningKeyPair();
  const seed = encodeBase64(directoryKey.secretKey.subarray(0, 32));
  const signer = directorySignerFromSeed(seed).signer;
  if (!signer) throw new Error('signer');

  test('signs at request time, caches briefly, and never lowers the serial', async () => {
    let now = 1_800_000_000_000;
    let calls = 0;
    const service = new RelayDirectoryService({
      signer,
      oxyRelays: [],
      listCommunity: async () => {
        calls++;
        return [];
      },
      clock: () => now,
      cacheSeconds: 60,
    });
    const first = await service.current();
    expect(
      verifyRelayDirectory(first, { trustedKeys: [directoryKey.publicKey], now: now / 1000 }).ok,
    ).toBe(true);
    expect(await service.current()).toBe(first);
    expect(calls).toBe(1);
    now += 61_000;
    const second = await service.current();
    expect(second.serial).toBeGreaterThan(first.serial);
    // A clock step backwards does not make this process sign a lower serial.
    now -= 3_600_000;
    const sameProcess = new RelayDirectoryService({
      signer,
      oxyRelays: [],
      listCommunity: async () => [],
      clock: () => now,
      cacheSeconds: 0,
    });
    const a = await sameProcess.current();
    now -= 5_000;
    const b = await sameProcess.current();
    expect(b.serial).toBe(a.serial);
    expect(b.expiresAt - b.issuedAt).toBe(86_400);
  });

  test('a registry failure degrades to the Oxy relays and is not cached', async () => {
    let fail = true;
    const errors: unknown[] = [];
    const oxyKey = key();
    const service = new RelayDirectoryService({
      signer,
      oxyRelays: [{ endpoint: 'wss://relay.tnp.network', relayKey: oxyKey, region: '' }],
      listCommunity: async () => {
        if (fail) throw new Error('db down');
        return [{ endpoint: 'wss://c.example.org', publicKey: key(), location: '' }];
      },
      onError: (err) => errors.push(err),
    });
    expect((await service.current()).relays.map((r) => r.endpoint)).toEqual([
      'wss://relay.tnp.network',
    ]);
    expect(errors).toHaveLength(1);
    fail = false;
    expect((await service.current()).relays.map((r) => r.endpoint)).toEqual([
      'wss://relay.tnp.network',
      'wss://c.example.org',
    ]);
  });
});
