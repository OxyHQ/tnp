import { describe, expect, test } from 'bun:test';
import {
  generateSigningKeyPair,
  signingKeyPairFromSeed,
  signingKeyPairFromSeedBase64,
} from './domain-key';
import { encodeBase64 } from './encoding';
import { randomBytes } from './primitives';
import {
  canonicalRelayDirectoryBytes,
  MAX_DIRECTORY_CLOCK_SKEW_SECONDS,
  MAX_DIRECTORY_LIFETIME_SECONDS,
  MAX_DIRECTORY_RELAYS,
  type SignedRelayDirectory,
  MAX_RELAY_BINDING_AGE_SECONDS,
  signRelayDirectory,
  signRelayIdentity,
  signServiceRelayBinding,
  signRelayRegistryProof,
  type UnsignedRelayDirectory,
  verifyRelayDirectory,
  verifyRelayIdentity,
  verifyRelayRegistryProof,
  verifyServiceRelayBinding,
} from './relay-directory';

const NOW = 1_800_000_000;
const directoryKey = generateSigningKeyPair();
const relayKey = generateSigningKeyPair();

function unsigned(overrides: Partial<UnsignedRelayDirectory> = {}): UnsignedRelayDirectory {
  return {
    v: 1,
    serial: NOW,
    issuedAt: NOW,
    expiresAt: NOW + 86_400,
    relays: [
      {
        endpoint: 'wss://relay.tnp.network',
        relayKey: encodeBase64(relayKey.publicKey),
        operator: 'oxy',
        capabilities: ['service', 'tunnel'],
        region: 'us-west-2',
      },
    ],
    ...overrides,
  };
}

function signed(overrides: Partial<UnsignedRelayDirectory> = {}): SignedRelayDirectory {
  return signRelayDirectory(unsigned(overrides), directoryKey.secretKey);
}

const trust = { trustedKeys: [directoryKey.publicKey], now: NOW + 60 };

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** The same 32 bytes spelled with non-zero trailing bits: a lenient decoder accepts it. */
function nonCanonical(key: string): string {
  const last = B64.indexOf(key[42]);
  return `${key.slice(0, 42)}${B64[last | 1]}=`;
}

describe('signed relay directory', () => {
  test('a valid directory verifies, with decoded keys and the signer', () => {
    const result = verifyRelayDirectory(signed(), trust);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.directory.relays[0].key).toEqual(relayKey.publicKey);
    expect(result.directory.signedBy).toEqual(directoryKey.publicKey);
    // The document round-trips: what is cached verifies again.
    expect(verifyRelayDirectory(result.directory.document, trust).ok).toBe(true);
    // And survives JSON, which is how it travels and is stored.
    expect(verifyRelayDirectory(JSON.parse(JSON.stringify(signed())), trust).ok).toBe(true);
  });

  test('either of two pinned keys verifies (rotation)', () => {
    const next = generateSigningKeyPair();
    const doc = signRelayDirectory(unsigned(), next.secretKey);
    expect(
      verifyRelayDirectory(doc, { ...trust, trustedKeys: [directoryKey.publicKey, next.publicKey] })
        .ok,
    ).toBe(true);
  });

  test('expired is refused', () => {
    expect(verifyRelayDirectory(signed(), { ...trust, now: NOW + 86_400 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  test('a document from far in the future is refused (it would poison the serial mark)', () => {
    expect(
      verifyRelayDirectory(signed(), { ...trust, now: NOW - MAX_DIRECTORY_CLOCK_SKEW_SECONDS - 1 }),
    ).toEqual({ ok: false, reason: 'not-yet-valid' });
  });

  test('a serial beyond issuedAt is never signed nor accepted (no permanent lockout)', () => {
    // A seed holder signing serial 2^53 - 1 would raise every client's mark
    // past anything honest could ever reach. The serial is capped by the
    // document's own date, which the verifier caps by its clock.
    expect(() => signed({ serial: Number.MAX_SAFE_INTEGER })).toThrow('serial must not exceed');
    expect(() => signed({ serial: NOW + 1 })).toThrow('serial must not exceed');
    // And a future-dated document that tries the same within the skew window
    // is refused once it is further ahead than the allowed skew.
    const ahead = trust.now + MAX_DIRECTORY_CLOCK_SKEW_SECONDS + 1;
    expect(
      verifyRelayDirectory(
        signed({ serial: ahead, issuedAt: ahead, expiresAt: ahead + 60 }),
        trust,
      ),
    ).toEqual({ ok: false, reason: 'not-yet-valid' });
  });

  test('a serial below the highest seen is rolled back; equal is accepted', () => {
    expect(verifyRelayDirectory(signed(), { ...trust, minSerial: NOW + 1 })).toEqual({
      ok: false,
      reason: 'rolled-back',
    });
    expect(verifyRelayDirectory(signed(), { ...trust, minSerial: NOW }).ok).toBe(true);
  });

  test('a bad signature is refused', () => {
    const doc = signed();
    const sig = Buffer.from(doc.signature, 'base64');
    sig[0] ^= 1;
    expect(verifyRelayDirectory({ ...doc, signature: sig.toString('base64') }, trust)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  test('any change to a signed field breaks the signature', () => {
    const doc = signed();
    const tampered: SignedRelayDirectory[] = [
      { ...doc, serial: doc.serial - 1 },
      { ...doc, expiresAt: doc.expiresAt + 1 },
      { ...doc, relays: [{ ...doc.relays[0], endpoint: 'wss://evil.example' }] },
      {
        ...doc,
        relays: [{ ...doc.relays[0], relayKey: encodeBase64(generateSigningKeyPair().publicKey) }],
      },
      { ...doc, relays: [{ ...doc.relays[0], operator: 'community' }] },
      { ...doc, relays: [{ ...doc.relays[0], capabilities: ['tunnel'] }] },
      { ...doc, relays: [] },
    ];
    for (const t of tampered) {
      expect(verifyRelayDirectory(t, trust)).toEqual({ ok: false, reason: 'bad-signature' });
    }
  });

  test('a directory signed by another key is refused', () => {
    const other = generateSigningKeyPair();
    expect(verifyRelayDirectory(signRelayDirectory(unsigned(), other.secretKey), trust)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    expect(verifyRelayDirectory(signed(), { ...trust, trustedKeys: [] })).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  test('unsigned and malformed documents are refused', () => {
    const doc = signed();
    const { signature: _drop, ...unsignedDoc } = doc;
    const bad: unknown[] = [
      null,
      [],
      'x',
      unsignedDoc,
      { ...doc, signature: '' },
      { ...doc, signature: doc.signature.slice(0, -2) },
      { ...doc, v: 2 },
      { ...doc, serial: 0 },
      { ...doc, serial: 1.5 },
      { ...doc, extra: 1 },
      { ...doc, expiresAt: doc.issuedAt },
      { ...doc, expiresAt: doc.issuedAt + MAX_DIRECTORY_LIFETIME_SECONDS + 1 },
      { ...doc, relays: [{ ...doc.relays[0], extra: true }] },
      { ...doc, relays: [{ ...doc.relays[0], operator: 'root' }] },
      { ...doc, relays: [{ ...doc.relays[0], endpoint: 'https://relay.example' }] },
      { ...doc, relays: [{ ...doc.relays[0], relayKey: 'AAAA' }] },
      // Non-canonical base64 of the same key (trailing bits set).
      { ...doc, relays: [{ ...doc.relays[0], relayKey: nonCanonical(doc.relays[0].relayKey) }] },
      { ...doc, relays: [{ ...doc.relays[0], capabilities: ['Tunnel'] }] },
      { ...doc, relays: [{ ...doc.relays[0], capabilities: ['tunnel', 'tunnel'] }] },
      { ...doc, relays: [{ ...doc.relays[0], region: 'line\nbreak' }] },
      { ...doc, relays: [doc.relays[0], doc.relays[0]] },
    ];
    for (const value of bad) {
      expect(verifyRelayDirectory(value, trust).ok).toBe(false);
    }
  });

  test('oversized directories are refused, and never signed', () => {
    const many = Array.from({ length: MAX_DIRECTORY_RELAYS + 1 }, (_, i) => ({
      endpoint: `wss://r${i}.example.com`,
      relayKey: encodeBase64(relayKey.publicKey),
      operator: 'community' as const,
      capabilities: ['tunnel'],
      region: '',
    }));
    expect(() => signRelayDirectory(unsigned({ relays: many }), directoryKey.secretKey)).toThrow();
    const ok = signed();
    expect(verifyRelayDirectory({ ...ok, relays: many }, trust)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    // Long fields within the count also hit a bound.
    const long = { ...ok.relays[0], endpoint: `wss://${'a'.repeat(600)}.example` };
    expect(verifyRelayDirectory({ ...ok, relays: [long] }, trust).ok).toBe(false);
  });

  test('canonical bytes are domain-separated and length-prefixed', () => {
    const bytes = canonicalRelayDirectoryBytes(unsigned());
    expect(new TextDecoder().decode(bytes.subarray(4, 4 + 22))).toBe('tnp-relay-directory-v1');
  });
});

describe('relay identity proof', () => {
  const endpoint = 'wss://relay.tnp.network';

  test('verifies for the endpoint, nonce and key it was made for', () => {
    const nonce = randomBytes(32);
    const sig = signRelayIdentity(
      { endpoint, nonce, relayKey: relayKey.publicKey },
      relayKey.secretKey,
    );
    expect(verifyRelayIdentity({ endpoint, nonce, relayKey: relayKey.publicKey }, sig)).toBe(true);
  });

  test('a forged proof (another key) does not verify for the directory key', () => {
    const nonce = randomBytes(32);
    const impostor = generateSigningKeyPair();
    const sig = signRelayIdentity(
      { endpoint, nonce, relayKey: impostor.publicKey },
      impostor.secretKey,
    );
    expect(verifyRelayIdentity({ endpoint, nonce, relayKey: relayKey.publicKey }, sig)).toBe(false);
    expect(() =>
      signRelayIdentity({ endpoint, nonce, relayKey: relayKey.publicKey }, impostor.secretKey),
    ).toThrow();
  });

  test('a replayed proof (another connection nonce) does not verify', () => {
    const sig = signRelayIdentity(
      { endpoint, nonce: randomBytes(32), relayKey: relayKey.publicKey },
      relayKey.secretKey,
    );
    expect(
      verifyRelayIdentity({ endpoint, nonce: randomBytes(32), relayKey: relayKey.publicKey }, sig),
    ).toBe(false);
  });

  test('a proof for another endpoint does not verify', () => {
    const nonce = randomBytes(32);
    const sig = signRelayIdentity(
      { endpoint: 'wss://other.example', nonce, relayKey: relayKey.publicKey },
      relayKey.secretKey,
    );
    expect(verifyRelayIdentity({ endpoint, nonce, relayKey: relayKey.publicKey }, sig)).toBe(false);
  });

  test('malformed input is false, never a throw', () => {
    expect(
      verifyRelayIdentity(
        { endpoint, nonce: new Uint8Array(31), relayKey: relayKey.publicKey },
        new Uint8Array(64),
      ),
    ).toBe(false);
    expect(
      verifyRelayIdentity(
        { endpoint, nonce: randomBytes(32), relayKey: relayKey.publicKey },
        new Uint8Array(10),
      ),
    ).toBe(false);
  });
});

describe('registry key proof', () => {
  const statement = {
    purpose: 'register' as const,
    endpoint: 'wss://community.example.org',
    relayKey: relayKey.publicKey,
    issuedAt: NOW,
  };

  test('verifies, and is bound to purpose, endpoint, key and time', () => {
    const sig = signRelayRegistryProof(statement, relayKey.secretKey);
    expect(verifyRelayRegistryProof(statement, sig)).toBe(true);
    expect(verifyRelayRegistryProof({ ...statement, purpose: 'heartbeat' }, sig)).toBe(false);
    expect(verifyRelayRegistryProof({ ...statement, endpoint: 'wss://x.example.org' }, sig)).toBe(
      false,
    );
    expect(verifyRelayRegistryProof({ ...statement, issuedAt: NOW + 1 }, sig)).toBe(false);
    expect(
      verifyRelayRegistryProof({ ...statement, relayKey: generateSigningKeyPair().publicKey }, sig),
    ).toBe(false);
    expect(verifyRelayRegistryProof(statement, 'not base64')).toBe(false);
  });

  test('is not interchangeable with an identity proof', () => {
    const nonce = randomBytes(32);
    const identity = signRelayIdentity(
      { endpoint: statement.endpoint, nonce, relayKey: relayKey.publicKey },
      relayKey.secretKey,
    );
    expect(verifyRelayRegistryProof(statement, encodeBase64(identity))).toBe(false);
  });
});

describe('seeds', () => {
  test('a seed yields the same key pair as its 64-byte secret form', () => {
    const seed = randomBytes(32);
    const kp = signingKeyPairFromSeed(seed);
    expect(kp.secretKey.subarray(0, 32)).toEqual(seed);
    expect(signingKeyPairFromSeedBase64(encodeBase64(seed)).publicKey).toEqual(kp.publicKey);
    expect(() => signingKeyPairFromSeed(new Uint8Array(31))).toThrow();
    expect(() => signingKeyPairFromSeedBase64('AAAA')).toThrow();
  });

  test('matches the RFC 8032 test vector 1', () => {
    const seed = Buffer.from(
      '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
      'hex',
    );
    expect(
      Buffer.from(signingKeyPairFromSeed(new Uint8Array(seed)).publicKey).toString('hex'),
    ).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  });
});

describe('service relay binding', () => {
  const node = generateSigningKeyPair();
  const binding = (overrides: { endpoint?: string; issuedAt?: number } = {}) =>
    signServiceRelayBinding(
      'example.ox',
      {
        endpoint: overrides.endpoint ?? 'wss://relay.tnp.network',
        relayKey: relayKey.publicKey,
        issuedAt: overrides.issuedAt ?? NOW,
      },
      node,
    );

  test('verifies for the name, under the node key, while fresh', () => {
    const r = verifyServiceRelayBinding('example.ox', binding(), node.publicKey, NOW + 5);
    expect(r.ok && r.endpoint).toBe('wss://relay.tnp.network');
    expect(r.ok && r.relayKey).toEqual(relayKey.publicKey);
  });

  test('another name, another node key, tampering, staleness and future dating are refused', () => {
    const b = binding();
    expect(verifyServiceRelayBinding('other.ox', b, node.publicKey, NOW).ok).toBe(false);
    expect(
      verifyServiceRelayBinding('example.ox', b, generateSigningKeyPair().publicKey, NOW),
    ).toEqual({ ok: false, reason: 'bad-signature' });
    expect(
      verifyServiceRelayBinding(
        'example.ox',
        { ...b, endpoint: 'wss://evil.example' },
        node.publicKey,
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'bad-signature' });
    expect(
      verifyServiceRelayBinding(
        'example.ox',
        b,
        node.publicKey,
        NOW + MAX_RELAY_BINDING_AGE_SECONDS + 1,
      ),
    ).toEqual({ ok: false, reason: 'stale' });
    expect(
      verifyServiceRelayBinding(
        'example.ox',
        binding({ issuedAt: NOW + 3600 }),
        node.publicKey,
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'not-yet-valid' });
    for (const bad of [
      null,
      'x',
      { ...b, extra: 1 },
      { ...b, signature: 'AAAA' },
      { ...b, issuedAt: -1 },
    ]) {
      expect(verifyServiceRelayBinding('example.ox', bad, node.publicKey, NOW).ok).toBe(false);
    }
  });
});
