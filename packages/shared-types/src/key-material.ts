/**
 * Shape parsers for the signed key material that crosses the registry:
 * grants, key-agreement certificates and domain-key rotation statements.
 *
 * These check SHAPE only — that a value is the right kind of object with the
 * right kinds of fields, so a route can reject a malformed body with a 400 that
 * names the field. They prove nothing. Every consumer that relies on the
 * material verifies it cryptographically with `@tnp/crypto` — the API before
 * storing it (defence in depth), and the client before trusting it, because the
 * client must not trust the API (docs/architecture/security.md §1).
 */

import type { DomainKeyRotation, Grant, KeyAgreementCertificate } from '@tnp/crypto';
import { asRecord, type ParseResult } from './parse.js';

/** Longest grant chain a body may carry (`MAX_CHAIN_DEPTH` in `@tnp/crypto`). */
export const MAX_CHAIN_LENGTH = 4;

/** Rotation history served per name (`MAX_DOMAIN_KEY_ROTATIONS` in `@tnp/crypto`). */
export const MAX_ROTATIONS = 32;

/** Base64 of 32 bytes is 44 characters, of 64 bytes 88; anything longer is not a key or signature. */
const MAX_B64 = 88;

const NAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A canonical lowercase DNS name (the form grants and certificates scope to). */
export function isCanonicalName(value: unknown): value is string {
  return typeof value === 'string' && NAME_RE.test(value);
}

function fail<T>(error: string): ParseResult<T> {
  return { ok: false, error };
}

function onlyFields(record: Record<string, unknown>, allowed: readonly string[]): string | null {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) return key;
  return null;
}

function isB64(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_B64;
}

function isUint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseGrantShape(value: unknown, label: string): ParseResult<Grant> {
  const r = asRecord(value);
  if (!r) return fail(`${label} must be an object`);
  const extra = onlyFields(r, [
    'issuer',
    'subject',
    'purposes',
    'notBefore',
    'notAfter',
    'serial',
    'scope',
    'signature',
  ]);
  if (extra) return fail(`${label} has an unexpected field`);
  if (!isB64(r.issuer) || !isB64(r.subject) || !isB64(r.signature)) {
    return fail(`${label} keys and signature must be base64 strings`);
  }
  if (
    !Array.isArray(r.purposes) ||
    r.purposes.length === 0 ||
    r.purposes.length > 8 ||
    !r.purposes.every((p) => typeof p === 'string' && p.length <= 32)
  ) {
    return fail(`${label} purposes must be a non-empty array of strings`);
  }
  if (!isUint(r.notBefore) || !isUint(r.notAfter) || !isUint(r.serial)) {
    return fail(`${label} times and serial must be non-negative integers`);
  }
  if (r.scope !== undefined && !isCanonicalName(r.scope)) {
    return fail(`${label} scope must be a canonical name`);
  }
  return { ok: true, value: r as unknown as Grant };
}

export function parseChainShape(value: unknown, label = 'chain'): ParseResult<Grant[]> {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHAIN_LENGTH) {
    return fail(`${label} must be an array of 1 to ${MAX_CHAIN_LENGTH} grants`);
  }
  const chain: Grant[] = [];
  for (let i = 0; i < value.length; i++) {
    const grant = parseGrantShape(value[i], `${label}[${i}]`);
    if (!grant.ok) return grant;
    chain.push(grant.value);
  }
  return { ok: true, value: chain };
}

export function parseKeyAgreementCertificateShape(
  value: unknown,
  label = 'kaCert',
): ParseResult<KeyAgreementCertificate> {
  const r = asRecord(value);
  if (!r) return fail(`${label} must be an object`);
  const extra = onlyFields(r, [
    'signer',
    'key',
    'role',
    'scope',
    'notBefore',
    'notAfter',
    'serial',
    'signature',
  ]);
  if (extra) return fail(`${label} has an unexpected field`);
  if (!isB64(r.signer) || !isB64(r.key) || !isB64(r.signature)) {
    return fail(`${label} keys and signature must be base64 strings`);
  }
  if (r.role !== 'service-node' && r.role !== 'relay') return fail(`${label} role is unknown`);
  if (!isCanonicalName(r.scope)) return fail(`${label} scope must be a canonical name`);
  if (!isUint(r.notBefore) || !isUint(r.notAfter) || !isUint(r.serial)) {
    return fail(`${label} times and serial must be non-negative integers`);
  }
  return { ok: true, value: r as unknown as KeyAgreementCertificate };
}

export function parseRotationShape(
  value: unknown,
  label = 'rotation',
): ParseResult<DomainKeyRotation> {
  const r = asRecord(value);
  if (!r) return fail(`${label} must be an object`);
  const extra = onlyFields(r, ['name', 'previousKey', 'nextKey', 'issuedAt', 'signature']);
  if (extra) return fail(`${label} has an unexpected field`);
  if (!isCanonicalName(r.name)) return fail(`${label} name must be a canonical name`);
  if (!isB64(r.previousKey) || !isB64(r.nextKey) || !isB64(r.signature)) {
    return fail(`${label} keys and signature must be base64 strings`);
  }
  if (!isUint(r.issuedAt)) return fail(`${label} issuedAt must be a non-negative integer`);
  return { ok: true, value: r as unknown as DomainKeyRotation };
}

export function parseRotationsShape(value: unknown): ParseResult<DomainKeyRotation[]> {
  if (!Array.isArray(value) || value.length > MAX_ROTATIONS) {
    return fail(`rotations must be an array of at most ${MAX_ROTATIONS} statements`);
  }
  const out: DomainKeyRotation[] = [];
  for (let i = 0; i < value.length; i++) {
    const rotation = parseRotationShape(value[i], `rotations[${i}]`);
    if (!rotation.ok) return rotation;
    out.push(rotation.value);
  }
  return { ok: true, value: out };
}

/**
 * The registry accepted a domain key for this name WITHOUT a rotation signed
 * by the key it had before: the name was released (with a key) and later
 * registered again, after the reset hold. A client that pinned the previous
 * key keeps refusing; a client meeting the name for the first time can see
 * that its current key is not the original.
 */
export interface DomainKeyReset {
  /** `domainKeyFingerprint` (hex SHA-256) of the key in force before the reset. */
  previousKeyFingerprint: string;
  /** ISO 8601: when the new key was accepted. */
  since: string;
}

const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

export function parseKeyResetShape(value: unknown): ParseResult<DomainKeyReset | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  const r = asRecord(value);
  if (!r) return fail('keyReset must be an object');
  if (onlyFields(r, ['previousKeyFingerprint', 'since']))
    return fail('keyReset has an unexpected field');
  if (
    typeof r.previousKeyFingerprint !== 'string' ||
    !FINGERPRINT_RE.test(r.previousKeyFingerprint)
  ) {
    return fail('keyReset previousKeyFingerprint must be a hex SHA-256');
  }
  if (typeof r.since !== 'string' || Number.isNaN(Date.parse(r.since)) || r.since.length > 40) {
    return fail('keyReset since must be an ISO 8601 time');
  }
  return { ok: true, value: { previousKeyFingerprint: r.previousKeyFingerprint, since: r.since } };
}

export function parseKeyShape(value: unknown, field: string): ParseResult<string> {
  if (!isB64(value)) return fail(`${field} must be a base64 key`);
  return { ok: true, value };
}
