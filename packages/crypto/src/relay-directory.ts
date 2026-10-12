/**
 * The signed relay directory, and the two statements a relay signs with its
 * relay key.
 *
 * Normative spec: docs/architecture/discovery.md §2, relays.md §2 and §8,
 * transport.md §6.2, security.md §5 ("Directory substitution").
 *
 * 1. **The directory** lists the relays a client may select. It is a signed
 *    document, not an API response trusted because it arrived over TLS: the
 *    client pins the directory signing key(s) and refuses an unsigned, badly
 *    signed, expired or rolled-back document rather than falling back to
 *    unverified data.
 *
 *      u32 len ‖ "tnp-relay-directory-v1"
 *      u64 v ‖ u64 serial ‖ u64 issuedAt ‖ u64 expiresAt ‖ u64 relay count
 *      per relay:
 *        u32 len ‖ endpoint
 *        relayKey (32 raw bytes)
 *        u32 len ‖ operator
 *        u64 capability count ‖ (u32 len ‖ capability)…
 *        u32 len ‖ region
 *
 *    signed (Ed25519) by the directory signing key.
 *
 * 2. **The relay identity proof** a relay gives a connecting client or service
 *    node: the peer sends a fresh 32-byte nonce, the relay signs
 *
 *      u32 len ‖ "tnp-relay-identity-v1"
 *      u32 len ‖ endpoint     the URL the PEER dialed, normalized
 *      nonce (32)             fresh per connection, chosen by the peer
 *      relayKey (32)
 *
 *    The nonce binds the proof to one connection (a recorded proof is
 *    useless), the endpoint to one relay (a relay cannot pass off another
 *    relay's proof, or its own proof for another URL), and the peer checks
 *    `relayKey` against the signed directory entry for that endpoint.
 *
 * 3. **The registry key proof** a community relay sends with its registration
 *    and every heartbeat, so the registry lists only relays whose operator
 *    holds the private half of the key it publishes:
 *
 *      u32 len ‖ "tnp-relay-registry-proof-v1"
 *      u32 len ‖ purpose      "register" | "heartbeat"
 *      u32 len ‖ endpoint
 *      relayKey (32)
 *      u64 issuedAt           Unix seconds; the registry accepts a small window
 *
 * Three distinct contexts, distinct from every other signed statement in TNP
 * (grants, certificates, rotations, service-node auth), so no signature made
 * for one verifies as another.
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
} from './encoding.js';
import { assertSecretMatches } from './grants.js';

const DIRECTORY_CONTEXT = 'tnp-relay-directory-v1';
const IDENTITY_CONTEXT = 'tnp-relay-identity-v1';
const REGISTRY_PROOF_CONTEXT = 'tnp-relay-registry-proof-v1';

/** The only directory format version. */
export const RELAY_DIRECTORY_VERSION = 1;
/** Most relays one directory may list. */
export const MAX_DIRECTORY_RELAYS = 256;
/** Largest canonical encoding (and, with headroom, JSON body) a verifier accepts. */
export const MAX_DIRECTORY_BYTES = 128 * 1024;
/** Longest validity window a directory may claim. Anything longer is refused, not clamped. */
export const MAX_DIRECTORY_LIFETIME_SECONDS = 7 * 86_400;
/**
 * How far in the future `issuedAt` may lie relative to the verifier's clock.
 * A document from much further ahead is refused: accepting it would raise the
 * client's rollback high-water mark to a serial nothing honest has reached.
 */
export const MAX_DIRECTORY_CLOCK_SKEW_SECONDS = 600;
/** Most capability tokens per relay. */
export const MAX_RELAY_CAPABILITIES = 8;
/** Longest endpoint string in any relay statement. */
export const MAX_RELAY_ENDPOINT_LENGTH = 512;
/** Longest region label. */
export const MAX_RELAY_REGION_LENGTH = 64;
/** Nonce a peer sends to make a relay prove its identity. */
export const RELAY_IDENTITY_NONCE_SIZE = 32;

const CAPABILITY = /^[a-z][a-z0-9-]{0,31}$/;
// Printable ASCII, no control characters: a label people read, never markup.
const REGION = /^[\x20-\x7e]*$/;

export type DirectoryRelayOperator = 'oxy' | 'community';
const OPERATORS: ReadonlySet<string> = new Set(['oxy', 'community']);

/** One relay in the signed directory. */
export interface DirectoryRelay {
  /** Canonical `wss://` URL the relay is dialed at. Unique within a directory. */
  endpoint: string;
  /** The relay's Ed25519 key, canonical base64 of 32 bytes. */
  relayKey: string;
  /** `oxy` only for relays the API's operator configuration names. */
  operator: DirectoryRelayOperator;
  /** What the relay serves (`tunnel`, `service`). Unknown tokens are ignored by clients. */
  capabilities: string[];
  /** Approximate region label, `""` when not stated. */
  region: string;
}

export interface UnsignedRelayDirectory {
  v: typeof RELAY_DIRECTORY_VERSION;
  /** Monotonic. A client refuses a serial lower than the highest it has seen. */
  serial: number;
  /** Unix seconds. */
  issuedAt: number;
  /** Unix seconds; after this the document is refused. */
  expiresAt: number;
  relays: DirectoryRelay[];
}

/** Wire form: the fields above plus the Ed25519 signature, canonical base64. */
export interface SignedRelayDirectory extends UnsignedRelayDirectory {
  signature: string;
}

const DIRECTORY_FIELDS: ReadonlySet<string> = new Set([
  'v',
  'serial',
  'issuedAt',
  'expiresAt',
  'relays',
  'signature',
]);
const RELAY_FIELDS: ReadonlySet<string> = new Set([
  'endpoint',
  'relayKey',
  'operator',
  'capabilities',
  'region',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ParsedRelay {
  endpoint: string;
  key: Uint8Array;
  operator: DirectoryRelayOperator;
  capabilities: string[];
  region: string;
}

interface ParsedDirectory {
  serial: number;
  issuedAt: number;
  expiresAt: number;
  relays: ParsedRelay[];
}

function parseEndpoint(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_RELAY_ENDPOINT_LENGTH ||
    !(value.startsWith('wss://') || value.startsWith('ws://'))
  ) {
    throw new EncodingError('relay endpoint must be a ws(s):// URL of at most 512 characters');
  }
  return value;
}

function parseRelay(value: unknown): ParsedRelay {
  if (!isObject(value)) throw new EncodingError('relay entry must be an object');
  for (const field of Object.keys(value)) {
    if (!RELAY_FIELDS.has(field)) throw new EncodingError('relay entry has an unexpected field');
  }
  const endpoint = parseEndpoint(value.endpoint);
  if (typeof value.relayKey !== 'string') throw new EncodingError('relayKey must be base64');
  const key = parsePublicKey(value.relayKey);
  if (typeof value.operator !== 'string' || !OPERATORS.has(value.operator)) {
    throw new EncodingError('operator must be oxy or community');
  }
  const caps = value.capabilities;
  if (!Array.isArray(caps) || caps.length > MAX_RELAY_CAPABILITIES) {
    throw new EncodingError(`capabilities must be an array of at most ${MAX_RELAY_CAPABILITIES}`);
  }
  const seen = new Set<string>();
  for (const cap of caps) {
    if (typeof cap !== 'string' || !CAPABILITY.test(cap) || seen.has(cap)) {
      throw new EncodingError('capabilities must be distinct lowercase tokens');
    }
    seen.add(cap);
  }
  const region = value.region;
  if (
    typeof region !== 'string' ||
    region.length > MAX_RELAY_REGION_LENGTH ||
    !REGION.test(region)
  ) {
    throw new EncodingError('region must be printable ASCII of at most 64 characters');
  }
  return {
    endpoint,
    key,
    operator: value.operator as DirectoryRelayOperator,
    capabilities: [...(caps as string[])],
    region,
  };
}

function parseDirectory(value: unknown, allowSignature: boolean): ParsedDirectory {
  if (!isObject(value)) throw new EncodingError('directory must be an object');
  for (const field of Object.keys(value)) {
    if (!DIRECTORY_FIELDS.has(field) || (field === 'signature' && !allowSignature)) {
      throw new EncodingError('directory has an unexpected field');
    }
  }
  if (value.v !== RELAY_DIRECTORY_VERSION) throw new EncodingError('unsupported directory version');
  assertUint(value.serial, 'serial');
  assertUint(value.issuedAt, 'issuedAt');
  assertUint(value.expiresAt, 'expiresAt');
  if (value.serial < 1) throw new EncodingError('serial must be at least 1');
  if (value.expiresAt <= value.issuedAt) throw new EncodingError('expiresAt must follow issuedAt');
  if (value.expiresAt - value.issuedAt > MAX_DIRECTORY_LIFETIME_SECONDS) {
    throw new EncodingError('directory validity window is too long');
  }
  if (!Array.isArray(value.relays) || value.relays.length > MAX_DIRECTORY_RELAYS) {
    throw new EncodingError(`relays must be an array of at most ${MAX_DIRECTORY_RELAYS}`);
  }
  const relays = value.relays.map(parseRelay);
  const endpoints = new Set<string>();
  for (const relay of relays) {
    if (endpoints.has(relay.endpoint)) throw new EncodingError('duplicate relay endpoint');
    endpoints.add(relay.endpoint);
  }
  return {
    serial: value.serial,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    relays,
  };
}

function encodeDirectory(d: ParsedDirectory): Uint8Array {
  const w = new CanonicalWriter()
    .string(DIRECTORY_CONTEXT)
    .uint(RELAY_DIRECTORY_VERSION, 'v')
    .uint(d.serial, 'serial')
    .uint(d.issuedAt, 'issuedAt')
    .uint(d.expiresAt, 'expiresAt')
    .uint(d.relays.length, 'relay count');
  for (const r of d.relays) {
    w.string(r.endpoint)
      .fixed(r.key, PUBLIC_KEY_LENGTH)
      .string(r.operator)
      .uint(r.capabilities.length, 'capability count');
    for (const cap of r.capabilities) w.string(cap);
    w.string(r.region);
  }
  const bytes = w.finish();
  if (bytes.length > MAX_DIRECTORY_BYTES) throw new EncodingError('directory is too large');
  return bytes;
}

function toWire(d: ParsedDirectory): UnsignedRelayDirectory {
  return {
    v: RELAY_DIRECTORY_VERSION,
    serial: d.serial,
    issuedAt: d.issuedAt,
    expiresAt: d.expiresAt,
    relays: d.relays.map((r) => ({
      endpoint: r.endpoint,
      relayKey: encodeBase64(r.key),
      operator: r.operator,
      capabilities: [...r.capabilities],
      region: r.region,
    })),
  };
}

/** The exact bytes a directory signature covers. Throws on a malformed directory. */
export function canonicalRelayDirectoryBytes(directory: UnsignedRelayDirectory): Uint8Array {
  return encodeDirectory(parseDirectory(directory, false));
}

/**
 * Sign a directory with the directory signing key's 64-byte Ed25519 secret.
 * The result is rebuilt from the parsed form, so what is returned is exactly
 * what was signed.
 */
export function signRelayDirectory(
  directory: UnsignedRelayDirectory,
  secretKey: Uint8Array,
): SignedRelayDirectory {
  const parsed = parseDirectory(directory, false);
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== nacl.sign.secretKeyLength) {
    throw new EncodingError('Ed25519 secret key must be 64 bytes');
  }
  const signature = nacl.sign.detached(encodeDirectory(parsed), secretKey);
  return { ...toWire(parsed), signature: encodeBase64(signature) };
}

/** A relay from a verified directory, with its key already decoded. */
export interface VerifiedDirectoryRelay extends DirectoryRelay {
  key: Uint8Array;
}

export interface VerifiedRelayDirectory {
  serial: number;
  issuedAt: number;
  expiresAt: number;
  relays: VerifiedDirectoryRelay[];
  /** The pinned key that verified it. */
  signedBy: Uint8Array;
  /** The verified document, as it can be cached and re-verified later. */
  document: SignedRelayDirectory;
}

export type DirectoryRejection =
  | 'malformed'
  | 'oversized'
  | 'bad-signature'
  | 'not-yet-valid'
  | 'expired'
  | 'rolled-back';

export type VerifyDirectoryResult =
  | { ok: true; directory: VerifiedRelayDirectory }
  | { ok: false; reason: DirectoryRejection };

export interface VerifyDirectoryOptions {
  /** Pinned directory signing keys (current, and the next one during a rotation). */
  trustedKeys: readonly Uint8Array[];
  /** Unix seconds. */
  now: number;
  /** Highest serial this verifier has accepted before; a lower one is `rolled-back`. */
  minSerial?: number;
}

/**
 * Verify a directory: shape and bounds, signature by a pinned key, validity
 * window, serial. Never throws on remote input. The checks run in that order
 * so nothing about an unsigned document is acted on.
 */
export function verifyRelayDirectory(
  value: unknown,
  options: VerifyDirectoryOptions,
): VerifyDirectoryResult {
  let parsed: ParsedDirectory;
  let bytes: Uint8Array;
  let signature: Uint8Array;
  try {
    parsed = parseDirectory(value, true);
    signature = decodeBase64Strict(
      (value as Record<string, unknown>).signature as string,
      SIGNATURE_LENGTH,
    );
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  try {
    bytes = encodeDirectory(parsed);
  } catch {
    return { ok: false, reason: 'oversized' };
  }
  const signedBy = options.trustedKeys.find(
    (key) =>
      key instanceof Uint8Array &&
      key.length === PUBLIC_KEY_LENGTH &&
      nacl.sign.detached.verify(bytes, signature, key),
  );
  if (!signedBy) return { ok: false, reason: 'bad-signature' };
  if (parsed.issuedAt > options.now + MAX_DIRECTORY_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'not-yet-valid' };
  }
  if (options.now >= parsed.expiresAt) return { ok: false, reason: 'expired' };
  if (options.minSerial !== undefined && parsed.serial < options.minSerial) {
    return { ok: false, reason: 'rolled-back' };
  }
  const wire = toWire(parsed);
  return {
    ok: true,
    directory: {
      serial: parsed.serial,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
      relays: wire.relays.map((relay, i) => ({ ...relay, key: parsed.relays[i].key.slice() })),
      signedBy: signedBy.slice(),
      document: { ...wire, signature: encodeBase64(signature) },
    },
  };
}

// ---------------------------------------------------------------------------
// Relay identity proof (relay → client / service node)
// ---------------------------------------------------------------------------

export interface RelayIdentityStatement {
  /** The normalized endpoint the peer dialed. */
  endpoint: string;
  /** The peer's fresh nonce for this connection. */
  nonce: Uint8Array;
  /** The relay key, base64 or 32 raw bytes. */
  relayKey: string | Uint8Array;
}

function encodeIdentity(statement: RelayIdentityStatement): Uint8Array {
  parseEndpoint(statement.endpoint);
  if (
    !(statement.nonce instanceof Uint8Array) ||
    statement.nonce.length !== RELAY_IDENTITY_NONCE_SIZE
  ) {
    throw new EncodingError(`nonce must be ${RELAY_IDENTITY_NONCE_SIZE} bytes`);
  }
  return new CanonicalWriter()
    .string(IDENTITY_CONTEXT)
    .string(statement.endpoint)
    .fixed(statement.nonce, RELAY_IDENTITY_NONCE_SIZE)
    .fixed(parsePublicKey(statement.relayKey), PUBLIC_KEY_LENGTH)
    .finish();
}

/** Sign the identity statement with the relay key's 64-byte secret. Returns 64 raw bytes. */
export function signRelayIdentity(
  statement: RelayIdentityStatement,
  relaySecretKey: Uint8Array,
): Uint8Array {
  const bytes = encodeIdentity(statement);
  assertSecretMatches(relaySecretKey, parsePublicKey(statement.relayKey));
  return nacl.sign.detached(bytes, relaySecretKey);
}

/** Verify a relay identity proof. Never throws on remote input. */
export function verifyRelayIdentity(
  statement: RelayIdentityStatement,
  signature: Uint8Array,
): boolean {
  try {
    if (!(signature instanceof Uint8Array) || signature.length !== SIGNATURE_LENGTH) return false;
    return nacl.sign.detached.verify(
      encodeIdentity(statement),
      signature,
      parsePublicKey(statement.relayKey),
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Registry key proof (community relay → registry)
// ---------------------------------------------------------------------------

export type RelayRegistryProofPurpose = 'register' | 'heartbeat';

export interface RelayRegistryProofStatement {
  purpose: RelayRegistryProofPurpose;
  endpoint: string;
  /** The relay key, base64 or 32 raw bytes. */
  relayKey: string | Uint8Array;
  /** Unix seconds. */
  issuedAt: number;
}

function encodeRegistryProof(statement: RelayRegistryProofStatement): Uint8Array {
  if (statement.purpose !== 'register' && statement.purpose !== 'heartbeat') {
    throw new EncodingError('purpose must be register or heartbeat');
  }
  parseEndpoint(statement.endpoint);
  return new CanonicalWriter()
    .string(REGISTRY_PROOF_CONTEXT)
    .string(statement.purpose)
    .string(statement.endpoint)
    .fixed(parsePublicKey(statement.relayKey), PUBLIC_KEY_LENGTH)
    .uint(statement.issuedAt, 'issuedAt')
    .finish();
}

/** Sign a registry proof with the relay key's 64-byte secret. Returns base64. */
export function signRelayRegistryProof(
  statement: RelayRegistryProofStatement,
  relaySecretKey: Uint8Array,
): string {
  const bytes = encodeRegistryProof(statement);
  assertSecretMatches(relaySecretKey, parsePublicKey(statement.relayKey));
  return encodeBase64(nacl.sign.detached(bytes, relaySecretKey));
}

/** Verify a registry proof's signature (freshness is the caller's policy). Never throws. */
export function verifyRelayRegistryProof(
  statement: RelayRegistryProofStatement,
  signature: string,
): boolean {
  try {
    const sig = decodeBase64Strict(signature, SIGNATURE_LENGTH);
    return nacl.sign.detached.verify(
      encodeRegistryProof(statement),
      sig,
      parsePublicKey(statement.relayKey),
    );
  } catch {
    return false;
  }
}

/** True when two keys (base64 or bytes) are the same 32 bytes; false for anything malformed. */
export function sameRelayKey(a: string | Uint8Array, b: string | Uint8Array): boolean {
  try {
    return bytesEqual(parsePublicKey(a), parsePublicKey(b));
  } catch {
    return false;
  }
}
