/**
 * Intent hashing for idempotency.
 *
 * An idempotency key alone cannot tell a retried request from a different
 * request that reused a key. The hash of the canonical intent can: the same key
 * with the same hash is a retry and returns the original; the same key with a
 * different hash is a conflict.
 */

import { createHash } from "node:crypto";

/** JSON with object keys sorted at every depth, so key order never changes the hash. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

export function hashIntent(intent: unknown): string {
  return createHash("sha256").update(canonicalJson(intent)).digest("hex");
}

export class IdempotencyConflictError extends Error {
  constructor(readonly key: string) {
    super(`idempotency key ${JSON.stringify(key)} was already used for a different request`);
    this.name = "IdempotencyConflictError";
  }
}

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === "string" && IDEMPOTENCY_KEY_RE.test(key);
}
