export interface DnsAnswer {
  name: string;
  type: string;
  value: string;
  ttl: number;
}

export interface OverlayInfo {
  serviceNodePubKey: string;
  relay: string;
  available: boolean;
}

export interface ResolveResponse {
  name: string;
  type: string;
  answers: DnsAnswer[];
  overlay?: OverlayInfo;
}

export interface ServiceNodeInfo {
  publicKey: string;
  connectedRelay: string;
  status: string;
}

export interface RelayInfo {
  endpoint: string;
  publicKey: string;
  operator: string;
  location?: string;
  status?: string;
}

export class TnpApiClient {
  constructor(private baseUrl: string) {}

  async resolve(name: string, type: string): Promise<DnsAnswer[]> {
    const url = `${this.baseUrl}/dns/resolve?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!res.ok) {
      throw new Error(`TNP API returned ${res.status}`);
    }

    const data = (await res.json()) as ResolveResponse;
    return data.answers;
  }

  /**
   * Resolve a TNP domain with full overlay info.
   */
  async resolveWithOverlay(name: string, type: string): Promise<ResolveResponse> {
    const url = `${this.baseUrl}/dns/resolve?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!res.ok) {
      throw new Error(`TNP API returned ${res.status}`);
    }

    return (await res.json()) as ResolveResponse;
  }

  async fetchTlds(): Promise<string[]> {
    const url = `${this.baseUrl}/dns/tlds`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!res.ok) {
      throw new Error(`TNP API returned ${res.status}`);
    }

    return (await res.json()) as string[];
  }

  /**
   * Get service node info for a domain (e.g., "example.ox").
   * Returns null if no service node is registered.
   */
  async getServiceNode(domain: string): Promise<ServiceNodeInfo | null> {
    const url = `${this.baseUrl}/nodes/${encodeURIComponent(domain)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (res.status === 404) return null;

    if (!res.ok) {
      throw new Error(`TNP API returned ${res.status}`);
    }

    return (await res.json()) as ServiceNodeInfo;
  }

  /**
   * Get list of active relays.
   */
  async getRelays(operator?: "oxy" | "community"): Promise<RelayInfo[]> {
    let url = `${this.baseUrl}/relays`;
    if (operator) {
      url += `?operator=${encodeURIComponent(operator)}`;
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!res.ok) {
      throw new Error(`TNP API returned ${res.status}`);
    }

    return (await res.json()) as RelayInfo[];
  }

  /**
   * Register a service node (auth required).
   */
  async registerServiceNode(
    domainId: string,
    publicKey: string,
    authToken: string,
  ): Promise<void> {
    const url = `${this.baseUrl}/nodes/register`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ domainId, publicKey }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `TNP API returned ${res.status}`);
    }
  }

  /**
   * Send service node heartbeat (auth required).
   */
  async sendHeartbeat(
    domainId: string,
    connectedRelay: string,
    authToken: string,
  ): Promise<void> {
    const url = `${this.baseUrl}/nodes/heartbeat`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ domainId, connectedRelay }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `TNP API returned ${res.status}`);
    }
  }

  /**
   * Register this machine as a relay node (auth required).
   */
  async registerRelay(
    port: number,
    location: string,
    authToken: string,
  ): Promise<{ relayId: string }> {
    const url = `${this.baseUrl}/relays/register`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ port, location }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `TNP API returned ${res.status}`);
    }

    return (await res.json()) as { relayId: string };
  }

  /**
   * Send relay heartbeat (auth required).
   */
  async sendRelayHeartbeat(
    relayId: string,
    stats: { serviceNodes: number; activeCircuits: number },
    authToken: string,
  ): Promise<void> {
    const url = `${this.baseUrl}/relays/heartbeat`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ relayId, ...stats }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `TNP API returned ${res.status}`);
    }
  }
}
