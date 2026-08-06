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
} from "./parse.js";

/**
 * Who runs a relay. A directory fact clients may weigh, not a privileged
 * status — see `docs/architecture/relays.md` §1.
 */
export type RelayOperator = "oxy" | "community";

/** Directory liveness, driven by heartbeats. */
export type RelayStatus = "active" | "degraded" | "offline";

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

/** `POST /relays/register` request. */
export interface RegisterRelayRequest {
  /** Public `ws://` or `wss://` URL clients dial. Canonical form — see `normalizeRelayEndpoint`. */
  endpoint: string;
  /** Base64 Ed25519 identity public key of the relay. */
  publicKey: string;
  operator: RelayOperator;
  capacity: RelayCapacity;
  /** Free-form operator label (a city, a region). `""` when unlabelled. */
  location: string;
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
}

export interface RelayHeartbeatResponse {
  status: "ok";
}

/** One entry of the `GET /relays` directory listing. */
export interface RelayDirectoryEntry {
  endpoint: string;
  publicKey: string;
  operator: RelayOperator;
  location: string;
  status: RelayStatus;
}

const RELAY_ENDPOINT_PROTOCOLS = new Set(["ws:", "wss:"]);

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
  if (url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  if (url.hostname === "") return null;

  // `url.host` is already lowercased and carries the port only when it is
  // non-default for the scheme.
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

function relayEndpointField(
  record: Record<string, unknown>,
): ParseResult<string> {
  const raw = stringField(record, "endpoint");
  if (!raw.ok) return raw;

  const endpoint = normalizeRelayEndpoint(raw.value);
  if (endpoint === null) {
    return {
      ok: false,
      error: "endpoint must be a ws:// or wss:// URL with no credentials, query or fragment",
    };
  }
  return { ok: true, value: endpoint };
}

export function parseRegisterRelayRequest(
  body: unknown,
): ParseResult<RegisterRelayRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: "request body must be an object" };

  const endpoint = relayEndpointField(record);
  if (!endpoint.ok) return endpoint;

  const publicKey = stringField(record, "publicKey");
  if (!publicKey.ok) return publicKey;

  const operator = record.operator;
  if (operator !== "oxy" && operator !== "community") {
    return { ok: false, error: "operator must be 'oxy' or 'community'" };
  }

  const capacity = asRecord(record.capacity);
  if (!capacity) {
    return { ok: false, error: "capacity with maxConnections and bandwidth is required" };
  }

  const maxConnections = integerField(capacity, "maxConnections", 1, MAX_RELAY_CONNECTIONS);
  if (!maxConnections.ok) {
    return { ok: false, error: `capacity.${maxConnections.error}` };
  }

  const bandwidth = integerField(capacity, "bandwidth", 0, MAX_RELAY_BANDWIDTH_MBPS);
  if (!bandwidth.ok) {
    return { ok: false, error: `capacity.${bandwidth.error}` };
  }

  // Tolerant only here, and only in the safe direction: an unlabelled relay is
  // a relay, so an absent label is `""` rather than a rejection. Every field
  // the registry actually depends on is required above.
  const location = optionalStringField(record, "location");
  if (!location.ok) return location;

  return {
    ok: true,
    value: {
      endpoint: endpoint.value,
      publicKey: publicKey.value,
      operator,
      capacity: { maxConnections: maxConnections.value, bandwidth: bandwidth.value },
      location: location.value,
    },
  };
}

export function parseRelayHeartbeatRequest(
  body: unknown,
): ParseResult<RelayHeartbeatRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: "request body must be an object" };

  const endpoint = relayEndpointField(record);
  if (!endpoint.ok) return endpoint;

  return { ok: true, value: { endpoint: endpoint.value } };
}
