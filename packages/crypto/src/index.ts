/**
 * `@tnp/crypto` — the key hierarchy (grants), key-agreement certificates, and
 * the strict encodings both are built on.
 *
 * Low-level primitives (X25519 with small-order rejection, AEAD, HKDF) are
 * under `@tnp/crypto/primitives`; they are for protocol implementations, not
 * for application code.
 */
export * from './encoding.js';
// Explicit, so the chain core (no leaf scope check) and signing helpers stay internal.
export {
  canonicalGrantBytes,
  type Grant,
  GrantPurpose,
  type GrantPurposeValue,
  MAX_CHAIN_DEPTH,
  SCOPED_PURPOSES,
  type ScopedPurpose,
  serialKey,
  signGrant,
  type UnscopedPurpose,
  type UnsignedGrant,
  type VerifiedChain,
  type VerifyFailure,
  type VerifyOptions,
  type VerifyOptionsBase,
  type VerifyResult,
  verifyChain,
} from './grants.js';
export * from './key-agreement.js';
export * from './scope.js';
export * from './domain-key.js';
export * from './service-auth.js';
