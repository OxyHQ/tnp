/**
 * The key hierarchy, and the grant chains that make it verifiable.
 *
 * Normative spec: docs/architecture/security.md §1.
 *
 * Audit finding S3, which is what this exists to end: a service node generated
 * a fresh X25519 keypair at every start, POSTed the public half to the API, and
 * the API handed it to whoever asked. Nothing signed it, nothing bound it to
 * the domain or its owner, and the client verified nothing. So the API was an
 * unaudited man-in-the-middle for every tunnel TNP called "end-to-end
 * encrypted" — substituting one field in one JSON response transparently
 * decrypts and re-encrypts all traffic for a name, with no client-visible
 * signal.
 *
 *   Oxy identity key          authorizes, never used on the wire
 *         │
 *   Device identity key       per-device, generated on-device, never leaves
 *         │
 *   Node / domain key         rotatable without touching the device
 *         │
 *   Key-agreement key         X25519, certified by the node key (key-agreement.ts)
 *         │
 *   Session keys              per circuit, ephemeral, never persisted
 *
 * A verifier walks the chain to a trusted root, checking every signature, every
 * validity window, every purpose, every scope and every revocation — and that
 * each link is NO BROADER than the one above it. A chain with one unverifiable
 * link is REJECTED — never partially trusted.
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
import { isValidScope, scopeCovers } from './scope.js';

/** What a child key is allowed to be used for. */
export const GrantPurpose = {
  /** Authorize further keys. Only a device identity should hold this. */
  DELEGATE: 'delegate',
  /**
   * Terminate a circuit's end-to-end encryption for a domain. A key holding it
   * may certify X25519 key-agreement keys for that domain (key-agreement.ts).
   */
  SERVICE_NODE: 'service-node',
  /** Sign a domain's record set. */
  DOMAIN_RECORDS: 'domain-records',
  /**
   * Authenticate as a relay in the directory. A key holding it may certify
   * X25519 key-agreement keys for that relay's hostname.
   */
  RELAY: 'relay',
  /** Open circuits as a client. */
  CLIENT: 'client',
} as const;

export type GrantPurposeValue = (typeof GrantPurpose)[keyof typeof GrantPurpose];

/** Purposes that speak for a specific name and therefore MUST carry a scope. */
export type ScopedPurpose =
  | typeof GrantPurpose.SERVICE_NODE
  | typeof GrantPurpose.DOMAIN_RECORDS
  | typeof GrantPurpose.RELAY;

/** Purposes that need no scope (a scope may still narrow them). */
export type UnscopedPurpose = typeof GrantPurpose.DELEGATE | typeof GrantPurpose.CLIENT;

export const SCOPED_PURPOSES: ReadonlySet<GrantPurposeValue> = new Set<GrantPurposeValue>([
  GrantPurpose.SERVICE_NODE,
  GrantPurpose.DOMAIN_RECORDS,
  GrantPurpose.RELAY,
]);

const PURPOSES: ReadonlySet<string> = new Set(Object.values(GrantPurpose));

/**
 * A signed statement: this key authorizes that key, for these purposes, until
 * this time. This is the WIRE form — JSON-friendly strings. It is parsed into
 * bytes before anything is compared.
 *
 * `serial` is monotonic per issuer+subject so a verifier can refuse a rollback
 * to a superseded grant — replaying an old, still-unexpired grant after a
 * rotation would otherwise re-enable a key its owner has already retired.
 */
export interface Grant {
  /** Ed25519 public key of the issuer: canonical base64 of exactly 32 bytes. */
  issuer: string;
  /** Ed25519 public key being authorized: canonical base64 of exactly 32 bytes. */
  subject: string;
  /** Non-empty, no duplicates. Order is not significant. */
  purposes: GrantPurposeValue[];
  /** Unix seconds, non-negative safe integer. */
  notBefore: number;
  /** Unix seconds, non-negative safe integer, strictly after `notBefore`. */
  notAfter: number;
  /** Non-negative safe integer. */
  serial: number;
  /**
   * What the subject key speaks for — a canonical name (scope.ts).
   *
   * REQUIRED on a non-delegating grant that carries a scoped purpose
   * (service-node, domain-records, relay): that is a key that will be USED for
   * a name. Optional on a delegating grant, where it narrows everything the
   * key may authorize; an absent scope there is unrestricted (bounded only by
   * what the issuer above holds), and so is only valid where every grant above
   * it is unrestricted too. Optional on a client grant.
   *
   * This is the field whose absence made S3 possible: without it a key is
   * authorized in the abstract, and "this key is valid" says nothing about
   * "valid FOR example.ox".
   */
  scope?: string;
  /** Ed25519 signature over `canonicalGrantBytes`: canonical base64 of 64 bytes. */
  signature: string;
}

/** A grant with everything but the signature — what gets signed. */
export type UnsignedGrant = Omit<Grant, 'signature'>;

export type VerifyFailure =
  | 'bad-signature'
  | 'not-yet-valid'
  | 'expired'
  | 'revoked'
  | 'purpose-not-granted'
  | 'scope-mismatch'
  | 'scope-required'
  | 'window-not-nested'
  | 'chain-broken'
  | 'chain-too-long'
  | 'untrusted-root'
  | 'rolled-back'
  | 'malformed';

/** What a verified chain establishes about its leaf. */
export interface VerifiedChain {
  ok: true;
  /** The leaf's purposes. */
  purposes: GrantPurposeValue[];
  /** The authorized key, 32 raw bytes. */
  subject: Uint8Array;
  /** The leaf's scope, if it has one. */
  scope: string | undefined;
  /** The leaf's window; every link above it is at least as wide. */
  notBefore: number;
  notAfter: number;
  /**
   * `serialKey → serial` for every link, so the caller can raise its
   * high-water marks for rollback defence after a successful verification.
   */
  serials: ReadonlyArray<{ key: string; serial: number }>;
}

export type VerifyResult = VerifiedChain | { ok: false; reason: VerifyFailure; detail: string };

/**
 * Longest chain a verifier will walk.
 *
 * The hierarchy is three links (identity → device → node), so four is slack.
 * A bound is required regardless: without one, a cyclic or absurdly long chain
 * is an unbounded loop driven by remote input.
 */
export const MAX_CHAIN_DEPTH = 4;

/** Domain-separation tag for grant signatures. `tnp-grant-v1` (string keys) never shipped. */
const GRANT_CONTEXT = 'tnp-grant-v2';

const GRANT_FIELDS: ReadonlySet<string> = new Set([
  'issuer',
  'subject',
  'purposes',
  'notBefore',
  'notAfter',
  'serial',
  'scope',
  'signature',
]);

/** A grant after strict parsing: keys as bytes, every field checked. */
interface ParsedGrant {
  issuer: Uint8Array;
  subject: Uint8Array;
  issuerHex: string;
  subjectHex: string;
  purposes: GrantPurposeValue[];
  notBefore: number;
  notAfter: number;
  serial: number;
  scope: string | undefined;
}

/**
 * Parse and check everything but the signature. Throws `EncodingError` with a
 * description that never echoes attacker-supplied values.
 */
function parseUnsigned(grant: unknown, allowSignature: boolean): ParsedGrant {
  if (typeof grant !== 'object' || grant === null || Array.isArray(grant)) {
    throw new EncodingError('grant must be an object');
  }
  for (const key of Object.keys(grant)) {
    // Unknown fields are not covered by the signature. Refusing them stops a
    // caller from ever reading an attacker-added field off a "verified" grant.
    if (!GRANT_FIELDS.has(key) || (key === 'signature' && !allowSignature)) {
      throw new EncodingError('grant has an unexpected field');
    }
  }
  const g = grant as Record<string, unknown>;

  if (typeof g.issuer !== 'string' || typeof g.subject !== 'string') {
    throw new EncodingError('issuer and subject must be base64 strings');
  }
  const issuer = parsePublicKey(g.issuer);
  const subject = parsePublicKey(g.subject);
  if (bytesEqual(issuer, subject)) {
    // A key authorizing itself proves nothing and would let any key present
    // itself as its own root.
    throw new EncodingError('grant is self-issued');
  }

  if (!Array.isArray(g.purposes) || g.purposes.length === 0) {
    throw new EncodingError('grant has no purposes');
  }
  const purposes: GrantPurposeValue[] = [];
  for (const purpose of g.purposes) {
    if (typeof purpose !== 'string' || !PURPOSES.has(purpose)) {
      throw new EncodingError('grant has an unknown purpose');
    }
    if (purposes.includes(purpose as GrantPurposeValue)) {
      throw new EncodingError('grant lists a purpose twice');
    }
    purposes.push(purpose as GrantPurposeValue);
  }

  assertUint(g.notBefore, 'notBefore');
  assertUint(g.notAfter, 'notAfter');
  assertUint(g.serial, 'serial');
  const notBefore = g.notBefore;
  const notAfter = g.notAfter;
  if (notAfter <= notBefore) throw new EncodingError('validity window is empty or inverted');

  let scope: string | undefined;
  if (g.scope !== undefined) {
    if (!isValidScope(g.scope)) throw new EncodingError('scope is not a canonical name');
    scope = g.scope;
  } else if (
    !purposes.includes(GrantPurpose.DELEGATE) &&
    purposes.some((p) => SCOPED_PURPOSES.has(p))
  ) {
    // A delegating grant may carry a scoped purpose unscoped: it only hands
    // the purpose on, and every key that finally USES it is scoped. A key that
    // cannot delegate is such a final key, so it must name what it speaks for.
    throw new EncodingError('a non-delegating grant with a scoped purpose requires a scope');
  }

  return {
    issuer,
    subject,
    issuerHex: toHex(issuer),
    subjectHex: toHex(subject),
    purposes,
    notBefore,
    notAfter,
    serial: g.serial,
    scope,
  };
}

function encodeParsed(grant: ParsedGrant): Uint8Array {
  return (
    new CanonicalWriter()
      .string(GRANT_CONTEXT)
      .fixed(grant.issuer, PUBLIC_KEY_LENGTH)
      .fixed(grant.subject, PUBLIC_KEY_LENGTH)
      // Sorted, so the order a caller happened to list purposes in cannot
      // change the bytes and invalidate an otherwise-good signature.
      .string([...grant.purposes].sort().join(','))
      .uint(grant.notBefore, 'notBefore')
      .uint(grant.notAfter, 'notAfter')
      .uint(grant.serial, 'serial')
      // '' is never a valid scope, so it unambiguously means "absent".
      .string(grant.scope ?? '')
      .finish()
  );
}

/**
 * Canonical bytes of a grant, for signing and verifying.
 *
 * Layout (security.md §1): u32-length-prefixed context `tnp-grant-v2`, issuer
 * (32 raw bytes), subject (32 raw bytes), u32-length-prefixed sorted
 * comma-joined purposes, notBefore/notAfter/serial as u64 big-endian, and the
 * u32-length-prefixed scope ('' when absent).
 *
 * Keys are encoded as raw bytes, never as their base64 spelling, so one key has
 * one encoding. Throws `EncodingError` on any grant that is not canonical —
 * including a non-integer time, which the old encoder silently truncated.
 */
export function canonicalGrantBytes(grant: UnsignedGrant): Uint8Array {
  return encodeParsed(parseUnsigned(grant, false));
}

/**
 * Sign a grant with the issuer's Ed25519 secret key (tweetnacl's 64-byte form).
 *
 * Refuses to sign when the secret key does not belong to `grant.issuer`: a
 * grant that names one issuer and is signed by another can never verify, and
 * producing one silently is a bug that only shows up at a remote verifier.
 */
export function signGrant(grant: UnsignedGrant, issuerSecretKey: Uint8Array): Grant {
  const parsed = parseUnsigned(grant, false);
  assertSecretMatches(issuerSecretKey, parsed.issuer);
  const signature = nacl.sign.detached(encodeParsed(parsed), issuerSecretKey);
  return { ...grant, signature: encodeBase64(signature) };
}

/** @internal Shared with key-agreement.ts. */
export function assertSecretMatches(secretKey: Uint8Array, publicKey: Uint8Array): void {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== nacl.sign.secretKeyLength) {
    throw new EncodingError('Ed25519 secret key must be 64 bytes');
  }
  if (!bytesEqual(secretKey.subarray(32), publicKey)) {
    throw new EncodingError('secret key does not belong to the named public key');
  }
}

/**
 * The key for `VerifyOptions.knownSerials`: one string per issuer+subject pair,
 * derived from the key BYTES so that two spellings of a key cannot hold two
 * separate high-water marks.
 */
export function serialKey(issuer: string | Uint8Array, subject: string | Uint8Array): string {
  return `${toHex(parsePublicKey(issuer))}|${toHex(parsePublicKey(subject))}`;
}

export interface VerifyOptionsBase {
  /** Public keys a chain may terminate at (base64 or 32 raw bytes). Usually one Oxy identity. */
  trustedRoots: readonly (string | Uint8Array)[];
  /** Unix seconds, integer. Injected so validity windows are testable without waiting. */
  now: number;
  /** Revoked public keys (base64 or 32 raw bytes). A malformed entry THROWS — it is never skipped. */
  revoked?: readonly (string | Uint8Array)[] | ReadonlySet<string | Uint8Array>;
  /**
   * Highest serial already seen, keyed by `serialKey(issuer, subject)`. A grant
   * whose serial is below the recorded one is refused.
   */
  knownSerials?: ReadonlyMap<string, number>;
}

/**
 * Verification options. `requireScope` is MANDATORY — in the type and at run
 * time — for every scoped purpose: a domain-bound key verified without naming
 * the domain is S3 wearing a signature.
 */
export type VerifyOptions = VerifyOptionsBase &
  (
    | { requirePurpose: ScopedPurpose; requireScope: string }
    | { requirePurpose: UnscopedPurpose; requireScope?: string }
  );

type Failure = { ok: false; reason: VerifyFailure; detail: string };
const fail = (reason: VerifyFailure, detail: string): Failure => ({ ok: false, reason, detail });

/** Chain checks shared by `verifyChain` and key-agreement verification; no leaf scope check. */
export function verifyChainCore(
  chain: readonly Grant[],
  options: VerifyOptionsBase & { requirePurpose: GrantPurposeValue },
): VerifyResult {
  if (!Number.isSafeInteger(options.now) || options.now < 0) {
    throw new EncodingError('now must be a non-negative integer number of seconds');
  }
  // Normalised up front so a non-canonical spelling in the caller's own lists
  // throws rather than silently failing to match.
  const roots = new Set(options.trustedRoots.map((k) => toHex(parsePublicKey(k))));
  const revoked = new Set<string>();
  for (const k of options.revoked ?? []) revoked.add(toHex(parsePublicKey(k)));

  if (!Array.isArray(chain) || chain.length === 0) return fail('malformed', 'empty chain');
  if (chain.length > MAX_CHAIN_DEPTH) {
    return fail(
      'chain-too-long',
      `chain of ${chain.length} exceeds MAX_CHAIN_DEPTH (${MAX_CHAIN_DEPTH})`,
    );
  }

  const parsed: ParsedGrant[] = [];
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < chain.length; i++) {
    try {
      parsed.push(parseUnsigned(chain[i], true));
      signatures.push(decodeBase64Strict(chain[i].signature, SIGNATURE_LENGTH));
    } catch (err) {
      return fail('malformed', `grant ${i}: ${(err as Error).message}`);
    }
  }

  for (let i = 0; i < parsed.length; i++) {
    const grant = parsed[i];

    // Revocation is checked on BOTH ends of every link. Checking only the leaf
    // would let a revoked device keep authorizing fresh node keys.
    if (revoked.has(grant.subjectHex)) return fail('revoked', `grant ${i} subject is revoked`);
    if (revoked.has(grant.issuerHex)) return fail('revoked', `grant ${i} issuer is revoked`);

    if (options.now < grant.notBefore) return fail('not-yet-valid', `grant ${i} is not valid yet`);
    if (options.now >= grant.notAfter) return fail('expired', `grant ${i} expired`);

    const seen = options.knownSerials?.get(`${grant.issuerHex}|${grant.subjectHex}`);
    if (seen !== undefined && grant.serial < seen) {
      return fail(
        'rolled-back',
        `grant ${i} serial ${grant.serial} is below the highest seen (${seen})`,
      );
    }

    if (!nacl.sign.detached.verify(encodeParsed(grant), signatures[i], grant.issuer)) {
      return fail('bad-signature', `grant ${i} signature does not verify`);
    }

    if (i === 0) continue;
    const child = parsed[i - 1];

    // Links must actually connect: this grant's subject is the key that issued
    // the grant below it.
    if (!bytesEqual(grant.subject, child.issuer)) {
      return fail('chain-broken', `grant ${i} does not authorize the issuer of grant ${i - 1}`);
    }

    // Every link above the leaf authorizes a key that goes on to sign another
    // grant, so it must itself carry DELEGATE. Without this a node key could
    // sign a grant for a second node key — a leaf could mint its own siblings.
    if (!grant.purposes.includes(GrantPurpose.DELEGATE)) {
      return fail(
        'purpose-not-granted',
        `grant ${i} authorizes a key that signs other grants, but does not carry the delegate purpose`,
      );
    }

    // Narrowing, part 1: a key can only hand on purposes it holds. A device
    // delegated for client use cannot mint a service-node key.
    const escalated = child.purposes.find((p) => !grant.purposes.includes(p));
    if (escalated) {
      return fail(
        'purpose-not-granted',
        `grant ${i - 1} claims ${escalated}, which its issuer lacks`,
      );
    }

    // Narrowing, part 2: an issuer scoped to a name can only authorize that
    // name or names under it. An unscoped child of a scoped issuer would be
    // BROADER than its issuer, so it is refused too.
    if (grant.scope !== undefined) {
      if (child.scope === undefined || !scopeCovers(grant.scope, child.scope)) {
        return fail('scope-mismatch', `grant ${i - 1} is not within its issuer's scope`);
      }
    }

    // Narrowing, part 3: a key cannot authorize anything outside its own
    // lifetime, so revoking-by-expiry an intermediate actually ends its subtree.
    if (child.notBefore < grant.notBefore || child.notAfter > grant.notAfter) {
      return fail('window-not-nested', `grant ${i - 1} outlives or predates its issuer's grant`);
    }
  }

  // A key appearing twice means a cycle; with linkage checked, comparing the
  // leaf subject and every issuer covers every key in the chain.
  const keys = [parsed[0].subjectHex, ...parsed.map((g) => g.issuerHex)];
  if (new Set(keys).size !== keys.length) return fail('malformed', 'a key repeats in the chain');

  const root = parsed[parsed.length - 1];
  if (!roots.has(root.issuerHex)) {
    return fail('untrusted-root', 'chain does not terminate at a trusted root');
  }

  const leaf = parsed[0];
  if (!leaf.purposes.includes(options.requirePurpose)) {
    return fail('purpose-not-granted', `leaf does not carry the ${options.requirePurpose} purpose`);
  }

  return {
    ok: true,
    purposes: leaf.purposes,
    subject: leaf.subject,
    scope: leaf.scope,
    notBefore: leaf.notBefore,
    notAfter: leaf.notAfter,
    serials: parsed.map((g) => ({ key: `${g.issuerHex}|${g.subjectHex}`, serial: g.serial })),
  };
}

/**
 * Verify a chain, leaf first.
 *
 * `chain[0]` authorizes the key being checked; each subsequent grant authorizes
 * the previous one's issuer; the last must be issued by a trusted root.
 *
 * Remote input never throws: a bad chain is a `{ ok: false }` result. Caller
 * mistakes — a malformed root or revocation entry, a non-integer `now` — DO
 * throw, because silently ignoring a bad revocation entry fails open.
 */
export function verifyChain(chain: readonly Grant[], options: VerifyOptions): VerifyResult {
  const scoped = SCOPED_PURPOSES.has(options.requirePurpose);
  if (options.requireScope !== undefined || scoped) {
    if (!isValidScope(options.requireScope)) {
      return fail(
        'scope-required',
        `verifying ${options.requirePurpose} requires a canonical requireScope`,
      );
    }
  }

  const result = verifyChainCore(chain, options);
  if (!result.ok) return result;

  // Scope is what makes "this key is valid" mean "valid FOR example.ox". The
  // leaf must be bound to EXACTLY the requested name: covering-by-suffix is
  // for intermediates (narrowing), not for the key that is finally used.
  if (options.requireScope !== undefined && result.scope !== options.requireScope) {
    return fail('scope-mismatch', 'leaf is not scoped to the requested name');
  }
  return result;
}
