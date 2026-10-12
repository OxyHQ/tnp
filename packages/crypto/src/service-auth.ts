/**
 * Service-node authentication to a relay.
 *
 * Normative spec: docs/architecture/relays.md §2 and transport.md §6.
 *
 * Audit S2: a relay accepted `/service?domain=<anything>` with no proof at all
 * and evicted whoever served that name before. Now a service node proves, per
 * connection, that it holds a node key the DOMAIN KEY authorized for that
 * name: the relay sends a fresh CSPRNG challenge, the node signs this
 * statement with its node key and sends its grant chain, and the relay checks
 * the chain against the domain key the registry publishes.
 *
 *   u32 len ‖ "tnp-relay-service-auth-v1"
 *   u32 len ‖ name                 the domain being served
 *   u32 len ‖ relay endpoint       the URL the node dialed, normalized
 *   challenge (32 raw bytes)       fresh per connection, chosen by the relay
 *   node key (32 raw bytes)
 *
 * The endpoint binds the proof to one relay: a hostile relay that forwards its
 * own challenge from another relay cannot get a signature that the other relay
 * accepts, because the node signs the endpoint IT dialed. The challenge binds
 * it to one connection, so a recorded proof is useless.
 */

import nacl from 'tweetnacl';
import {
  CanonicalWriter,
  decodeBase64Strict,
  EncodingError,
  encodeBase64,
  PUBLIC_KEY_LENGTH,
  parsePublicKey,
  SIGNATURE_LENGTH,
} from './encoding.js';
import { assertSecretMatches } from './grants.js';
import { isValidScope } from './scope.js';

const SERVICE_AUTH_CONTEXT = 'tnp-relay-service-auth-v1';

/** Challenge length, bytes. */
export const SERVICE_AUTH_CHALLENGE_SIZE = 32;

/** Longest endpoint string accepted in a proof. */
const MAX_ENDPOINT_LENGTH = 512;

export interface ServiceAuthStatement {
  name: string;
  endpoint: string;
  challenge: Uint8Array;
  /** Ed25519 node key, base64 or 32 raw bytes. */
  nodeKey: string | Uint8Array;
}

function encodeStatement(statement: ServiceAuthStatement): Uint8Array {
  if (!isValidScope(statement.name)) throw new EncodingError('name is not a canonical name');
  if (
    typeof statement.endpoint !== 'string' ||
    statement.endpoint.length === 0 ||
    statement.endpoint.length > MAX_ENDPOINT_LENGTH
  ) {
    throw new EncodingError('endpoint is missing or too long');
  }
  if (
    !(statement.challenge instanceof Uint8Array) ||
    statement.challenge.length !== SERVICE_AUTH_CHALLENGE_SIZE
  ) {
    throw new EncodingError(`challenge must be ${SERVICE_AUTH_CHALLENGE_SIZE} bytes`);
  }
  return new CanonicalWriter()
    .string(SERVICE_AUTH_CONTEXT)
    .string(statement.name)
    .string(statement.endpoint)
    .fixed(statement.challenge, SERVICE_AUTH_CHALLENGE_SIZE)
    .fixed(parsePublicKey(statement.nodeKey), PUBLIC_KEY_LENGTH)
    .finish();
}

/** Sign with the node key's 64-byte Ed25519 secret. Returns the base64 signature. */
export function signServiceAuth(
  statement: ServiceAuthStatement,
  nodeSecretKey: Uint8Array,
): string {
  const bytes = encodeStatement(statement);
  assertSecretMatches(nodeSecretKey, parsePublicKey(statement.nodeKey));
  return encodeBase64(nacl.sign.detached(bytes, nodeSecretKey));
}

/** Verify a proof. Never throws on remote input. */
export function verifyServiceAuth(statement: ServiceAuthStatement, signature: string): boolean {
  try {
    const bytes = encodeStatement(statement);
    const sig = decodeBase64Strict(signature, SIGNATURE_LENGTH);
    return nacl.sign.detached.verify(bytes, sig, parsePublicKey(statement.nodeKey));
  } catch {
    return false;
  }
}
