/**
 * `GET /dns/resolve` response — the contract between the registry and every
 * resolver (`packages/client`'s DNS proxy, which `apps/dns-server` also runs).
 *
 * Grown only by addition, with one deliberate exception: the transport v1
 * cutover replaced `overlay.serviceNodePubKey` with verifiable key material.
 * A v0 client cannot talk to a v1 relay anyway, so keeping the unverified key
 * would only have kept the substitution path open.
 */

import type { DomainKeyRotation, Grant, KeyAgreementCertificate } from '@tnp/crypto';
import {
  type DomainKeyReset,
  parseKeyResetShape,
  parseChainShape,
  parseKeyAgreementCertificateShape,
  parseKeyShape,
  parseRotationsShape,
} from './key-material.js';
import { asRecord, type ParseResult } from './parse.js';

export interface DnsResolveAnswer {
  name: string;
  type: string;
  value: string;
  ttl: number;
}

/**
 * How to reach a name's service node, and the key material a client verifies
 * BEFORE it trusts any of it. Attached only while a node is online with a
 * current key-agreement certificate and the name has a domain key.
 *
 * Replaces the bare `serviceNodePubKey`, which the client used as-is: the API
 * could substitute it and read every tunnel (audit S3). Now the client pins
 * `domainKey` per name, accepts a changed one only through `rotations` signed
 * by the pinned key, and verifies `kaCert` against `chain` rooted at it, for
 * the name IT derived from what it was asked to reach — never a name this
 * response supplies.
 */
export interface DnsResolveOverlay {
  relay: string;
  available: boolean;
  /** The name's domain key (Ed25519, base64): the chain root clients pin. */
  domainKey: string;
  /** Rotation statements for the domain key, oldest first. */
  rotations: DomainKeyRotation[];
  /** Grant chain, leaf first, rooted at `domainKey`. */
  chain: Grant[];
  /** The service node's current key-agreement certificate. */
  kaCert: KeyAgreementCertificate;
  /** Present when the domain key was reset after a release, without a signed rotation. */
  keyReset?: DomainKeyReset;
}

/**
 * Shape check of an overlay block from an untrusted registry. Proves nothing
 * cryptographically — the client verifies with `@tnp/crypto` afterwards.
 */
export function parseDnsResolveOverlay(value: unknown): ParseResult<DnsResolveOverlay> {
  const r = asRecord(value);
  if (!r) return { ok: false, error: 'overlay must be an object' };
  if (typeof r.relay !== 'string' || r.relay.length === 0 || r.relay.length > 512) {
    return { ok: false, error: 'overlay relay must be a URL' };
  }
  if (typeof r.available !== 'boolean') {
    return { ok: false, error: 'overlay available must be a boolean' };
  }
  const domainKey = parseKeyShape(r.domainKey, 'domainKey');
  if (!domainKey.ok) return domainKey;
  const rotations = parseRotationsShape(r.rotations);
  if (!rotations.ok) return rotations;
  const chain = parseChainShape(r.chain);
  if (!chain.ok) return chain;
  const kaCert = parseKeyAgreementCertificateShape(r.kaCert);
  if (!kaCert.ok) return kaCert;
  const keyReset = parseKeyResetShape(r.keyReset);
  if (!keyReset.ok) return keyReset;
  return {
    ok: true,
    value: {
      relay: r.relay,
      available: r.available,
      domainKey: domainKey.value,
      rotations: rotations.value,
      chain: chain.value,
      kaCert: kaCert.value,
      ...(keyReset.value ? { keyReset: keyReset.value } : {}),
    },
  };
}

/**
 * - `NOERROR` — the name exists. `answers` may still be empty: that is NODATA,
 *   "no records of this type", and must not be cached as a missing name.
 * - `NXDOMAIN` — TNP knows no such name.
 */
export type DnsResolveRcode = 'NOERROR' | 'NXDOMAIN';

export interface DnsResolveResponse {
  name: string;
  type: string;
  answers: DnsResolveAnswer[];
  overlay?: DnsResolveOverlay;
  /**
   * Always sent by the current API. Optional in the type because an API image
   * older than the field omits it, and a resolver must then fall back to
   * reading empty `answers` as NXDOMAIN, as it always has.
   */
  rcode?: DnsResolveRcode;
}
