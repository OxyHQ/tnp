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
 *   Session keys              per circuit, ephemeral, never persisted
 *
 * A verifier walks the chain to a trusted root, checking every signature, every
 * validity window, every purpose and every revocation. A chain with one
 * unverifiable link is REJECTED — never partially trusted.
 */

import nacl from "tweetnacl";

/** What a child key is allowed to be used for. */
export const GrantPurpose = {
  /** Authorize further keys. Only a device identity should hold this. */
  DELEGATE: "delegate",
  /** Terminate a circuit's end-to-end encryption for a domain. */
  SERVICE_NODE: "service-node",
  /** Sign a domain's record set. */
  DOMAIN_RECORDS: "domain-records",
  /** Authenticate as a relay in the directory. */
  RELAY: "relay",
  /** Open circuits as a client. */
  CLIENT: "client",
} as const;

export type GrantPurposeValue = (typeof GrantPurpose)[keyof typeof GrantPurpose];

const PURPOSES: ReadonlySet<string> = new Set(Object.values(GrantPurpose));

/**
 * A signed statement: this key authorizes that key, for these purposes, until
 * this time.
 *
 * `serial` is monotonic per issuer+subject so a verifier can refuse a rollback
 * to a superseded grant — replaying an old, still-unexpired grant after a
 * rotation would otherwise re-enable a key its owner has already retired.
 */
export interface Grant {
  /** Public key of the issuer, base64. */
  issuer: string;
  /** Public key being authorized, base64. */
  subject: string;
  purposes: GrantPurposeValue[];
  /** Unix seconds. */
  notBefore: number;
  /** Unix seconds. */
  notAfter: number;
  serial: number;
  /**
   * What the subject key speaks for — a domain for SERVICE_NODE and
   * DOMAIN_RECORDS, an endpoint for RELAY. Absent for DELEGATE and CLIENT.
   *
   * This is the field whose absence made S3 possible: without it a key is
   * authorized in the abstract, and "this key is valid" says nothing about
   * "valid FOR example.ox".
   */
  scope?: string;
  /** Ed25519 signature over the canonical encoding, base64. */
  signature: string;
}

/** A grant with everything but the signature — what gets signed. */
export type UnsignedGrant = Omit<Grant, "signature">;

export type VerifyFailure =
  | "bad-signature"
  | "not-yet-valid"
  | "expired"
  | "revoked"
  | "purpose-not-granted"
  | "scope-mismatch"
  | "chain-broken"
  | "chain-too-long"
  | "untrusted-root"
  | "rolled-back"
  | "malformed";

export type VerifyResult =
  | { ok: true; purposes: GrantPurposeValue[] }
  | { ok: false; reason: VerifyFailure; detail: string };

/**
 * Longest chain a verifier will walk.
 *
 * The hierarchy is three links (identity → device → node), so four is slack.
 * A bound is required regardless: without one, a cyclic or absurdly long chain
 * is an unbounded loop driven by remote input.
 */
export const MAX_CHAIN_DEPTH = 4;

const textEncoder = new TextEncoder();

/**
 * Canonical bytes of a grant, for signing and verifying.
 *
 * Field order is fixed and every field is length-prefixed. `JSON.stringify` is
 * not canonical — key order is insertion order, so two encoders can produce
 * different bytes for the same grant and a signature made over one fails
 * against the other. Length prefixes also stop a field boundary from being
 * moved: without them, issuer "ab" + subject "c" and issuer "a" + subject "bc"
 * serialize identically, so a signature over one verifies the other.
 */
export function canonicalGrantBytes(grant: UnsignedGrant): Uint8Array {
  const parts: Uint8Array[] = [];

  const field = (value: string) => {
    const bytes = textEncoder.encode(value);
    const prefixed = new Uint8Array(4 + bytes.byteLength);
    new DataView(prefixed.buffer).setUint32(0, bytes.byteLength, false);
    prefixed.set(bytes, 4);
    parts.push(prefixed);
  };

  const number = (value: number) => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(Math.trunc(value)), false);
    parts.push(bytes);
  };

  field("tnp-grant-v1");
  field(grant.issuer);
  field(grant.subject);
  // Sorted, so the order a caller happened to list purposes in cannot change
  // the bytes and invalidate an otherwise-good signature.
  field([...grant.purposes].sort().join(","));
  number(grant.notBefore);
  number(grant.notAfter);
  number(grant.serial);
  field(grant.scope ?? "");

  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function signGrant(grant: UnsignedGrant, issuerSecretKey: Uint8Array): Grant {
  const signature = nacl.sign.detached(canonicalGrantBytes(grant), issuerSecretKey);
  return { ...grant, signature: Buffer.from(signature).toString("base64") };
}

export interface VerifyOptions {
  /** Public keys a chain may terminate at, base64. Usually one Oxy identity. */
  trustedRoots: readonly string[];
  /** Unix seconds. Injected so validity windows are testable without waiting. */
  now: number;
  /** Revoked public keys, base64. */
  revoked?: ReadonlySet<string>;
  /** Purpose the leaf must hold. */
  requirePurpose: GrantPurposeValue;
  /** Scope the leaf must be bound to, e.g. the domain being connected to. */
  requireScope?: string;
  /**
   * Highest serial already seen per `issuer|subject`, for rollback defence.
   * A grant whose serial is below the recorded one is refused.
   */
  knownSerials?: ReadonlyMap<string, number>;
}

/**
 * Verify a chain, leaf first.
 *
 * `chain[0]` authorizes the key being checked; each subsequent grant authorizes
 * the previous one's issuer; the last must be issued by a trusted root.
 */
export function verifyChain(chain: readonly Grant[], options: VerifyOptions): VerifyResult {
  if (chain.length === 0) {
    return { ok: false, reason: "malformed", detail: "empty chain" };
  }
  if (chain.length > MAX_CHAIN_DEPTH) {
    return {
      ok: false,
      reason: "chain-too-long",
      detail: `chain of ${chain.length} exceeds MAX_CHAIN_DEPTH (${MAX_CHAIN_DEPTH})`,
    };
  }

  const revoked = options.revoked ?? new Set<string>();

  for (let i = 0; i < chain.length; i++) {
    const grant = chain[i];

    const shape = checkShape(grant);
    if (shape) return shape;

    // Revocation is checked on BOTH ends of every link. Checking only the leaf
    // would let a revoked device keep authorizing fresh node keys.
    if (revoked.has(grant.subject)) {
      return { ok: false, reason: "revoked", detail: `subject ${grant.subject} is revoked` };
    }
    if (revoked.has(grant.issuer)) {
      return { ok: false, reason: "revoked", detail: `issuer ${grant.issuer} is revoked` };
    }

    if (options.now < grant.notBefore) {
      return { ok: false, reason: "not-yet-valid", detail: `grant ${i} is not valid yet` };
    }
    if (options.now >= grant.notAfter) {
      return { ok: false, reason: "expired", detail: `grant ${i} expired` };
    }

    const seen = options.knownSerials?.get(`${grant.issuer}|${grant.subject}`);
    if (seen !== undefined && grant.serial < seen) {
      return {
        ok: false,
        reason: "rolled-back",
        detail: `grant ${i} serial ${grant.serial} is below the highest seen (${seen})`,
      };
    }

    if (!verifySignature(grant)) {
      return { ok: false, reason: "bad-signature", detail: `grant ${i} signature does not verify` };
    }

    // Every link above the leaf authorizes a key that goes on to sign another
    // grant, so it must itself carry DELEGATE. Without this a node key could
    // sign a grant for a second node key and the chain would still reach a
    // trusted root — a leaf could mint its own siblings.
    if (i > 0 && !grant.purposes.includes(GrantPurpose.DELEGATE)) {
      return {
        ok: false,
        reason: "purpose-not-granted",
        detail: `grant ${i} authorizes a key that signs other grants, but does not carry the delegate purpose`,
      };
    }

    // Links must actually connect: this grant's subject must be the previous
    // grant's issuer.
    if (i > 0 && grant.subject !== chain[i - 1].issuer) {
      return {
        ok: false,
        reason: "chain-broken",
        detail: `grant ${i} authorizes ${grant.subject}, but grant ${i - 1} was issued by ${chain[i - 1].issuer}`,
      };
    }
  }

  const root = chain[chain.length - 1];
  if (!options.trustedRoots.includes(root.issuer)) {
    return {
      ok: false,
      reason: "untrusted-root",
      detail: `chain terminates at ${root.issuer}, which is not a trusted root`,
    };
  }

  const leaf = chain[0];
  if (!leaf.purposes.includes(options.requirePurpose)) {
    return {
      ok: false,
      reason: "purpose-not-granted",
      detail: `leaf does not carry the ${options.requirePurpose} purpose`,
    };
  }

  // Scope is what makes "this key is valid" mean "valid FOR example.ox".
  // Without it a key authorized for one domain would verify for every domain,
  // which is S3 wearing a signature.
  if (options.requireScope !== undefined && leaf.scope !== options.requireScope) {
    return {
      ok: false,
      reason: "scope-mismatch",
      detail: `leaf is scoped to ${leaf.scope ?? "(none)"}, not ${options.requireScope}`,
    };
  }

  return { ok: true, purposes: leaf.purposes };
}

function checkShape(grant: Grant): VerifyResult | null {
  if (!grant.issuer || !grant.subject || !grant.signature) {
    return { ok: false, reason: "malformed", detail: "missing issuer, subject or signature" };
  }
  if (grant.issuer === grant.subject) {
    // A key authorizing itself proves nothing and would let any key present
    // itself as its own root.
    return { ok: false, reason: "malformed", detail: "grant is self-issued" };
  }
  if (!Array.isArray(grant.purposes) || grant.purposes.length === 0) {
    return { ok: false, reason: "malformed", detail: "no purposes" };
  }
  for (const purpose of grant.purposes) {
    if (!PURPOSES.has(purpose)) {
      return { ok: false, reason: "malformed", detail: `unknown purpose ${purpose}` };
    }
  }
  if (!Number.isFinite(grant.notBefore) || !Number.isFinite(grant.notAfter)) {
    return { ok: false, reason: "malformed", detail: "non-finite validity window" };
  }
  if (grant.notAfter <= grant.notBefore) {
    return { ok: false, reason: "malformed", detail: "validity window is empty or inverted" };
  }
  if (!Number.isInteger(grant.serial) || grant.serial < 0) {
    return { ok: false, reason: "malformed", detail: "serial must be a non-negative integer" };
  }
  return null;
}

function verifySignature(grant: Grant): boolean {
  let signature: Uint8Array;
  let issuer: Uint8Array;
  try {
    signature = new Uint8Array(Buffer.from(grant.signature, "base64"));
    issuer = new Uint8Array(Buffer.from(grant.issuer, "base64"));
  } catch {
    return false;
  }
  if (signature.byteLength !== nacl.sign.signatureLength) return false;
  if (issuer.byteLength !== nacl.sign.publicKeyLength) return false;

  const { signature: _omitted, ...unsigned } = grant;
  return nacl.sign.detached.verify(canonicalGrantBytes(unsigned), signature, issuer);
}
