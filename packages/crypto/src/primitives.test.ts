import { describe, expect, test } from 'bun:test';
import { decodeBase64Strict, EncodingError, encodeBase64 } from './encoding';
import {
  aeadOpen,
  aeadSeal,
  assertValidX25519PublicKey,
  generateX25519KeyPair,
  KeyAgreementError,
  x25519,
} from './primitives';
import { isValidScope, scopeCovers } from './scope';

const hex = (s: string) =>
  Uint8Array.from(s.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? []);

/**
 * The canonical small-order u-coordinates on Curve25519 (the libsodium
 * blocklist, minus the non-canonical encodings, which are refused separately).
 */
const LOW_ORDER = [
  '0000000000000000000000000000000000000000000000000000000000000000', // 0
  '0100000000000000000000000000000000000000000000000000000000000000', // 1
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800', // order 8
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157', // order 8
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // p - 1
];

/** Encodings of real points that are not canonical: >= p, or the top bit set. */
const NON_CANONICAL = [
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // p (≡ 0)
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // p + 1 (≡ 1)
  '0900000000000000000000000000000000000000000000000000000000000080', // 9 with top bit
];

describe('X25519 rejects keys that yield a predictable secret', () => {
  test('every small-order point is refused as a long-lived key', () => {
    for (const point of LOW_ORDER) {
      expect(() => assertValidX25519PublicKey(hex(point))).toThrow(KeyAgreementError);
    }
  });

  test('every small-order point is refused as a DH peer, including all-zero', () => {
    // tweetnacl alone computes these and returns all zeros, whatever our secret.
    const { secretKey } = generateX25519KeyPair();
    for (const point of LOW_ORDER) {
      expect(() => x25519(secretKey, hex(point))).toThrow(KeyAgreementError);
    }
  });

  test('non-canonical encodings are refused', () => {
    const { secretKey } = generateX25519KeyPair();
    for (const point of NON_CANONICAL) {
      expect(() => assertValidX25519PublicKey(hex(point))).toThrow(/canonical/);
      expect(() => x25519(secretKey, hex(point))).toThrow(/canonical/);
    }
  });

  test('the base point and fresh keys pass (the probe is not a multiple of the group order)', () => {
    assertValidX25519PublicKey(hex(`09${'00'.repeat(31)}`));
    for (let i = 0; i < 20; i++) assertValidX25519PublicKey(generateX25519KeyPair().publicKey);
  });

  test('both sides agree on a shared secret', () => {
    const a = generateX25519KeyPair();
    const b = generateX25519KeyPair();
    expect(encodeBase64(x25519(a.secretKey, b.publicKey))).toBe(
      encodeBase64(x25519(b.secretKey, a.publicKey)),
    );
  });
});

describe('AEAD', () => {
  test('RFC 8439 §2.8.2 test vector', () => {
    const key = hex('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f');
    const nonce = hex('070000004041424344454647');
    const ad = hex('50515253c0c1c2c3c4c5c6c7');
    const plaintext = new TextEncoder().encode(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
    );
    const sealed = aeadSeal(key, nonce, ad, plaintext);
    const tag = [...sealed.subarray(sealed.length - 16)]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(tag).toBe('1ae10b594f09e26a7e902ecbd0600691');
    expect(new TextDecoder().decode(aeadOpen(key, nonce, ad, sealed) ?? new Uint8Array())).toBe(
      new TextDecoder().decode(plaintext),
    );
  });

  test('a tampered byte, wrong AD or short input returns null rather than throwing', () => {
    const key = new Uint8Array(32).fill(1);
    const nonce = new Uint8Array(12);
    const sealed = aeadSeal(key, nonce, new Uint8Array([1]), new Uint8Array([1, 2, 3]));
    const flipped = sealed.slice();
    flipped[0] ^= 1;
    expect(aeadOpen(key, nonce, new Uint8Array([1]), flipped)).toBeNull();
    expect(aeadOpen(key, nonce, new Uint8Array([2]), sealed)).toBeNull();
    expect(aeadOpen(key, nonce, new Uint8Array([1]), sealed.subarray(0, 10))).toBeNull();
  });
});

describe('strict base64', () => {
  test('round-trips every length', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 0xff);
      const s = encodeBase64(bytes);
      expect(s).toBe(Buffer.from(bytes).toString('base64'));
      expect([...decodeBase64Strict(s)]).toEqual([...bytes]);
    }
  });

  test('refuses every spelling Node would leniently accept', () => {
    // All of these decode to the same bytes as '+/8=' under Buffer.from(…, 'base64').
    for (const lenient of ['-_8=', '+/8', '+/8= ', ' +/8=', '+/9=', '+/8==', '+/\n8=']) {
      expect(() => decodeBase64Strict(lenient)).toThrow(EncodingError);
    }
    expect([...decodeBase64Strict('+/8=')]).toEqual([0xfb, 0xff]);
  });

  test('enforces an expected length', () => {
    expect(() => decodeBase64Strict(encodeBase64(new Uint8Array(31)), 32)).toThrow(/32 bytes/);
  });
});

describe('scopes', () => {
  test('canonical names only', () => {
    for (const ok of ['ox', 'example.ox', 'a-b.example.ox', 'xn--bcher-kva.ox', '0.ox']) {
      expect(isValidScope(ok)).toBe(true);
    }
    for (const bad of [
      '',
      'Example.ox',
      'example.ox.',
      '.example.ox',
      'a..ox',
      '-a.ox',
      'a-.ox',
      'a_b.ox',
      'é.ox',
      `${'a'.repeat(64)}.ox`,
      `${'a.'.repeat(127)}ox`,
      42,
    ]) {
      expect(isValidScope(bad)).toBe(false);
    }
  });

  test('covering is at a label boundary', () => {
    expect(scopeCovers('example.ox', 'example.ox')).toBe(true);
    expect(scopeCovers('example.ox', 'a.b.example.ox')).toBe(true);
    expect(scopeCovers('example.ox', 'badexample.ox')).toBe(false);
    expect(scopeCovers('www.example.ox', 'example.ox')).toBe(false);
    expect(scopeCovers('example.ox', 'Example.ox')).toBe(false);
  });
});
