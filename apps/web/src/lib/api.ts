import type { LinkedHttpClient } from "@oxyhq/core";

type TnpApiClient = LinkedHttpClient["client"];

// The TNP backend client, registered by AuthBridge from the linked client that
// @oxyhq/core mints off the OxyServices session. It targets TNP's own API
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
