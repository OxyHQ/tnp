/**
 * The end-to-end encrypted envelope for a user's personal DNS rules.
 *
 * Normative spec: docs/architecture/naming.md §3 (what a synced rule may do),
 * docs/architecture/security.md §3 (primitives), privacy-model.md §4 (what the
 * API stores). The API stores the envelope and nothing else: it never sees the
 * passphrase, the rules key or a single rule.
 *
 * Construction, all standard parts:
 *
 * - A random 32-byte **rules key** encrypts the rule set. It is created once,
 *   in the browser, and never leaves a device unwrapped.
 * - The rules key is **wrapped** under a key derived from the user's sync
 *   passphrase: Argon2id (RFC 9106; parameters and salt stored beside the wrap)
 *   then HKDF-SHA256 with a purpose label. The wrap's associated data binds
 *   the envelope version, the Oxy user id, the KDF parameters and the salt.
 * - The rule set is sealed with XChaCha20-Poly1305 (random 192-bit nonce)
 *   under an HKDF subkey of the rules key. Its associated data binds the
 *   envelope version, the Oxy user id and the rule-set `version`, and the same
 *   user id and `version` are framed inside the plaintext. So a blob cannot be
 *   moved to another account, and its version cannot be edited without the tag
 *   failing; a reader that remembers the highest version it has seen refuses
 *   an older one (`minVersion`), which is what turns "the server served an old
 *   blob" into an error instead of a silent rollback.
 * - The plaintext is padded to a power-of-two bucket (at least 4 KiB), so the
 *   ciphertext length says little about how many rules there are.
 *
 * Pure JavaScript (`@noble/*`, pinned exactly), so the browser and the CLI run
 * the same code.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { argon2id } from '@noble/hashes/argon2';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { randomBytes } from '@noble/hashes/utils';
import {
  CanonicalWriter,
  constantTimeEqual,
  decodeBase64Strict,
  EncodingError,
  encodeBase64,
} from './encoding.js';

/** Envelope format version (`v`). Authenticated in both associated-data strings. */
export const RULES_ENVELOPE_VERSION = 1;
export const RULES_KEY_LENGTH = 32;
export const RULES_SALT_LENGTH = 16;
export const RULES_NONCE_LENGTH = 24;
const TAG_LENGTH = 16;
/** A wrapped rules key: 24-byte nonce, 32-byte key, 16-byte tag. */
export const RULES_WRAPPED_KEY_LENGTH = RULES_NONCE_LENGTH + RULES_KEY_LENGTH + TAG_LENGTH;
/** Largest ciphertext the API accepts. The plaintext bucket stops 16 bytes short of it. */
export const RULES_MAX_CIPHERTEXT_BYTES = 256 * 1024;
const MAX_PLAINTEXT_BYTES = RULES_MAX_CIPHERTEXT_BYTES - TAG_LENGTH;
const MIN_PLAINTEXT_BUCKET = 4096;

/** Argon2id cost parameters. `m` is in KiB, as RFC 9106 states it. */
export interface RulesKdfParams {
  alg: 'argon2id';
  m: number;
  t: number;
  p: number;
}

/**
 * RFC 9106 §4, second recommended option: 64 MiB, 3 passes, one lane. About
 * 0.8 s in Bun; a few seconds in a phone browser, once per unlock.
 */
export const DEFAULT_RULES_KDF: RulesKdfParams = { alg: 'argon2id', m: 65_536, t: 3, p: 1 };

/**
 * Bounds on parameters read back from the server. The floor is OWASP's
 * minimum Argon2id setting, so a stored envelope can never claim to be
 * protected by less; the ceiling keeps a hostile record from making a device
 * allocate gigabytes.
 */
export const RULES_KDF_LIMITS = {
  m: { min: 19_456, max: 1_048_576 },
  t: { min: 2, max: 10 },
  p: { min: 1, max: 4 },
} as const;

/**
 * What the API stores per Oxy user and hands back. Binary fields are canonical
 * base64 (security.md §1). The same shape is declared as a wire contract in
 * `@tnp/shared-types` (`DnsRulesEnvelope`), which validates it at the API
 * boundary without depending on this package.
 */
export interface RulesEnvelope {
  v: 1;
  kdfParams: RulesKdfParams;
  salt: string;
  wrappedKey: string;
  nonce: string;
  ciphertext: string;
  version: number;
}

export type RulesEnvelopeErrorCode =
  | 'malformed'
  | 'wrong-passphrase'
  | 'tampered'
  | 'rollback'
  | 'too-large';

/** Every refusal in this module. The message never echoes key material or rule contents. */
export class RulesEnvelopeError extends Error {
  constructor(
    readonly code: RulesEnvelopeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RulesEnvelopeError';
  }
}

const encoder = new TextEncoder();
const LABEL_WRAP_KEY = encoder.encode('tnp/dns-rules/v1/wrap-key');
const LABEL_RULE_SET_KEY = encoder.encode('tnp/dns-rules/v1/rule-set-key');
const AAD_WRAP = 'tnp/dns-rules/v1/wrap';
const AAD_RULE_SET = 'tnp/dns-rules/v1/rule-set';
const PLAINTEXT_LABEL = 'tnp/dns-rules/v1/plaintext';

function fail(code: RulesEnvelopeErrorCode, message: string): never {
  throw new RulesEnvelopeError(code, message);
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** Throw unless `params` is Argon2id within `RULES_KDF_LIMITS`. */
export function assertRulesKdfParams(params: unknown): asserts params is RulesKdfParams {
  const p = params as Partial<RulesKdfParams> | null;
  if (typeof p !== 'object' || p === null || p.alg !== 'argon2id') {
    fail('malformed', 'kdfParams must name argon2id');
  }
  const { m, t, p: lanes } = RULES_KDF_LIMITS;
  if (
    !isIntIn(p.m, m.min, m.max) ||
    !isIntIn(p.t, t.min, t.max) ||
    !isIntIn(p.p, lanes.min, lanes.max)
  ) {
    fail('malformed', 'kdfParams are outside the accepted Argon2id range');
  }
}

function assertUserId(userId: string): void {
  if (typeof userId !== 'string' || userId.length === 0 || userId.length > 256) {
    fail('malformed', 'a user id is required');
  }
}

function assertVersion(version: unknown): asserts version is number {
  if (!isIntIn(version, 1, Number.MAX_SAFE_INTEGER)) {
    fail('malformed', 'version must be a positive integer');
  }
}

function decodeField(value: string, label: string, length?: number): Uint8Array {
  try {
    return decodeBase64Strict(value, length);
  } catch (err) {
    if (err instanceof EncodingError)
      fail('malformed', `${label} is not canonical base64 of the right length`);
    throw err;
  }
}

/** A fresh random rules key. */
export function generateRulesKey(): Uint8Array {
  return randomBytes(RULES_KEY_LENGTH);
}

/**
 * The key that wraps the rules key, from the sync passphrase.
 *
 * The passphrase is NFC-normalized first, so the same words typed on two
 * keyboards that compose accents differently derive the same key.
 */
export function deriveWrappingKey(
  passphrase: string,
  salt: Uint8Array,
  params: RulesKdfParams,
): Uint8Array {
  assertRulesKdfParams(params);
  if (salt.length !== RULES_SALT_LENGTH) fail('malformed', 'salt must be 16 bytes');
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    fail('malformed', 'a passphrase is required');
  }
  const stretched = argon2id(encoder.encode(passphrase.normalize('NFC')), salt, {
    m: params.m,
    t: params.t,
    p: params.p,
    dkLen: 32,
  });
  const key = hkdf(sha256, stretched, salt, LABEL_WRAP_KEY, RULES_KEY_LENGTH);
  stretched.fill(0);
  return key;
}

function wrapAad(userId: string, params: RulesKdfParams, salt: Uint8Array): Uint8Array {
  return new CanonicalWriter()
    .string(AAD_WRAP)
    .uint(RULES_ENVELOPE_VERSION, 'v')
    .string(userId)
    .string(params.alg)
    .uint(params.m, 'm')
    .uint(params.t, 't')
    .uint(params.p, 'p')
    .bytesPrefixed(salt)
    .finish();
}

function ruleSetAad(userId: string, version: number): Uint8Array {
  return new CanonicalWriter()
    .string(AAD_RULE_SET)
    .uint(RULES_ENVELOPE_VERSION, 'v')
    .string(userId)
    .uint(version, 'version')
    .finish();
}

function ruleSetKey(rulesKey: Uint8Array): Uint8Array {
  if (rulesKey.length !== RULES_KEY_LENGTH) fail('malformed', 'rules key must be 32 bytes');
  return hkdf(sha256, rulesKey, new Uint8Array(0), LABEL_RULE_SET_KEY, RULES_KEY_LENGTH);
}

/** Smallest power-of-two bucket (at least 4 KiB) that holds `length`, capped at the maximum. */
export function paddedPlaintextLength(length: number): number {
  if (length > MAX_PLAINTEXT_BYTES) {
    fail('too-large', `the rule set is larger than ${RULES_MAX_CIPHERTEXT_BYTES} bytes encrypted`);
  }
  let bucket = MIN_PLAINTEXT_BUCKET;
  while (bucket < length) bucket *= 2;
  return Math.min(bucket, MAX_PLAINTEXT_BYTES);
}

function framePlaintext(userId: string, version: number, body: Uint8Array): Uint8Array {
  const framed = new CanonicalWriter()
    .string(PLAINTEXT_LABEL)
    .string(userId)
    .uint(version, 'version')
    .bytesPrefixed(body)
    .finish();
  const out = new Uint8Array(paddedPlaintextLength(framed.length));
  out.set(framed);
  return out;
}

/** Inverse of `framePlaintext`: the body, after checking the framed user id and version. */
function unframePlaintext(plain: Uint8Array, userId: string, version: number): Uint8Array {
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  let offset = 0;
  const readPrefixed = (): Uint8Array => {
    if (offset + 4 > plain.length) fail('tampered', 'rule set framing is truncated');
    const len = view.getUint32(offset, false);
    offset += 4;
    if (offset + len > plain.length) fail('tampered', 'rule set framing is truncated');
    const bytes = plain.subarray(offset, offset + len);
    offset += len;
    return bytes;
  };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  if (decoder.decode(readPrefixed()) !== PLAINTEXT_LABEL) fail('tampered', 'not a TNP rule set');
  if (decoder.decode(readPrefixed()) !== userId) {
    fail('tampered', 'the rule set belongs to another account');
  }
  if (offset + 8 > plain.length) fail('tampered', 'rule set framing is truncated');
  const framedVersion = Number(view.getBigUint64(offset, false));
  offset += 8;
  if (framedVersion !== version) fail('tampered', 'the rule set version does not match');
  const body = readPrefixed().slice();
  for (let i = offset; i < plain.length; i++) {
    if (plain[i] !== 0) fail('tampered', 'rule set padding is not zero');
  }
  return body;
}

function sealRuleSet(
  rulesKey: Uint8Array,
  userId: string,
  version: number,
  body: Uint8Array,
): { nonce: string; ciphertext: string } {
  const key = ruleSetKey(rulesKey);
  const nonce = randomBytes(RULES_NONCE_LENGTH);
  const plain = framePlaintext(userId, version, body);
  const ciphertext = xchacha20poly1305(key, nonce, ruleSetAad(userId, version)).encrypt(plain);
  plain.fill(0);
  key.fill(0);
  return { nonce: encodeBase64(nonce), ciphertext: encodeBase64(ciphertext) };
}

function wrapKey(
  rulesKey: Uint8Array,
  wrappingKey: Uint8Array,
  userId: string,
  params: RulesKdfParams,
  salt: Uint8Array,
): string {
  const nonce = randomBytes(RULES_NONCE_LENGTH);
  const sealed = xchacha20poly1305(wrappingKey, nonce, wrapAad(userId, params, salt)).encrypt(
    rulesKey,
  );
  const out = new Uint8Array(RULES_WRAPPED_KEY_LENGTH);
  out.set(nonce);
  out.set(sealed, RULES_NONCE_LENGTH);
  return encodeBase64(out);
}

/** Throw unless every field of `envelope` has the shape and length it must have. */
export function assertRulesEnvelope(envelope: RulesEnvelope): void {
  if (typeof envelope !== 'object' || envelope === null || envelope.v !== RULES_ENVELOPE_VERSION) {
    fail('malformed', `unsupported envelope version; expected v${RULES_ENVELOPE_VERSION}`);
  }
  assertRulesKdfParams(envelope.kdfParams);
  assertVersion(envelope.version);
  decodeField(envelope.salt, 'salt', RULES_SALT_LENGTH);
  decodeField(envelope.wrappedKey, 'wrappedKey', RULES_WRAPPED_KEY_LENGTH);
  decodeField(envelope.nonce, 'nonce', RULES_NONCE_LENGTH);
  const ciphertext = decodeField(envelope.ciphertext, 'ciphertext');
  if (ciphertext.length < TAG_LENGTH + MIN_PLAINTEXT_BUCKET)
    fail('malformed', 'ciphertext is too short');
  if (ciphertext.length > RULES_MAX_CIPHERTEXT_BYTES) fail('too-large', 'ciphertext is too large');
}

/**
 * A brand-new rule set: a fresh rules key wrapped under `passphrase`, and
 * `body` sealed as version 1.
 */
export function createRulesEnvelope(options: {
  passphrase: string;
  userId: string;
  body: Uint8Array;
  kdfParams?: RulesKdfParams;
}): { envelope: RulesEnvelope; rulesKey: Uint8Array } {
  const { passphrase, userId, body } = options;
  const kdfParams = options.kdfParams ?? DEFAULT_RULES_KDF;
  assertUserId(userId);
  assertRulesKdfParams(kdfParams);
  const salt = randomBytes(RULES_SALT_LENGTH);
  const rulesKey = generateRulesKey();
  const wrappingKey = deriveWrappingKey(passphrase, salt, kdfParams);
  const wrappedKey = wrapKey(rulesKey, wrappingKey, userId, kdfParams, salt);
  wrappingKey.fill(0);
  const sealed = sealRuleSet(rulesKey, userId, 1, body);
  return {
    envelope: {
      v: RULES_ENVELOPE_VERSION,
      kdfParams: { ...kdfParams },
      salt: encodeBase64(salt),
      wrappedKey,
      ...sealed,
      version: 1,
    },
    rulesKey,
  };
}

/**
 * Recover the rules key with the sync passphrase. A wrong passphrase and an
 * altered wrap are the same failure: the tag does not verify.
 */
export function unlockRulesKey(options: {
  passphrase: string;
  userId: string;
  envelope: RulesEnvelope;
}): Uint8Array {
  const { passphrase, userId, envelope } = options;
  assertUserId(userId);
  assertRulesEnvelope(envelope);
  const salt = decodeField(envelope.salt, 'salt', RULES_SALT_LENGTH);
  const wrapped = decodeField(envelope.wrappedKey, 'wrappedKey', RULES_WRAPPED_KEY_LENGTH);
  const wrappingKey = deriveWrappingKey(passphrase, salt, envelope.kdfParams);
  try {
    return xchacha20poly1305(
      wrappingKey,
      wrapped.subarray(0, RULES_NONCE_LENGTH),
      wrapAad(userId, envelope.kdfParams, salt),
    ).decrypt(wrapped.subarray(RULES_NONCE_LENGTH));
  } catch {
    return fail('wrong-passphrase', 'wrong passphrase, or the stored key was altered');
  } finally {
    wrappingKey.fill(0);
  }
}

/**
 * Decrypt the rule set with the rules key.
 *
 * `minVersion` is the highest version this reader has already accepted; an
 * envelope older than that is refused as a rollback before anything is
 * decrypted. An equal version is accepted (the same blob, read again).
 */
export function openRulesEnvelope(options: {
  rulesKey: Uint8Array;
  userId: string;
  envelope: RulesEnvelope;
  minVersion?: number;
}): Uint8Array {
  const { rulesKey, userId, envelope, minVersion = 0 } = options;
  assertUserId(userId);
  assertRulesEnvelope(envelope);
  if (envelope.version < minVersion) {
    fail(
      'rollback',
      `the server offered rule set version ${envelope.version}, older than version ${minVersion} already seen; refusing it`,
    );
  }
  const key = ruleSetKey(rulesKey);
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(
      key,
      decodeField(envelope.nonce, 'nonce', RULES_NONCE_LENGTH),
      ruleSetAad(userId, envelope.version),
    ).decrypt(decodeField(envelope.ciphertext, 'ciphertext'));
  } catch {
    return fail(
      'tampered',
      'the rule set does not decrypt with this key: it was altered, belongs to another account, or was re-created with a new passphrase',
    );
  } finally {
    key.fill(0);
  }
  try {
    return unframePlaintext(plain, userId, envelope.version);
  } finally {
    plain.fill(0);
  }
}

/**
 * The next version of an existing rule set: same rules key and wrap, a new
 * nonce, `version` incremented. The API accepts it only if `previous` is
 * still the stored version (optimistic concurrency).
 */
export function resealRulesEnvelope(options: {
  rulesKey: Uint8Array;
  userId: string;
  previous: RulesEnvelope;
  body: Uint8Array;
}): RulesEnvelope {
  const { rulesKey, userId, previous, body } = options;
  assertUserId(userId);
  assertRulesEnvelope(previous);
  const version = previous.version + 1;
  assertVersion(version);
  return {
    v: RULES_ENVELOPE_VERSION,
    kdfParams: { ...previous.kdfParams },
    salt: previous.salt,
    wrappedKey: previous.wrappedKey,
    ...sealRuleSet(rulesKey, userId, version, body),
    version,
  };
}

/** Whether two rules keys are the same key, without a timing side channel. */
export function sameRulesKey(a: Uint8Array, b: Uint8Array): boolean {
  return constantTimeEqual(a, b);
}

/** SHA-256 of the ciphertext, hex: what a reader remembers to notice a forked history. */
export function rulesCiphertextDigest(envelope: RulesEnvelope): string {
  const digest = sha256(decodeField(envelope.ciphertext, 'ciphertext'));
  let out = '';
  for (const b of digest) out += b.toString(16).padStart(2, '0');
  return out;
}
