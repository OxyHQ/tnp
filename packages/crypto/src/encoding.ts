/**
 * Strict encodings for everything that is signed or compared.
 *
 * Normative spec: docs/architecture/security.md §1 ("Canonical encoding").
 *
 * Two rules, both of which the previous grant code broke:
 *
 *  1. **One value, one encoding.** Node's base64 decoder is lenient: it accepts
 *     the URL-safe alphabet (`-_` decode the same as `+/`), missing padding,
 *     embedded whitespace and non-zero trailing bits. So one 32-byte key had
 *     many string spellings, and a revocation list or a trusted-root list
 *     compared as strings could be walked around by re-spelling a revoked key.
 *     Here a string is accepted only if decoding and re-encoding it gives back
 *     exactly the same string.
 *  2. **Keys are bytes, at a fixed length.** A key is decoded once, at the
 *     boundary, into exactly 32 raw bytes. Everything after that compares
 *     bytes. A key that is not 32 bytes is malformed — it is never truncated,
 *     padded or "probably fine".
 *
 * Pure and dependency-free (no `Buffer`), so it runs unchanged on Bun, Node,
 * browsers and React Native.
 */

/** Ed25519 and X25519 public keys are both 32 bytes. */
export const PUBLIC_KEY_LENGTH = 32;

/** Ed25519 detached signature length. */
export const SIGNATURE_LENGTH = 64;

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DECODE = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) DECODE[ALPHABET.charCodeAt(i)] = i;

/** A value failed strict decoding. The message never echoes the input. */
export class EncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncodingError';
  }
}

/** Standard-alphabet, padded base64 (RFC 4648 §4). */
export function encodeBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    out += ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += `${ALPHABET[(n >> 18) & 63]}${ALPHABET[(n >> 12) & 63]}==`;
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += `${ALPHABET[(n >> 18) & 63]}${ALPHABET[(n >> 12) & 63]}${ALPHABET[(n >> 6) & 63]}=`;
  }
  return out;
}

/**
 * Decode canonical base64, or throw.
 *
 * Canonical means: standard alphabet only, `=` padding present and correct,
 * no whitespace, and zero trailing bits — i.e. `encodeBase64(decode(s)) === s`.
 * That last check is the one that matters; the others make it cheap to fail
 * early.
 */
export function decodeBase64Strict(value: string, expectedLength?: number): Uint8Array {
  if (typeof value !== 'string') throw new EncodingError('expected a base64 string');
  if (value.length % 4 !== 0) throw new EncodingError('base64 length is not a multiple of 4');

  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((value.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < value.length; i += 4) {
    let n = 0;
    for (let j = 0; j < 4; j++) {
      const c = value.charCodeAt(i + j);
      const isPad = c === 61 /* '=' */ && i + 4 === value.length && j >= 4 - padding;
      const d = isPad ? 0 : c < 128 ? DECODE[c] : -1;
      if (d < 0) throw new EncodingError('non-canonical base64 character');
      n = (n << 6) | d;
    }
    if (o < out.length) out[o++] = (n >> 16) & 0xff;
    if (o < out.length) out[o++] = (n >> 8) & 0xff;
    if (o < out.length) out[o++] = n & 0xff;
  }

  // Rejects non-zero trailing bits ("AB==" decodes like "AA==") and anything
  // else that maps two spellings onto one value.
  if (encodeBase64(out) !== value) throw new EncodingError('non-canonical base64');
  if (expectedLength !== undefined && out.length !== expectedLength) {
    throw new EncodingError(`expected ${expectedLength} bytes, got ${out.length}`);
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * A 32-byte public key from its canonical base64 form or from raw bytes.
 *
 * Returns a copy, so a caller mutating its buffer afterwards cannot change a
 * key that has already been checked.
 */
export function parsePublicKey(input: string | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) {
    if (input.length !== PUBLIC_KEY_LENGTH) {
      throw new EncodingError(`public key must be ${PUBLIC_KEY_LENGTH} bytes, got ${input.length}`);
    }
    return input.slice();
  }
  return decodeBase64Strict(input, PUBLIC_KEY_LENGTH);
}

/** Exact byte equality. For PUBLIC values only — secrets use `constantTimeEqual`. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Equality whose running time does not depend on where the inputs differ.
 *
 * Length is not secret here (every caller compares fixed-length values), so a
 * length mismatch returns early.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Throw unless `value` is a non-negative safe integer.
 *
 * The old canonical encoder ran times through `Math.trunc`, so `notAfter:
 * 1800000000.9` signed the same bytes as `1800000000` — the signed value and
 * the value a verifier compared against were different numbers. Non-integers
 * are now refused before anything is signed or checked.
 */
export function assertUint(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new EncodingError(`${label} must be a non-negative safe integer`);
  }
}

const textEncoder = new TextEncoder();

/**
 * Builds a canonical byte string: fixed-width fields and length-prefixed
 * variable fields, in a fixed order.
 *
 * Length prefixes are what stop a field boundary from moving: without them
 * "ab" + "c" and "a" + "bc" serialize identically, so a signature over one
 * verifies the other.
 */
export class CanonicalWriter {
  private readonly parts: Uint8Array[] = [];

  /** u32 length prefix, then UTF-8 bytes. */
  string(value: string): this {
    return this.bytesPrefixed(textEncoder.encode(value));
  }

  /** u32 length prefix, then the bytes. */
  bytesPrefixed(bytes: Uint8Array): this {
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, bytes.length, false);
    this.parts.push(prefix, bytes);
    return this;
  }

  /** Fixed-length bytes, no prefix. Only for fields whose length is part of the format. */
  fixed(bytes: Uint8Array, length: number): this {
    if (bytes.length !== length) throw new EncodingError(`expected ${length} bytes`);
    this.parts.push(bytes);
    return this;
  }

  /** u64 big-endian. */
  uint(value: number, label: string): this {
    assertUint(value, label);
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false);
    this.parts.push(bytes);
    return this;
  }

  finish(): Uint8Array {
    return concatBytes(...this.parts);
  }
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
