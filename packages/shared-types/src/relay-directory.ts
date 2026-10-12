/**
 * The signed relay directory contract: `GET /relays/directory`, the pinned
 * directory signing key(s), and the endpoint policy every listed relay must
 * meet.
 *
 * The signature format, canonical bytes and the signature/expiry/serial checks
 * are `@tnp/crypto` (`relay-directory.ts`). This file adds what a client needs
 * on top: WHICH keys it trusts, and that every endpoint is canonical and
 * publicly dialable. Normative: docs/architecture/discovery.md §2,
 * relays.md §8, security.md §5.
 *
 * What the directory protects against, and what it does not: the API signs at
 * request time with a key it holds (`TNP_DIRECTORY_SIGNING_SEED`), so a
 * compromised API can sign a directory. The signature defends against network
 * tampering (a TLS-intercepting middlebox, a hostile CDN edge) and stale or
 * rolled-back directories (expiry plus a per-client, per-signing-key serial
 * high-water mark). It does NOT by itself stop the registry choosing among
 * listed relays: which relay a name is reached through comes from the resolve
 * record, and community relays are listed after a key proof and a live check
 * that any Oxy account can pass for an endpoint it controls. What binds a
 * name to its relay is the service node's signed relay binding (node key,
 * rooted in the domain key) — see relays.md §8 for the exact guarantee.
 * End-to-end confidentiality never depends on any of it: circuits are keyed
 * to each name's domain key, which no relay — listed or not — holds.
 */

import {
  type DirectoryRejection,
  decodeBase64Strict,
  MAX_DIRECTORY_BYTES,
  type SignedRelayDirectory,
  type VerifiedRelayDirectory,
  verifyRelayDirectory,
} from '@tnp/crypto';
import { normalizeRelayEndpoint, publicRelayEndpointProblem } from './relays.js';

/**
 * The directory signing public keys this client trusts: raw 32-byte Ed25519,
 * canonical base64. Normally one. During a rotation, two — the current key and
 * the next one — so clients released before the switch keep verifying after
 * it (security.md §6):
 *
 *   1. Generate the next key offline; add its PUBLIC key here; release clients.
 *   2. Once those clients are deployed widely, switch the API's
 *      `TNP_DIRECTORY_SIGNING_SEED` (SSM) to the next seed.
 *   3. In a later release, remove the retired key from this list.
 *
 * The matching seed of the current key is the SSM SecureString the API's ECS
 * task reads as `TNP_DIRECTORY_SIGNING_SEED`. Never edit this list to make a
 * directory verify.
 */
export const RELAY_DIRECTORY_SIGNING_KEYS_BASE64: readonly string[] = [
  'YTpKuzdrDqXzu02NjkF3KWeZCMY35DBNFnkVOL/Bq14=',
];

/** The pinned directory signing keys as raw bytes. */
export function relayDirectorySigningKeys(): Uint8Array[] {
  return RELAY_DIRECTORY_SIGNING_KEYS_BASE64.map((key) => decodeBase64Strict(key, 32));
}

/**
 * How long a directory the API signs stays valid. Short, because it is also
 * the longest a client keeps using a cached copy while the API is blocked —
 * the window in which a delisted relay can still be used. Clients refetch
 * every 10 minutes and drop relays that are no longer listed.
 */
export const RELAY_DIRECTORY_LIFETIME_SECONDS = 6 * 3600;

/** Capability tokens a listed relay may carry. Clients ignore tokens they do not know. */
export const RelayCapability = {
  /** Accepts anonymous client circuits on `/tunnel`. */
  TUNNEL: 'tunnel',
  /** Accepts authenticated service nodes on `/service`. */
  SERVICE: 'service',
} as const;

/** `GET /relays/directory` response body: the signed document itself. */
export type RelayDirectoryResponse = SignedRelayDirectory;

export interface VerifySignedRelayDirectoryOptions {
  /** Unix seconds. */
  now: number;
  /** Highest serial accepted before (rollback protection). */
  minSerial?: number;
  /** Defaults to {@link relayDirectorySigningKeys}. Tests pass their own. */
  trustedKeys?: readonly Uint8Array[];
  /**
   * Accept `ws://` and non-public hosts. Tests over loopback only; never set
   * by the CLI.
   */
  allowNonPublicEndpoints?: boolean;
}

/** Why a client refused a directory. */
export type RelayDirectoryFailure = DirectoryRejection | 'bad-endpoint';

export type SignedRelayDirectoryResult =
  | { ok: true; directory: VerifiedRelayDirectory }
  | { ok: false; reason: RelayDirectoryFailure };

/**
 * Verify a directory against the pinned keys, then the endpoint policy: every
 * endpoint canonical (as `normalizeRelayEndpoint` prints it, so a client's
 * lookup by the URL it dials matches exactly one entry) and, unless a test
 * allows otherwise, a `wss://` URL on a public host. A signed document that
 * breaks the policy is refused whole — the signer is broken, and nothing it
 * signed is used.
 */
export function verifySignedRelayDirectory(
  body: unknown,
  options: VerifySignedRelayDirectoryOptions,
): SignedRelayDirectoryResult {
  const result = verifyRelayDirectory(body, {
    trustedKeys: options.trustedKeys ?? relayDirectorySigningKeys(),
    now: options.now,
    minSerial: options.minSerial,
  });
  if (!result.ok) return result;
  for (const relay of result.directory.relays) {
    if (normalizeRelayEndpoint(relay.endpoint) !== relay.endpoint) {
      return { ok: false, reason: 'bad-endpoint' };
    }
    if (!options.allowNonPublicEndpoints && publicRelayEndpointProblem(relay.endpoint) !== null) {
      return { ok: false, reason: 'bad-endpoint' };
    }
  }
  return result;
}

/** Largest `GET /relays/directory` body a client reads (JSON is bigger than the canonical form). */
export const MAX_RELAY_DIRECTORY_RESPONSE_BYTES = 4 * MAX_DIRECTORY_BYTES;

/** Human wording for a rejection, for logs and CLI errors. */
export function describeDirectoryRejection(reason: RelayDirectoryFailure): string {
  switch (reason) {
    case 'malformed':
      return 'the relay directory is malformed or unsigned';
    case 'oversized':
      return 'the relay directory is too large';
    case 'bad-signature':
      return 'the relay directory is not signed by a pinned directory key';
    case 'not-yet-valid':
      return 'the relay directory is dated in the future (check this device’s clock)';
    case 'expired':
      return 'the relay directory has expired';
    case 'rolled-back':
      return 'the relay directory is older than one this device has already seen (rollback refused)';
    case 'bad-endpoint':
      return 'the relay directory lists an endpoint that is not a canonical public wss:// URL';
  }
}
