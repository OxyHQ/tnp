/**
 * Wire contracts for `/domain-keys` — the registry's copy of each native
 * name's DOMAIN KEY, the root of trust for its service nodes
 * (docs/architecture/security.md §1, "Domain keys and pinning").
 *
 * The registry publishes the key; it is not the authority for it. A client
 * pins the first key it sees for a name and afterwards accepts a different
 * one only through rotation statements signed by the pinned key, so a
 * registry that swaps the key is refused by every client that has used the
 * name before.
 */

import type { DomainKeyRotation } from '@tnp/crypto';
import {
  type DomainKeyReset,
  isCanonicalName,
  parseKeyResetShape,
  parseKeyShape,
  parseRotationShape,
  parseRotationsShape,
} from './key-material.js';
import { asRecord, type ParseResult } from './parse.js';

/** `GET /domain-keys/:name` response — public. Rotations oldest first. */
export interface DomainKeyRecord {
  name: string;
  domainKey: string;
  rotations: DomainKeyRotation[];
  /** Present when the current key was accepted without a signed rotation (a reset after release). */
  keyReset?: DomainKeyReset;
}

/**
 * `POST /domain-keys` request — owner only.
 *
 * The first registration for a name carries `domainKey` alone. Every later one
 * must carry `rotation`, a statement signed by the CURRENT key retiring it in
 * favour of `domainKey`; without one the registry refuses, so even the owner's
 * Oxy account cannot replace the key on its own.
 */
export interface RegisterDomainKeyRequest {
  name: string;
  domainKey: string;
  rotation?: DomainKeyRotation;
}

export function parseRegisterDomainKeyRequest(
  body: unknown,
): ParseResult<RegisterDomainKeyRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: 'request body must be an object' };
  for (const key of Object.keys(record)) {
    if (key !== 'name' && key !== 'domainKey' && key !== 'rotation') {
      return { ok: false, error: `unexpected field ${key.slice(0, 32)}` };
    }
  }
  if (!isCanonicalName(record.name)) return { ok: false, error: 'name must be a canonical name' };
  const domainKey = parseKeyShape(record.domainKey, 'domainKey');
  if (!domainKey.ok) return domainKey;
  if (record.rotation === undefined) {
    return { ok: true, value: { name: record.name, domainKey: domainKey.value } };
  }
  const rotation = parseRotationShape(record.rotation);
  if (!rotation.ok) return rotation;
  return {
    ok: true,
    value: { name: record.name, domainKey: domainKey.value, rotation: rotation.value },
  };
}

/** Parse a `GET /domain-keys/:name` response (a relay or client reading it). */
export function parseDomainKeyRecord(body: unknown): ParseResult<DomainKeyRecord> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: 'response must be an object' };
  if (!isCanonicalName(record.name)) return { ok: false, error: 'name must be a canonical name' };
  const domainKey = parseKeyShape(record.domainKey, 'domainKey');
  if (!domainKey.ok) return domainKey;
  const rotations = parseRotationsShape(record.rotations);
  if (!rotations.ok) return rotations;
  const keyReset = parseKeyResetShape(record.keyReset);
  if (!keyReset.ok) return keyReset;
  return {
    ok: true,
    value: {
      name: record.name,
      domainKey: domainKey.value,
      rotations: rotations.value,
      ...(keyReset.value ? { keyReset: keyReset.value } : {}),
    },
  };
}
