/**
 * Request-body parsing primitives shared by every contract in this package.
 *
 * A contract is not a type alone: `req.body` arrives as `unknown` over the
 * wire, so the type only binds the two sides if the server derives its
 * accepted shape from the same declaration the client builds. Every parser
 * here returns the contract type on success, which is what lets an API route
 * destructure the request without hand-written field checks — and therefore
 * what makes a field the server reads but the client never sends impossible to
 * write.
 */

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/**
 * Narrow an untrusted body to a plain object.
 *
 * Arrays are rejected: `body[field]` on an array is well-defined and would let
 * `["a"]` satisfy a contract by accident.
 */
export function asRecord(body: unknown): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  return body as Record<string, unknown>;
}

/** A required, non-empty string field, trimmed. */
export function stringField(
  record: Record<string, unknown>,
  field: string,
): ParseResult<string> {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: `${field} is required` };
  }
  return { ok: true, value: value.trim() };
}

/**
 * A required integer field within an inclusive range.
 *
 * `Number.isInteger` rather than `typeof value === "number"`: the latter
 * accepts `NaN` and `Infinity`, which reach a Postgres `integer` column as a
 * failed insert — a 500 for what is a malformed request.
 */
export function integerField(
  record: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): ParseResult<number> {
  const value = record[field];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return { ok: false, error: `${field} must be an integer between ${min} and ${max}` };
  }
  return { ok: true, value };
}

/** A string field that may be absent or empty, trimmed, defaulting to `""`. */
export function optionalStringField(
  record: Record<string, unknown>,
  field: string,
): ParseResult<string> {
  const value = record[field];
  if (value === undefined || value === null) {
    return { ok: true, value: "" };
  }
  if (typeof value !== "string") {
    return { ok: false, error: `${field} must be a string` };
  }
  return { ok: true, value: value.trim() };
}
