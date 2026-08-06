/**
 * Wire contracts for the `/nodes` endpoints.
 *
 * Same rule as `relays.ts`: one declaration, parsed by `apps/api` and built by
 * `packages/client`. These two happened to agree when the package was
 * extracted — they agreed by hand, which is the same footing the relay
 * endpoints were on right up until they did not.
 */

import { asRecord, stringField, type ParseResult } from "./parse.js";

export type ServiceNodeStatus = "online" | "offline";

/**
 * A domain id as the registry issues it.
 *
 * Postgres rejects a malformed uuid with a 500-level error rather than a
 * mismatch, so the shape is checked before the value reaches a query — and it
 * is checked here so the client and the API mean the same thing by "domainId".
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `POST /nodes/register` request. */
export interface RegisterServiceNodeRequest {
  domainId: string;
  /** Base64 X25519 public key the client uses for circuit key exchange. */
  publicKey: string;
}

/** `POST /nodes/register` response. */
export interface ServiceNodeRegistration {
  domainId: string;
  publicKey: string;
  connectedRelay: string;
  status: ServiceNodeStatus;
}

/** `POST /nodes/heartbeat` request. */
export interface ServiceNodeHeartbeatRequest {
  domainId: string;
  /** Endpoint of the relay this node is currently attached to. */
  connectedRelay: string;
}

export interface ServiceNodeHeartbeatResponse {
  status: "ok";
}

/** `GET /nodes/:domain` response. */
export interface ServiceNodeLookup {
  publicKey: string;
  connectedRelay: string;
  status: ServiceNodeStatus;
  /** ISO 8601 timestamp of the last heartbeat. */
  lastSeen: string;
}

function domainIdField(record: Record<string, unknown>): ParseResult<string> {
  const domainId = stringField(record, "domainId");
  if (!domainId.ok) return domainId;

  if (!UUID_RE.test(domainId.value)) {
    return { ok: false, error: "domainId must be a uuid" };
  }
  return domainId;
}

export function parseRegisterServiceNodeRequest(
  body: unknown,
): ParseResult<RegisterServiceNodeRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: "request body must be an object" };

  const domainId = domainIdField(record);
  if (!domainId.ok) return domainId;

  const publicKey = stringField(record, "publicKey");
  if (!publicKey.ok) return publicKey;

  return { ok: true, value: { domainId: domainId.value, publicKey: publicKey.value } };
}

export function parseServiceNodeHeartbeatRequest(
  body: unknown,
): ParseResult<ServiceNodeHeartbeatRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: "request body must be an object" };

  const domainId = domainIdField(record);
  if (!domainId.ok) return domainId;

  const connectedRelay = stringField(record, "connectedRelay");
  if (!connectedRelay.ok) return connectedRelay;

  return {
    ok: true,
    value: { domainId: domainId.value, connectedRelay: connectedRelay.value },
  };
}
