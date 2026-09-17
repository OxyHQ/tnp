/**
 * The linked SDK client rejects with `{ message, code, status }`, where `code`
 * is the `error` field of the API's `{ error, message }` body and `message`
 * its safe, user-facing `message`. These read that shape without trusting it.
 */

function field(err: unknown, key: string): unknown {
  return err !== null && typeof err === "object" ? (err as Record<string, unknown>)[key] : undefined;
}

/** HTTP status, or null for a network failure, timeout or non-HTTP error. */
export function errorStatus(err: unknown): number | null {
  const status = field(err, "status");
  return typeof status === "number" && status >= 100 ? status : null;
}

export function errorCode(err: unknown): string | null {
  const code = field(err, "code");
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** The server's safe message, when there is an HTTP response to have one. */
export function errorMessage(err: unknown): string | null {
  if (errorStatus(err) === null) return null;
  const message = field(err, "message");
  return typeof message === "string" && message.trim().length > 0 ? message : null;
}

/** A superseded request: never shown to the user. */
export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return field(err, "name") === "AbortError";
}
