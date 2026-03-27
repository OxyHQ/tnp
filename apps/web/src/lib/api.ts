const API_BASE = import.meta.env.VITE_API_URL || "";

let tnpToken: string | null = localStorage.getItem("tnp_token");
let tokenOxyUserId: string | null = null;

export function clearToken() {
  tnpToken = null;
  tokenOxyUserId = null;
  localStorage.removeItem("tnp_token");
}

/**
 * Ensures we have a valid TNP JWT for the given Oxy user.
 * Exchanges the oxyUserId with the TNP API if needed.
 */
async function ensureToken(oxyUserId: string): Promise<string> {
  if (tnpToken && tokenOxyUserId === oxyUserId) {
    return tnpToken;
  }

  const res = await fetch(`${API_BASE}/auth/oxy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ oxyUserId }),
  });

  if (!res.ok) {
    throw new Error("Failed to authenticate with TNP API");
  }

  const data = (await res.json()) as { token: string };
  tnpToken = data.token;
  tokenOxyUserId = oxyUserId;
  localStorage.setItem("tnp_token", data.token);
  return data.token;
}

/**
 * Make an authenticated API call. Pass oxyUserId to auto-exchange for a TNP JWT.
 */
export async function apiFetch<T>(
  path: string,
  options?: RequestInit & { oxyUserId?: string }
): Promise<T> {
  const { oxyUserId, ...fetchOptions } = options ?? {};

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (oxyUserId) {
    const token = await ensureToken(oxyUserId);
    headers.Authorization = `Bearer ${token}`;
  } else if (tnpToken) {
    headers.Authorization = `Bearer ${tnpToken}`;
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...fetchOptions,
    headers: {
      ...headers,
      ...(fetchOptions?.headers as Record<string, string>),
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
