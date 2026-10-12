/**
 * Key-agreement certificates: binding an X25519 key to an authorized Ed25519
 * node key.
 *
 * Normative spec: docs/architecture/security.md §1 ("Key-agreement
 * certificates").
 *
 * Grants authorize Ed25519 keys, but the transport's handshake is X25519
 * (transport.md §9). Without an explicit binding, "the service node's key is
 * chained to the owner" says nothing about the key a client actually does
 * Diffie-Hellman with — which is S3 again, one layer down.
 *
 * The binding is a separate signed statement rather than a birational map of
 * the Ed25519 key onto Curve25519: a separate key can be rotated on a short
 * schedule by the node itself (it holds the node key) without touching the
 * grant chain, so a stolen key-agreement secret is useful for days, not for the
 * life of the node key. It also keeps the signing key off the wire entirely.
 *
 *   node key (Ed25519, grant chain leaf with service-node or relay purpose)
 *        │ signs, under context `tnp-key-agreement-v1`
 *        ▼
 *   key-agreement key (X25519)  { role, scope, notBefore, notAfter, serial }
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
import {
  assertSecretMatches,
  type Grant,
  GrantPurpose,
  type VerifiedChain,
  type VerifyFailure,
  type VerifyOptionsBase,
  verifyChainCore,
} from './grants.js';
import { assertValidX25519PublicKey } from './primitives.js';
import { isValidScope, scopeCovers } from './scope.js';

/** What a key-agreement key is used for. Each maps to the grant purpose its signer must hold. */
export const KeyAgreementRole = {
  /** Terminates end-to-end sessions for a domain. Signer holds `service-node`. */
  SERVICE_NODE: 'service-node',
  /** Terminates one hop of a circuit at a relay (Phase 6). Signer holds `relay`. */
  RELAY: 'relay',
} as const;

export type KeyAgreementRoleValue = (typeof KeyAgreementRole)[keyof typeof KeyAgreementRole];

const ROLE_PURPOSE = {
  [KeyAgreementRole.SERVICE_NODE]: GrantPurpose.SERVICE_NODE,
  [KeyAgreementRole.RELAY]: GrantPurpose.RELAY,
} as const;

/**
 * Longest validity a key-agreement certificate may have: 7 days.
 *
 * Short on purpose. The node re-certifies a fresh X25519 key itself, so a
 * short lifetime costs nothing operationally, and it bounds how long a stolen
 * key-agreement secret can be used to impersonate the node.
 */
export const MAX_KEY_AGREEMENT_LIFETIME = 7 * 24 * 60 * 60;

/** Domain-separation tag. Distinct from the grant tag, so neither signature can stand in for the other. */
const KEY_AGREEMENT_CONTEXT = 'tnp-key-agreement-v1';

/** Wire form. Keys are canonical base64 of exactly 32 bytes. */
export interface KeyAgreementCertificate {
  /** Ed25519 node key that signed this; must be the subject of the chain's leaf grant. */
  signer: string;
  /** The certified X25519 public key. Canonical encoding, large order. */
  key: string;
  role: KeyAgreementRoleValue;
  /** Canonical name the key terminates sessions for. Within the signer's grant scope. */
  scope: string;
  /** Unix seconds, integer. */
  notBefore: number;
  /** Unix seconds, integer; at most MAX_KEY_AGREEMENT_LIFETIME after notBefore. */
  notAfter: number;
  /** Monotonic per signer+key, for rollback defence. */
  serial: number;
  /** Ed25519 signature by `signer` over `canonicalKeyAgreementBytes`. */
  signature: string;
}

export type UnsignedKeyAgreementCertificate = Omit<KeyAgreementCertificate, 'signature'>;

const CERT_FIELDS: ReadonlySet<string> = new Set([
  'signer',
  'key',
  'role',
  'scope',
  'notBefore',
  'notAfter',
  'serial',
  'signature',
]);

interface ParsedCertificate {
  signer: Uint8Array;
  key: Uint8Array;
  role: KeyAgreementRoleValue;
  scope: string;
  notBefore: number;
  notAfter: number;
  serial: number;
}

function parseUnsigned(cert: unknown, allowSignature: boolean): ParsedCertificate {
  if (typeof cert !== 'object' || cert === null || Array.isArray(cert)) {
    throw new EncodingError('certificate must be an object');
  }
  for (const field of Object.keys(cert)) {
    if (!CERT_FIELDS.has(field) || (field === 'signature' && !allowSignature)) {
      throw new EncodingError('certificate has an unexpected field');
    }
  }
  const c = cert as Record<string, unknown>;
  if (typeof c.signer !== 'string' || typeof c.key !== 'string') {
    throw new EncodingError('signer and key must be base64 strings');
  }
  const signer = parsePublicKey(c.signer);
  const key = parsePublicKey(c.key);
  try {
    assertValidX25519PublicKey(key);
  } catch {
    throw new EncodingError('key is not a valid X25519 public key');
  }
  if (c.role !== KeyAgreementRole.SERVICE_NODE && c.role !== KeyAgreementRole.RELAY) {
    throw new EncodingError('unknown role');
  }
  if (!isValidScope(c.scope)) throw new EncodingError('scope is not a canonical name');
  assertUint(c.notBefore, 'notBefore');
  assertUint(c.notAfter, 'notAfter');
  assertUint(c.serial, 'serial');
  if (c.notAfter <= c.notBefore) throw new EncodingError('validity window is empty or inverted');
  if (c.notAfter - c.notBefore > MAX_KEY_AGREEMENT_LIFETIME) {
    throw new EncodingError('validity exceeds MAX_KEY_AGREEMENT_LIFETIME');
  }
  return {
    signer,
    key,
    role: c.role,
    scope: c.scope,
    notBefore: c.notBefore,
    notAfter: c.notAfter,
    serial: c.serial,
  };
}

function encodeParsed(cert: ParsedCertificate): Uint8Array {
  return new CanonicalWriter()
    .string(KEY_AGREEMENT_CONTEXT)
    .fixed(cert.signer, PUBLIC_KEY_LENGTH)
    .fixed(cert.key, PUBLIC_KEY_LENGTH)
    .string(cert.role)
    .string(cert.scope)
    .uint(cert.notBefore, 'notBefore')
    .uint(cert.notAfter, 'notAfter')
    .uint(cert.serial, 'serial')
    .finish();
}

/**
 * Canonical signed bytes: u32-length-prefixed context `tnp-key-agreement-v1`,
 * signer (32 raw bytes), key (32 raw bytes), length-prefixed role and scope,
 * then notBefore/notAfter/serial as u64 big-endian. Throws on a
 * non-canonical certificate.
 */
export function canonicalKeyAgreementBytes(cert: UnsignedKeyAgreementCertificate): Uint8Array {
  return encodeParsed(parseUnsigned(cert, false));
}

/** Sign with the node key's Ed25519 secret key. Refuses a key that is not `cert.signer`'s. */
export function signKeyAgreementCertificate(
  cert: UnsignedKeyAgreementCertificate,
  signerSecretKey: Uint8Array,
): KeyAgreementCertificate {
  const parsed = parseUnsigned(cert, false);
  assertSecretMatches(signerSecretKey, parsed.signer);
  const signature = nacl.sign.detached(encodeParsed(parsed), signerSecretKey);
  return { ...cert, signature: encodeBase64(signature) };
}

const verifiedKeys = new WeakSet<object>();

/**
 * An X25519 key that has passed `verifyKeyAgreementCertificate`.
 *
 * There is no public way to construct one: the handshake in
 * `@tnp/protocol/v1` accepts only this type, and checks at run time that the
 * object really came from the verifier (`isVerifiedKeyAgreementKey`) — so an
 * unchained key is not merely discouraged, it is unusable (security.md §5,
 * "Key substitution").
 */
export interface VerifiedKeyAgreementKey {
  /** A fresh copy of the 32-byte X25519 public key on every read. */
  readonly publicKey: Uint8Array;
  readonly role: KeyAgreementRoleValue;
  /** The exact name the key was certified for. */
  readonly scope: string;
  /** Unix seconds after which the certificate, and so this key, is no longer valid. */
  readonly notAfter: number;
}

function makeVerifiedKey(cert: ParsedCertificate): VerifiedKeyAgreementKey {
  const key = cert.key.slice();
  const verified: VerifiedKeyAgreementKey = Object.freeze({
    get publicKey() {
      return key.slice();
    },
    role: cert.role,
    scope: cert.scope,
    notAfter: cert.notAfter,
  });
  verifiedKeys.add(verified);
  return verified;
}

/** True only for objects returned by `verifyKeyAgreementCertificate` in this process. */
export function isVerifiedKeyAgreementKey(value: unknown): value is VerifiedKeyAgreementKey {
  return typeof value === 'object' && value !== null && verifiedKeys.has(value);
}

export interface KeyAgreementVerifyOptions extends VerifyOptionsBase {
  /** The role the caller is about to use the key for. */
  role: KeyAgreementRoleValue;
  /** The exact name being connected to: a domain, or a relay hostname. Mandatory. */
  name: string;
}

export type KeyAgreementVerifyResult =
  | {
      ok: true;
      key: VerifiedKeyAgreementKey;
      chain: VerifiedChain;
      serialKey: string;
      serial: number;
    }
  | { ok: false; reason: VerifyFailure; detail: string };

/**
 * Verify a key-agreement certificate and the grant chain behind its signer.
 *
 * Accepts only when ALL of these hold:
 *  - the certificate parses strictly (canonical keys, large-order X25519 key,
 *    integer times, lifetime ≤ MAX_KEY_AGREEMENT_LIFETIME);
 *  - `chain` verifies to a trusted root, and its leaf authorizes `cert.signer`
 *    for the purpose matching `cert.role`;
 *  - `cert.scope` equals `options.name` exactly, and lies within the leaf
 *    grant's scope;
 *  - `cert.role` equals `options.role`;
 *  - the certificate's window lies inside the leaf grant's, and contains `now`;
 *  - neither the signer nor the X25519 key is revoked, and the serial is not
 *    below the caller's high-water mark for this signer+key;
 *  - the signature verifies under the `tnp-key-agreement-v1` context.
 */
export function verifyKeyAgreementCertificate(
  cert: KeyAgreementCertificate,
  chain: readonly Grant[],
  options: KeyAgreementVerifyOptions,
): KeyAgreementVerifyResult {
  if (!isValidScope(options.name)) {
    return { ok: false, reason: 'scope-required', detail: 'name must be a canonical name' };
  }
  const purpose = ROLE_PURPOSE[options.role];
  if (!purpose) return { ok: false, reason: 'malformed', detail: 'unknown role requested' };

  let parsed: ParsedCertificate;
  let signature: Uint8Array;
  try {
    parsed = parseUnsigned(cert, true);
    signature = decodeBase64Strict(cert.signature, SIGNATURE_LENGTH);
  } catch (err) {
    return { ok: false, reason: 'malformed', detail: `certificate: ${(err as Error).message}` };
  }

  const chainResult = verifyChainCore(chain, { ...options, requirePurpose: purpose });
  if (!chainResult.ok) return chainResult;

  if (!bytesEqual(chainResult.subject, parsed.signer)) {
    return {
      ok: false,
      reason: 'chain-broken',
      detail: 'certificate signer is not the chain leaf',
    };
  }
  if (parsed.role !== options.role) {
    return { ok: false, reason: 'purpose-not-granted', detail: 'certificate is for another role' };
  }
  if (parsed.scope !== options.name) {
    return { ok: false, reason: 'scope-mismatch', detail: 'certificate is for another name' };
  }
  if (chainResult.scope === undefined || !scopeCovers(chainResult.scope, parsed.scope)) {
    return {
      ok: false,
      reason: 'scope-mismatch',
      detail: "certificate is outside its signer's scope",
    };
  }
  if (parsed.notBefore < chainResult.notBefore || parsed.notAfter > chainResult.notAfter) {
    return {
      ok: false,
      reason: 'window-not-nested',
      detail: "certificate outlives its signer's grant",
    };
  }
  if (options.now < parsed.notBefore) {
    return { ok: false, reason: 'not-yet-valid', detail: 'certificate is not valid yet' };
  }
  if (options.now >= parsed.notAfter) {
    return { ok: false, reason: 'expired', detail: 'certificate expired' };
  }
  for (const k of options.revoked ?? []) {
    if (bytesEqual(parsePublicKey(k), parsed.key)) {
      return { ok: false, reason: 'revoked', detail: 'key-agreement key is revoked' };
    }
  }
  const certSerialKey = `${toHex(parsed.signer)}|${toHex(parsed.key)}`;
  const seen = options.knownSerials?.get(certSerialKey);
  if (seen !== undefined && parsed.serial < seen) {
    return {
      ok: false,
      reason: 'rolled-back',
      detail: 'certificate serial is below the highest seen',
    };
  }
  if (!nacl.sign.detached.verify(encodeParsed(parsed), signature, parsed.signer)) {
    return { ok: false, reason: 'bad-signature', detail: 'certificate signature does not verify' };
  }

  return {
    ok: true,
    key: makeVerifiedKey(parsed),
    chain: chainResult,
    serialKey: certSerialKey,
    serial: parsed.serial,
  };
}
