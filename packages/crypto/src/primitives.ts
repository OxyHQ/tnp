/**
 * The cryptographic primitives TNP uses, behind one narrow interface.
 *
 * Normative spec: docs/architecture/security.md §3.
 *
 * | Purpose       | Primitive          | Implementation                      |
 * |---------------|--------------------|-------------------------------------|
 * | Signatures    | Ed25519            | tweetnacl                           |
 * | Key agreement | X25519             | tweetnacl                           |
 * | AEAD          | ChaCha20-Poly1305  | @noble/ciphers (RFC 8439)           |
 * | Hash / HMAC   | SHA-256            | @noble/hashes                       |
 * | KDF           | HKDF-SHA256        | @noble/hashes (RFC 5869)            |
 * | Randomness    | platform CSPRNG    | tweetnacl → crypto.getRandomValues  |
 *
 * All pure JavaScript, so the same code runs on Bun, Node, browsers and React
 * Native. Nothing in this file is a custom construction; anything built from
 * these primitives lives in a named, specified place (the Noise handshake in
 * `@tnp/protocol/v1`, grants and key-agreement certificates here).
 */

import { chacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2';
import nacl from 'tweetnacl';

export const X25519_KEY_LENGTH = 32;
export const AEAD_KEY_LENGTH = 32;
export const AEAD_TAG_LENGTH = 16;
export const SHA256_LENGTH = 32;

/** A key-agreement operation was refused. */
export class KeyAgreementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyAgreementError';
  }
}

export interface X25519KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function randomBytes(length: number): Uint8Array {
  return nacl.randomBytes(length);
}

/** A fresh X25519 key pair from the platform CSPRNG. */
export function generateX25519KeyPair(): X25519KeyPair {
  const kp = nacl.box.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/** The X25519 key pair for a given 32-byte secret (tests and key storage). */
export function x25519KeyPairFromSecret(secretKey: Uint8Array): X25519KeyPair {
  if (secretKey.length !== X25519_KEY_LENGTH) {
    throw new KeyAgreementError('X25519 secret key must be 32 bytes');
  }
  return { publicKey: nacl.scalarMult.base(secretKey), secretKey: secretKey.slice() };
}

const P = (1n << 255n) - 19n;

function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

/**
 * Throw unless `publicKey` is a canonical X25519 encoding: 32 bytes, top bit
 * clear, u-coordinate below 2^255 − 19.
 *
 * RFC 7748 tells a receiver to MASK the top bit and reduce, which means
 * several byte strings name the same point. Every key TNP handles is either
 * signed or hashed into a transcript, so it is refused instead: one point, one
 * spelling.
 */
export function assertCanonicalX25519(publicKey: Uint8Array): void {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== X25519_KEY_LENGTH) {
    throw new KeyAgreementError('X25519 public key must be 32 bytes');
  }
  if ((publicKey[31] & 0x80) !== 0 || littleEndianToBigInt(publicKey) >= P) {
    throw new KeyAgreementError('X25519 public key is not canonically encoded');
  }
}

/**
 * Fixed probe scalar for the low-order test — SHA-256 of a label, so it is
 * visibly not chosen. After X25519 clamping it is a multiple of the cofactor
 * 8 and (with overwhelming probability, and in fact for this value) not a
 * multiple of the prime subgroup order, so `probe · P` is the identity exactly
 * when P has small order.
 */
const LOW_ORDER_PROBE = nobleSha256(new TextEncoder().encode('tnp-x25519-low-order-probe-v1'));

/**
 * Throw unless `publicKey` is a canonical X25519 key of large order.
 *
 * tweetnacl happily computes with the all-zero key (and the other small-order
 * points), and the "shared secret" it produces is the all-zero string no
 * matter whose secret key is used — a constant an attacker knows. Used for
 * long-lived keys at certification time; per-session DH outputs are checked by
 * `x25519` itself.
 */
export function assertValidX25519PublicKey(publicKey: Uint8Array): void {
  assertCanonicalX25519(publicKey);
  if (isAllZero(nacl.scalarMult(LOW_ORDER_PROBE, publicKey))) {
    throw new KeyAgreementError('X25519 public key has small order');
  }
}

/**
 * X25519(secretKey, peerPublicKey), refusing any input that would yield a
 * predictable secret.
 *
 * Every small-order point, including the all-zero key, sends a clamped scalar
 * to the identity, whose encoding is all zeros; checking the output therefore
 * rejects the whole class (RFC 7748 §6.1). The check is constant-time in the
 * output so it reveals nothing about a legitimate secret.
 */
export function x25519(secretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  if (secretKey.length !== X25519_KEY_LENGTH) {
    throw new KeyAgreementError('X25519 secret key must be 32 bytes');
  }
  assertCanonicalX25519(peerPublicKey);
  const shared = nacl.scalarMult(secretKey, peerPublicKey);
  if (isAllZero(shared)) {
    throw new KeyAgreementError('X25519 produced the all-zero output (small-order peer key)');
  }
  return shared;
}

function isAllZero(bytes: Uint8Array): boolean {
  let acc = 0;
  for (const b of bytes) acc |= b;
  return acc === 0;
}

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(nobleSha256, key, data);
}

/** RFC 5869 HKDF-SHA256. */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  return hkdf(nobleSha256, ikm, salt, info, length);
}

/**
 * ChaCha20-Poly1305 (RFC 8439) with a 12-byte nonce.
 *
 * The 96-bit nonce is safe ONLY because every caller derives it from a
 * per-key counter that never repeats (security.md §3); nothing in TNP uses a
 * random nonce with this function.
 */
export function aeadSeal(
  key: Uint8Array,
  nonce: Uint8Array,
  associatedData: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  return chacha20poly1305(key, nonce, associatedData).encrypt(plaintext);
}

/** Inverse of `aeadSeal`. Returns null — never throws — when the tag does not verify. */
export function aeadOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  associatedData: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array | null {
  if (ciphertext.length < AEAD_TAG_LENGTH) return null;
  try {
    return chacha20poly1305(key, nonce, associatedData).decrypt(ciphertext);
  } catch {
    return null;
  }
}

/** Best-effort erasure of key material. JavaScript gives no guarantee beyond this. */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

export { constantTimeEqual } from './encoding.js';
