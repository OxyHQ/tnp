const API_BASE = import.meta.env.VITE_API_URL || "";

function getToken(): string | null {
  return localStorage.getItem("tnp_token");
}

export function setToken(token: string) {
  localStorage.setItem("tnp_token", token);
}

export function clearToken() {
  localStorage.removeItem("tnp_token");
}

export function getStoredToken(): string | null {
  return getToken();
}

export async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...headers, ...(options?.headers as Record<string, string>) },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as Record<string, string>).error || `API error ${res.status}`
    );
  }

  return res.json() as Promise<T>;
}
