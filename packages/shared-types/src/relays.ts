/**
 * Wire contracts for the `/relays` endpoints.
 *
 * These declarations are the ONLY definition of what a relay sends and what the
 * registry accepts. `apps/api` parses incoming bodies with the parsers below,
 * and `packages/client` builds outgoing bodies from the same interfaces, so a
 * field one side changes is a typecheck failure on the other.
 *
 * They did not always agree. Before this package existed the client sent
 * `{ port, location }` to `POST /relays/register` while the API required
 * `{ endpoint, publicKey, operator, capacity }`, so every registration returned
 * 400 and `tnp relay` aborted at startup — audit finding B2. Nothing in the
 * type system could have caught that, because there was no type: both sides
 * wrote object literals against a shape they had read once in the other's
 * source.
 */

import {
  asRecord,
  integerField,
  optionalStringField,
  stringField,
  type ParseResult,
} from './parse.js';

/**
 * Who runs a relay. A directory fact clients may weigh, not a privileged
 * status — see `docs/architecture/relays.md` §1.
 *
 * Decided by the registry, never by the relay: `oxy` is published only for a
 * relay registered by an account on the API's `TNP_OXY_RELAY_OPERATORS`
 * allowlist, and everything else is `community`. It used to be a request
 * field, so any Oxy account could register a relay as `oxy` and be
 * auto-selected by every `tnp serve` that preferred Oxy relays.
 */
export type RelayOperator = 'oxy' | 'community';

/** Directory liveness, driven by heartbeats. */
export type RelayStatus = 'active' | 'degraded' | 'offline';

/**
 * What a relay advertises it can carry.
 *
 * Bounds are part of the contract rather than the database schema so both sides
 * reject the same values: `maxConnections` is a real ceiling the relay enforces
 * on its own listener, and `bandwidth` is an advertised Mbit/s ceiling where 0
 * means "the operator has not stated one".
 */
export interface RelayCapacity {
  maxConnections: number;
  bandwidth: number;
}

export const MAX_RELAY_CONNECTIONS = 1_000_000;
export const MAX_RELAY_BANDWIDTH_MBPS = 1_000_000;

/**
 * Proof that the caller holds the private half of the relay key: an Ed25519
 * signature by that key over the registry statement (`@tnp/crypto`
 * `signRelayRegistryProof`: purpose, endpoint, relay key, `issuedAt`).
 *
 * The registry lists a community relay in the signed directory only while it
 * has recently proved possession this way — on registration and on every
 * heartbeat. Optional on the wire so relays released before it keep
 * registering; such a relay is in the registry but never in the signed
 * directory.
 */
export interface RelayKeyProof {
  /** Unix seconds when the relay signed. The registry accepts a few minutes either way. */
  issuedAt: number;
  /** Canonical base64 of the 64-byte signature. */
  signature: string;
}

/** How far `RelayKeyProof.issuedAt` may be from the registry's clock, seconds. */
export const RELAY_KEY_PROOF_WINDOW_SECONDS = 300;

/**
 * `POST /relays/register` request.
 *
 * There is no `operator` field: the registry decides it (see `RelayOperator`).
 * Relays released before that change still send `operator`; the parser
 * ignores it, like any other field outside the contract, so they keep
 * registering — as `community`.
 */
export interface RegisterRelayRequest {
  /**
   * Public `wss://` URL clients dial, on a publicly reachable host. Canonical
   * form — see `normalizeRelayEndpoint` and `publicRelayEndpointProblem`.
   */
  endpoint: string;
  /** Base64 Ed25519 identity public key of the relay. */
  publicKey: string;
  capacity: RelayCapacity;
  /** Free-form operator label (a city, a region). `""` when unlabelled. */
  location: string;
  /** Possession of `publicKey`, purpose `register`. */
  proof?: RelayKeyProof;
}

/** `POST /relays/register` response. */
export interface RelayRegistration {
  endpoint: string;
  publicKey: string;
  operator: RelayOperator;
  capacity: RelayCapacity;
  location: string;
  status: RelayStatus;
}

/**
 * `POST /relays/heartbeat` request.
 *
 * Keyed by endpoint, not by a registration id: the endpoint is the relay's
 * identity in the directory (it is the unique index), and a relay that
 * restarts knows its own endpoint without having to persist anything the
 * registry handed it.
 */
export interface RelayHeartbeatRequest {
  endpoint: string;
  /** Possession of the registered key, purpose `heartbeat`. */
  proof?: RelayKeyProof;
}

export interface RelayHeartbeatResponse {
  status: 'ok';
}

/**
 * One entry of the `GET /relays` directory listing.
 *
 * The listing holds only relays whose last heartbeat is recent, ordered with
 * Oxy-operated relays first. No timestamp is published: when a relay last
 * checked in is the registry's business, not the public's.
 */
export interface RelayDirectoryEntry {
  endpoint: string;
  publicKey: string;
  operator: RelayOperator;
  location: string;
  status: RelayStatus;
}

const RELAY_ENDPOINT_PROTOCOLS = new Set(['ws:', 'wss:']);

/**
 * Canonical form of a relay endpoint, or `null` if it is not one.
 *
 * Registration stores the endpoint and heartbeat looks it up by exact match, so
 * `wss://relay.example.com/` and `wss://Relay.Example.com` must not be two
 * different relays — and a relay that registered with one spelling and
 * heartbeats with the other must not silently decay to `offline`. Both sides
 * normalize through this function, which is why they agree.
 *
 * Credentials, query strings and fragments are refused rather than stripped:
 * this value is published in a directory other people's clients dial, and
 * quietly dropping half of what an operator typed is how a relay ends up
 * listed at an address that is not the one it is serving.
 */
export function normalizeRelayEndpoint(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }

  if (!RELAY_ENDPOINT_PROTOCOLS.has(url.protocol)) return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  if (url.hostname === '') return null;

  // `url.host` is already lowercased and carries the port only when it is
  // non-default for the scheme.
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** Hostname suffixes that never name a publicly reachable host. */
const LOCAL_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa', '.lan'];

function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

/** Loopback, private, link-local, CGNAT, documentation, benchmarking, multicast, reserved. */
function isNonPublicIpv4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Eight 16-bit groups of a bracket-free IPv6 literal as the URL parser prints it, or null. */
function ipv6Groups(host: string): number[] | null {
  if (!host.includes(':')) return null;
  const [head, tail, ...rest] = host.split('::');
  if (rest.length > 0) return null;
  const parse = (part: string | undefined) =>
    part ? part.split(':').map((group) => Number.parseInt(group, 16)) : [];
  const left = parse(head);
  const right = parse(tail);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...new Array<number>(missing).fill(0), ...right];
  return groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff)
    ? groups
    : null;
}

function isNonPublicIpv6(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const allZeroTo = (n: number) => groups.slice(0, n).every((group) => group === 0);
  // :: and ::1
  if (allZeroTo(7) && (g7 === 0 || g7 === 1)) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and the deprecated IPv4-compatible form: judge the IPv4 inside.
  if (allZeroTo(5) && (g5 === 0xffff || g5 === 0)) {
    return isNonPublicIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  return (
    (g0 & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (g0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (g0 & 0xffc0) === 0xfec0 || // fec0::/10 site-local (deprecated)
    (g0 & 0xff00) === 0xff00 || // ff00::/8 multicast
    (g0 === 0x2001 && g1 === 0x0db8) || // 2001:db8::/32 documentation
    (g0 === 0x0064 && g1 === 0xff9b && g2 === 0x0001) || // 64:ff9b:1::/48 local NAT64
    (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) // 100::/64 discard
  );
}

/**
 * Why `endpoint` cannot be published in the relay directory, or `null` if it
 * can. `endpoint` must already be canonical (`normalizeRelayEndpoint`).
 *
 * The directory is read by other people's clients, so an entry has to be
 * something they can safely dial:
 *
 * - `wss://` only. A `ws://` relay's traffic and its WebSocket upgrade are
 *   readable and rewritable by anyone on the path, and the relay frames are
 *   only end-to-end encrypted once a circuit is up.
 * - A public host. A loopback, private or link-local address in the directory
 *   points every client that selects it at something on its own network.
 *   Hostnames that resolve to such addresses cannot be caught here (that
 *   needs the resolution a client does at dial time); IP literals and names
 *   that are local by definition can.
 */
export function publicRelayEndpointProblem(endpoint: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return RELAY_ENDPOINT_SHAPE_ERROR;
  }
  if (url.protocol !== 'wss:') {
    return 'endpoint must use wss://; plain ws:// relays are not published';
  }

  // The WHATWG parser has already canonicalized the host: IPv4 in any of its
  // legacy spellings (`2130706433`, `0x7f.1`) is printed dotted-decimal, and
  // IPv6 is bracketed, lowercased and compressed.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const v4 = ipv4Octets(host);
  const v6 = v4 ? null : ipv6Groups(host);
  const local =
    (v4 !== null && isNonPublicIpv4(v4)) ||
    (v6 !== null && isNonPublicIpv6(v6)) ||
    (v4 === null &&
      v6 === null &&
      (host === 'localhost' ||
        !host.includes('.') ||
        LOCAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))));
  return local
    ? 'endpoint must be a publicly reachable host, not a private, loopback or local address'
    : null;
}

const RELAY_ENDPOINT_SHAPE_ERROR =
  'endpoint must be a wss:// URL with no credentials, query or fragment';

function relayEndpointField(record: Record<string, unknown>): ParseResult<string> {
  const raw = stringField(record, 'endpoint');
  if (!raw.ok) return raw;

  const endpoint = normalizeRelayEndpoint(raw.value);
  if (endpoint === null) return { ok: false, error: RELAY_ENDPOINT_SHAPE_ERROR };

  const problem = publicRelayEndpointProblem(endpoint);
  if (problem !== null) return { ok: false, error: problem };

  return { ok: true, value: endpoint };
}

/** An optional `proof` field: absent is fine, present must be well-formed. */
function relayKeyProofField(
  record: Record<string, unknown>,
): ParseResult<RelayKeyProof | undefined> {
  const raw = record.proof;
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  const proof = asRecord(raw);
  if (!proof) return { ok: false, error: 'proof must be an object' };
  for (const key of Object.keys(proof)) {
    if (key !== 'issuedAt' && key !== 'signature') {
      return { ok: false, error: 'proof has an unexpected field' };
    }
  }
  const issuedAt = integerField(proof, 'issuedAt', 0, Number.MAX_SAFE_INTEGER);
  if (!issuedAt.ok) return { ok: false, error: `proof.${issuedAt.error}` };
  const signature = proof.signature;
  if (typeof signature !== 'string' || signature.length !== 88) {
    return { ok: false, error: 'proof.signature must be a base64 Ed25519 signature' };
  }
  return { ok: true, value: { issuedAt: issuedAt.value, signature } };
}

export function parseRegisterRelayRequest(body: unknown): ParseResult<RegisterRelayRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: 'request body must be an object' };

  const endpoint = relayEndpointField(record);
  if (!endpoint.ok) return endpoint;

  const publicKey = stringField(record, 'publicKey');
  if (!publicKey.ok) return publicKey;

  // `operator` is deliberately not read. The registry decides it from the
  // authenticated account; a value sent by a relay released before that change
  // is ignored rather than refused, so those relays keep registering.

  const capacity = asRecord(record.capacity);
  if (!capacity) {
    return { ok: false, error: 'capacity with maxConnections and bandwidth is required' };
  }

  const maxConnections = integerField(capacity, 'maxConnections', 1, MAX_RELAY_CONNECTIONS);
  if (!maxConnections.ok) {
    return { ok: false, error: `capacity.${maxConnections.error}` };
  }

  const bandwidth = integerField(capacity, 'bandwidth', 0, MAX_RELAY_BANDWIDTH_MBPS);
  if (!bandwidth.ok) {
    return { ok: false, error: `capacity.${bandwidth.error}` };
  }

  // Tolerant only here, and only in the safe direction: an unlabelled relay is
  // a relay, so an absent label is `""` rather than a rejection. Every field
  // the registry actually depends on is required above.
  const location = optionalStringField(record, 'location');
  if (!location.ok) return location;

  const proof = relayKeyProofField(record);
  if (!proof.ok) return proof;

  return {
    ok: true,
    value: {
      endpoint: endpoint.value,
      publicKey: publicKey.value,
      capacity: { maxConnections: maxConnections.value, bandwidth: bandwidth.value },
      location: location.value,
      ...(proof.value ? { proof: proof.value } : {}),
    },
  };
}

export function parseRelayHeartbeatRequest(body: unknown): ParseResult<RelayHeartbeatRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: 'request body must be an object' };

  const endpoint = relayEndpointField(record);
  if (!endpoint.ok) return endpoint;

  const proof = relayKeyProofField(record);
  if (!proof.ok) return proof;

  return {
    ok: true,
    value: { endpoint: endpoint.value, ...(proof.value ? { proof: proof.value } : {}) },
  };
}
