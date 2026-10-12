/**
 * Wire contracts for the `/nodes` endpoints.
 *
 * Same rule as `relays.ts`: one declaration, parsed by `apps/api` and built by
 * `packages/client`. These two happened to agree when the package was
 * extracted — they agreed by hand, which is the same footing the relay
 * endpoints were on right up until they did not.
 */

import type { Grant, KeyAgreementCertificate } from '@tnp/crypto';
import { parseChainShape, parseKeyAgreementCertificateShape } from './key-material.js';
import { asRecord, stringField, type ParseResult } from './parse.js';

export type ServiceNodeStatus = 'online' | 'offline';

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
  /**
   * Grant chain, leaf first, rooted at the domain's registered DOMAIN KEY. The
   * leaf authorizes the node key for `service-node` on exactly this name.
   */
  chain: Grant[];
  /**
   * Key-agreement certificate signed by the node key: the X25519 key clients
   * run the session handshake against (at most 7 days). The node re-registers
   * with a fresh one before it expires.
   */
  kaCert: KeyAgreementCertificate;
}

/** `POST /nodes/register` response. */
export interface ServiceNodeRegistration {
  domainId: string;
  /** The node key (Ed25519, base64) — the chain's leaf subject. */
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
  status: 'ok';
}

/**
 * `GET /nodes/:domain` response — public, unauthenticated.
 *
 * Liveness is a boolean, not a timestamp. The endpoint used to publish the
 * exact time of a node's last heartbeat, which lets anyone build a minute-by-
 * minute record of when a name's operator has their machine on. `online` is
 * computed against the registry's staleness threshold; `status` carries the
 * same fact for clients released before `online` existed.
 */
export interface ServiceNodeLookup {
  /** The node key (Ed25519, base64). Informational: clients verify the chain in `/dns/resolve`. */
  publicKey: string;
  /**
   * The relay a client dials to reach the node — `""` unless `online`. Which
   * relay an offline node last used is history, not something a client can act
   * on.
   */
  connectedRelay: string;
  status: ServiceNodeStatus;
  online: boolean;
}

function domainIdField(record: Record<string, unknown>): ParseResult<string> {
  const domainId = stringField(record, 'domainId');
  if (!domainId.ok) return domainId;

  if (!UUID_RE.test(domainId.value)) {
    return { ok: false, error: 'domainId must be a uuid' };
  }
  return domainId;
}

export function parseRegisterServiceNodeRequest(
  body: unknown,
): ParseResult<RegisterServiceNodeRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: 'request body must be an object' };

  const domainId = domainIdField(record);
  if (!domainId.ok) return domainId;

  const chain = parseChainShape(record.chain);
  if (!chain.ok) return chain;

  const kaCert = parseKeyAgreementCertificateShape(record.kaCert);
  if (!kaCert.ok) return kaCert;

  return {
    ok: true,
    value: { domainId: domainId.value, chain: chain.value, kaCert: kaCert.value },
  };
}

export function parseServiceNodeHeartbeatRequest(
  body: unknown,
): ParseResult<ServiceNodeHeartbeatRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: 'request body must be an object' };

  const domainId = domainIdField(record);
  if (!domainId.ok) return domainId;

  const connectedRelay = stringField(record, 'connectedRelay');
  if (!connectedRelay.ok) return connectedRelay;

  return {
    ok: true,
    value: { domainId: domainId.value, connectedRelay: connectedRelay.value },
  };
}
