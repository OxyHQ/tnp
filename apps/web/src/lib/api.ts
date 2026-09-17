import type { LinkedHttpClient } from "@oxy.so/core";
import { isHttpRequestError } from "@oxy.so/core";

type TnpApiClient = LinkedHttpClient["client"];

// The TNP backend client, registered by AuthBridge from the linked client that
// @oxy.so/core mints off the OxyServices session. It targets TNP's own API
// (VITE_API_URL) while keeping its bearer token in lockstep with the Oxy
// session and delegating 401 refresh back to that session. No manual
// Authorization plumbing — the SDK owns the token.
let client: TnpApiClient | null = null;

export function setApiClient(next: TnpApiClient | null) {
  client = next;
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  if (!client) {
    throw new Error("TNP API client is not ready");
  }

  const method = (options?.method ?? "GET").toUpperCase();
  const data =
    typeof options?.body === "string" ? JSON.parse(options.body) : options?.body;

  switch (method) {
    case "POST":
      return client.post<T>(path, data);
    case "PUT":
      return client.put<T>(path, data);
    case "PATCH":
      return client.patch<T>(path, data);
    case "DELETE":
      return client.delete<T>(path);
    default:
      return client.get<T>(path);
  }
}

/** HTTP status of a failed `apiFetch`, or undefined for a network or client error. */
export function errorStatus(err: unknown): number | undefined {
  return isHttpRequestError(err) ? err.status : undefined;
}

/**
 * The TNP API's JSON error body, when the failure carried one.
 *
 * Read from the raw response the SDK attaches, because TNP's `{ error, code,
 * field }` is not an envelope the SDK lifts `code` from.
 */
export function errorBody(err: unknown): { error?: string; code?: string; field?: string } {
  if (!isHttpRequestError(err)) return {};
  const data = err.response?.data;
  if (typeof data !== "object" || data === null) return {};
  const body = data as Record<string, unknown>;
  const text = (key: string) => (typeof body[key] === "string" ? (body[key] as string) : undefined);
  return { error: text("error"), code: text("code"), field: text("field") };
}

/** Something to show a person: the API's message, else the error's, else the fallback. */
export function errorMessage(err: unknown, fallback: string): string {
  const fromBody = errorBody(err).error;
  if (fromBody) return fromBody;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiRequestOptions {
  /** A value, not a pre-serialized string: the SDK serializes it. */
  body?: unknown;
  /** Aborts the request; a superseded search cancels its predecessor with it. */
  signal?: AbortSignal;
  /** Extra headers, e.g. `Idempotency-Key`. The SDK still owns Authorization. */
  headers?: Record<string, string>;
}

/**
 * `apiFetch` with the three things it cannot express: a cancellation signal,
 * custom headers, and a response that is never served from cache.
 *
 * The SDK client caches GETs by default and retries 5xx responses on its own.
 * Both are wrong for state that changes under the user (a status flag, an
 * operation being polled) and for writes whose retry the user should decide,
 * so this turns them off; a retry is always an explicit second call.
 */
export async function apiRequest<T>(
  method: ApiMethod,
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  if (!client) {
    throw new Error("TNP API client is not ready");
  }
  const config = {
    signal: options.signal,
    headers: options.headers,
    cache: false,
    retry: false,
  };
  switch (method) {
    case "POST":
      return client.post<T>(path, options.body, config);
    case "PUT":
      return client.put<T>(path, options.body, config);
    case "PATCH":
      return client.patch<T>(path, options.body, config);
    case "DELETE":
      return client.delete<T>(path, config);
    default:
      return client.get<T>(path, config);
  }
}
