import { oxyServices } from "./oxyServices";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

// Clear stale token from previous auth implementation
localStorage.removeItem("tnp_token");

export async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const token = oxyServices.getClient().getAccessToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...headers,
      ...(options?.headers as Record<string, string>),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as Record<string, string>).error || `API error ${res.status}`
    );
  }

  return res.json() as Promise<T>;
}
