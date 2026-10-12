/**
 * Domain keys and their rotation statements.
 *
 * Normative spec: docs/architecture/security.md §1 ("Domain keys and pinning").
 *
 * A domain key is an Ed25519 key generated on the domain owner's device. It is
 * the ROOT of every grant chain for that name: there is no Oxy root above it,
 * so a compelled registry cannot mint a key that verifies for someone else's
 * domain. The registry only publishes the domain key; clients pin it on first
 * use (trust on first use, like SSH `known_hosts`) and afterwards accept a
 * different key for that name ONLY through a chain of rotation statements,
 * each signed by the key it replaces.
 *
 *   domain key (Ed25519, owner's device)
 *        │ grant, purpose service-node, scope = the name
 *        ▼
 *   node key (Ed25519, per service node)
 *        │ key-agreement certificate (key-agreement.ts)
 *        ▼
 *   X25519 key the session handshake runs against
 *
 * A rotation statement:
 *
 *   u32 len ‖ "tnp-domain-key-rotation-v1"
 *   u32 len ‖ name
 *   previousKey (32 raw bytes) ‖ nextKey (32 raw bytes)
 *   u64 issuedAt                                   (big-endian, Unix seconds)
 *
 * signed by `previousKey`.
 */

import nacl from 'tweetnacl';
import {
  assertUint,
  bytesEqual,
  CanonicalWriter,
  decodeBase64Strict,
  EncodingError,
  encodeBase64,
  PUBLIC_KEY_LENGTH,
  parsePublicKey,
  SIGNATURE_LENGTH,
  toHex,
} from './encoding.js';
import { assertSecretMatches } from './grants.js';
import { sha256 } from './primitives.js';
import { isValidScope } from './scope.js';

/** Domain-separation tag; distinct from grants, certificates and relay auth. */
const ROTATION_CONTEXT = 'tnp-domain-key-rotation-v1';

/**
 * Most rotation statements the registry keeps (and serves) per name. A client
 * pinned to a key older than the oldest kept statement cannot follow the
 * history and fails closed — the safe direction.
 */
export const MAX_DOMAIN_KEY_ROTATIONS = 32;

/** Wire form. Keys are canonical base64 of exactly 32 bytes. */
export interface DomainKeyRotation {
  /** The canonical name the domain key is for. */
  name: string;
  /** The key being retired. It signs this statement. */
  previousKey: string;
  /** The key replacing it. */
  nextKey: string;
  /** Unix seconds, integer. Strictly increasing along a history. */
  issuedAt: number;
  /** Ed25519 signature by `previousKey` over the canonical bytes. */
  signature: string;
}

export type UnsignedDomainKeyRotation = Omit<DomainKeyRotation, 'signature'>;

const ROTATION_FIELDS: ReadonlySet<string> = new Set([
  'name',
  'previousKey',
  'nextKey',
  'issuedAt',
  'signature',
]);

interface ParsedRotation {
  name: string;
  previousKey: Uint8Array;
  nextKey: Uint8Array;
  issuedAt: number;
}

function parseRotation(value: unknown, allowSignature: boolean): ParsedRotation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new EncodingError('rotation must be an object');
  }
  for (const field of Object.keys(value)) {
    if (!ROTATION_FIELDS.has(field) || (field === 'signature' && !allowSignature)) {
      throw new EncodingError('rotation has an unexpected field');
    }
  }
  const r = value as Record<string, unknown>;
  if (!isValidScope(r.name)) throw new EncodingError('name is not a canonical name');
  if (typeof r.previousKey !== 'string' || typeof r.nextKey !== 'string') {
    throw new EncodingError('previousKey and nextKey must be base64 strings');
  }
  const previousKey = parsePublicKey(r.previousKey);
  const nextKey = parsePublicKey(r.nextKey);
  if (bytesEqual(previousKey, nextKey)) throw new EncodingError('rotation to the same key');
  assertUint(r.issuedAt, 'issuedAt');
  return { name: r.name, previousKey, nextKey, issuedAt: r.issuedAt };
}

function encodeRotation(r: ParsedRotation): Uint8Array {
  return new CanonicalWriter()
    .string(ROTATION_CONTEXT)
    .string(r.name)
    .fixed(r.previousKey, PUBLIC_KEY_LENGTH)
    .fixed(r.nextKey, PUBLIC_KEY_LENGTH)
    .uint(r.issuedAt, 'issuedAt')
    .finish();
}

/** Canonical signed bytes of a rotation statement. Throws on a non-canonical one. */
export function canonicalDomainKeyRotationBytes(rotation: UnsignedDomainKeyRotation): Uint8Array {
  return encodeRotation(parseRotation(rotation, false));
}

/** Sign with the RETIRING key's Ed25519 secret. Refuses a secret that is not `previousKey`'s. */
export function signDomainKeyRotation(
  rotation: UnsignedDomainKeyRotation,
  previousSecretKey: Uint8Array,
): DomainKeyRotation {
  const parsed = parseRotation(rotation, false);
  assertSecretMatches(previousSecretKey, parsed.previousKey);
  const signature = nacl.sign.detached(encodeRotation(parsed), previousSecretKey);
  return { ...rotation, signature: encodeBase64(signature) };
}

export type RotationVerifyResult =
  | { ok: true; previousKey: Uint8Array; nextKey: Uint8Array; issuedAt: number }
  | { ok: false; detail: string };

/**
 * Verify one statement for `name`. Remote input never throws: a bad statement
 * is `{ ok: false }`.
 */
export function verifyDomainKeyRotation(
  rotation: DomainKeyRotation,
  name: string,
): RotationVerifyResult {
  let parsed: ParsedRotation;
  let signature: Uint8Array;
  try {
    parsed = parseRotation(rotation, true);
    signature = decodeBase64Strict(rotation.signature, SIGNATURE_LENGTH);
  } catch (err) {
    return { ok: false, detail: `rotation: ${(err as Error).message}` };
  }
  if (parsed.name !== name) return { ok: false, detail: 'rotation is for another name' };
  if (!nacl.sign.detached.verify(encodeRotation(parsed), signature, parsed.previousKey)) {
    return { ok: false, detail: 'rotation signature does not verify' };
  }
  return {
    ok: true,
    previousKey: parsed.previousKey,
    nextKey: parsed.nextKey,
    issuedAt: parsed.issuedAt,
  };
}

export interface FollowRotationsOptions {
  name: string;
  /** The key the verifier already trusts for `name` (its pin). */
  pinned: string | Uint8Array;
  /** The key now being presented for `name`. */
  current: string | Uint8Array;
  /** The published history, oldest first. Untrusted. */
  rotations: readonly DomainKeyRotation[];
}

export type FollowRotationsResult = { ok: true; steps: number } | { ok: false; detail: string };

/**
 * Whether `current` is reachable from `pinned` through genuine rotation
 * statements for `name`, each signed by the key it retires, in strictly
 * increasing `issuedAt` order.
 *
 * Statements that do not verify, are for another name or do not continue the
 * walk are skipped rather than fatal: the registry may serve history the
 * verifier does not need. What can never happen is reaching `current` through
 * a statement the pinned key's line of succession did not sign. A registry
 * that omits a statement makes this fail closed.
 */
export function followDomainKeyRotations(options: FollowRotationsOptions): FollowRotationsResult {
  let cursor: Uint8Array;
  let target: Uint8Array;
  try {
    cursor = parsePublicKey(options.pinned);
    target = parsePublicKey(options.current);
  } catch (err) {
    return { ok: false, detail: `key: ${(err as Error).message}` };
  }
  if (bytesEqual(cursor, target)) return { ok: true, steps: 0 };
  if (!Array.isArray(options.rotations) || options.rotations.length > MAX_DOMAIN_KEY_ROTATIONS) {
    return { ok: false, detail: 'rotation history is malformed or too long' };
  }

  let steps = 0;
  let lastIssuedAt = -1;
  for (const rotation of options.rotations) {
    const verified = verifyDomainKeyRotation(rotation, options.name);
    if (!verified.ok) continue;
    if (!bytesEqual(verified.previousKey, cursor)) continue;
    if (verified.issuedAt <= lastIssuedAt) continue;
    cursor = verified.nextKey;
    lastIssuedAt = verified.issuedAt;
    steps++;
    if (bytesEqual(cursor, target)) return { ok: true, steps };
  }
  return {
    ok: false,
    detail: 'no chain of rotation statements signed by the pinned key leads to the presented key',
  };
}

/**
 * A domain key's fingerprint: lowercase hex SHA-256 of its 32 raw bytes. Used
 * to say WHICH key a name was reset away from without republishing it.
 */
export function domainKeyFingerprint(key: string | Uint8Array): string {
  return toHex(sha256(parsePublicKey(key)));
}

/** A fresh Ed25519 key pair (tweetnacl's 64-byte secret form) from the platform CSPRNG. */
export function generateSigningKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const kp = nacl.sign.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/** The Ed25519 key pair for a 64-byte tweetnacl secret key; checks the embedded public half. */
export function signingKeyPairFromSecret(secretKey: Uint8Array): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
} {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== nacl.sign.secretKeyLength) {
    throw new EncodingError('Ed25519 secret key must be 64 bytes');
  }
  // Derived from the seed half, so a file whose public half was edited is caught.
  const kp = nacl.sign.keyPair.fromSeed(secretKey.subarray(0, 32));
  if (!bytesEqual(kp.publicKey, secretKey.subarray(32))) {
    throw new EncodingError('Ed25519 secret key is inconsistent');
  }
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}
