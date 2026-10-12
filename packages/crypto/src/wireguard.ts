/**
 * WireGuard key material for the standard-tier VPN (docs/architecture/vpn.md §10).
 *
 * A WireGuard key is a raw X25519 key, written as canonical base64 of its 32
 * bytes — the same text `wg genkey` / `wg pubkey` print. The private key is
 * generated where the tunnel will run (the browser, the CLI) and never leaves
 * it: the registry is sent the public key only.
 *
 * The private key is clamped exactly as `wg genkey` clamps it (RFC 7748 §5),
 * so a key made here is byte-for-byte the kind of key WireGuard itself makes.
 * X25519 clamps on use anyway, so this changes no public key; it only means a
 * config written here and one written by `wg` cannot be told apart.
 */

import { encodeBase64, decodeBase64Strict, EncodingError } from './encoding.js';
import { assertValidX25519PublicKey, randomBytes, x25519KeyPairFromSecret } from './primitives.js';

export interface WireGuardKeyPair {
  /** Canonical base64 of the clamped 32-byte private key. Never sent anywhere. */
  privateKey: string;
  /** Canonical base64 of the 32-byte public key. */
  publicKey: string;
}

/** Clamp a 32-byte X25519 scalar in place, as `wg genkey` does. */
export function clampWireGuardPrivateKey(secret: Uint8Array): Uint8Array {
  if (secret.length !== 32) throw new EncodingError('WireGuard private key must be 32 bytes');
  secret[0] &= 248;
  secret[31] = (secret[31] & 127) | 64;
  return secret;
}

/** The public key for a WireGuard private key (base64 in, base64 out), like `wg pubkey`. */
export function wireGuardPublicKey(privateKey: string): string {
  const secret = decodeBase64Strict(privateKey, 32);
  try {
    return encodeBase64(x25519KeyPairFromSecret(secret).publicKey);
  } finally {
    secret.fill(0);
  }
}

/** A fresh WireGuard key pair from the platform CSPRNG. */
export function generateWireGuardKeyPair(): WireGuardKeyPair {
  const secret = clampWireGuardPrivateKey(randomBytes(32));
  try {
    const { publicKey } = x25519KeyPairFromSecret(secret);
    return { privateKey: encodeBase64(secret), publicKey: encodeBase64(publicKey) };
  } finally {
    secret.fill(0);
  }
}

/**
 * Whether `value` is a WireGuard public key TNP accepts: canonical base64 of
 * 32 bytes that encode a canonical X25519 point of large order. The all-zero
 * key and the other small-order points are refused — no real `wg pubkey`
 * output is one of them.
 */
export function isValidWireGuardPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 44) return false;
  try {
    assertValidX25519PublicKey(decodeBase64Strict(value, 32));
    return true;
  } catch {
    return false;
  }
}
