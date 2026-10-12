import { describe, expect, test } from 'bun:test';
import { decodeBase64Strict, encodeBase64 } from './encoding';
import {
  clampWireGuardPrivateKey,
  generateWireGuardKeyPair,
  isValidWireGuardPublicKey,
  wireGuardPublicKey,
} from './wireguard';

const hex = (s: string) =>
  Uint8Array.from(s.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? []);

describe('WireGuard keys', () => {
  test('the public key matches the RFC 7748 §6.1 test vector', () => {
    const alicePrivate = encodeBase64(
      hex('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a'),
    );
    const alicePublic = encodeBase64(
      hex('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a'),
    );
    expect(wireGuardPublicKey(alicePrivate)).toBe(alicePublic);
  });

  test('a generated pair is two canonical 32-byte keys, clamped like `wg genkey`', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 64; i++) {
      const pair = generateWireGuardKeyPair();
      const secret = decodeBase64Strict(pair.privateKey, 32);
      expect(decodeBase64Strict(pair.publicKey, 32)).toHaveLength(32);
      expect(pair.privateKey).toHaveLength(44);
      expect(pair.publicKey).toHaveLength(44);
      expect(secret[0] & 7).toBe(0);
      expect(secret[31] & 128).toBe(0);
      expect(secret[31] & 64).toBe(64);
      expect(wireGuardPublicKey(pair.privateKey)).toBe(pair.publicKey);
      expect(isValidWireGuardPublicKey(pair.publicKey)).toBe(true);
      seen.add(pair.privateKey);
    }
    expect(seen.size).toBe(64);
  });

  test('clamping is the RFC 7748 decodeScalar25519 mask', () => {
    const clamped = clampWireGuardPrivateKey(new Uint8Array(32).fill(0xff));
    expect(clamped[0]).toBe(0xf8);
    expect(clamped[31]).toBe(0x7f);
    expect(clampWireGuardPrivateKey(new Uint8Array(32))[31]).toBe(0x40);
    expect(() => clampWireGuardPrivateKey(new Uint8Array(31))).toThrow();
  });

  test('public-key validation refuses anything but a canonical, large-order 32-byte key', () => {
    const good = generateWireGuardKeyPair().publicKey;
    const bad: unknown[] = [
      undefined,
      42,
      '',
      good.slice(0, 43),
      `${good}=`,
      good.replace(/=$/, ''),
      `${good.slice(0, 42)}-=`,
      ` ${good.slice(1)}`,
      encodeBase64(new Uint8Array(32)),
      encodeBase64(hex('0100000000000000000000000000000000000000000000000000000000000000')),
      encodeBase64(hex('edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f')),
      encodeBase64(new Uint8Array(33)).slice(0, 44),
    ];
    for (const value of bad) expect(isValidWireGuardPublicKey(value)).toBe(false);
    // A non-zero trailing bit spells the same bytes another way: refused.
    const last = good.charAt(42);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const respelled = `${good.slice(0, 42)}${alphabet[alphabet.indexOf(last) | 1]}=`;
    expect(respelled).not.toBe(good);
    expect(isValidWireGuardPublicKey(respelled)).toBe(false);
  });
});
