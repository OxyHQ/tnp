import type {
  RegisterRelayRequest,
  RegisterServiceNodeRequest,
  RelayDirectoryEntry,
  RelayHeartbeatRequest,
  RelayRegistration,
  ServiceNodeHeartbeatRequest,
  ServiceNodeLookup,
} from "@tnp/shared-types";

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

/** How long a write is given before the client gives up on it. */
const WRITE_TIMEOUT_MS = 5000;
const REGISTER_TIMEOUT_MS = 10_000;

export class TnpApiClient {
  constructor(private baseUrl: string) {}

  /**
   * POST a request body defined by `@tnp/shared-types` to an authenticated
   * endpoint.
   *
   * Every caller below passes a body whose type is the API's own request
   * contract, so the shape sent is the shape the route parses. Before those
   * contracts existed each of these methods hand-built its own object literal,
   * and two of them built the wrong one.
   */
  private async postContract<TRequest, TResponse>(
    path: string,
    body: TRequest,
    authToken: string,
    timeoutMs: number,
  ): Promise<TResponse> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      const failure = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(failure.error ?? `TNP API returned ${res.status}`);
    }

    return (await res.json()) as TResponse;
  }

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

  async fetchTlds(): Promise<Array<{ name: string; custom: boolean }>> {
    const url = `${this.baseUrl}/dns/tlds`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!res.ok) {
      throw new Error(`TNP API returned ${res.status}`);
    }

    const data = await res.json() as Array<string | { name: string; custom?: boolean }>;
    // Handle both old format (string[]) and new format ({ name, custom }[])
    return data.map((t) =>
      typeof t === "string" ? { name: t, custom: true } : { name: t.name, custom: t.custom ?? true }
    );
  }

  /**
   * Get service node info for a domain (e.g., "example.ox").
   * Returns null if no service node is registered.
   */
  async getServiceNode(domain: string): Promise<ServiceNodeLookup | null> {
    const url = `${this.baseUrl}/nodes/${encodeURIComponent(domain)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (res.status === 404) return null;

    if (!res.ok) {
      throw new Error(`TNP API returned ${res.status}`);
    }

    return (await res.json()) as ServiceNodeLookup;
  }

  /**
   * Get list of active relays.
   */
  async getRelays(operator?: "oxy" | "community"): Promise<RelayDirectoryEntry[]> {
    let url = `${this.baseUrl}/relays`;
    if (operator) {
      url += `?operator=${encodeURIComponent(operator)}`;
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!res.ok) {
      throw new Error(`TNP API returned ${res.status}`);
    }

    return (await res.json()) as RelayDirectoryEntry[];
  }

  /**
   * Register a service node (auth required).
   */
  async registerServiceNode(
    domainId: string,
    publicKey: string,
    authToken: string,
  ): Promise<void> {
    const request: RegisterServiceNodeRequest = { domainId, publicKey };
    await this.postContract(
      "/nodes/register",
      request,
      authToken,
      WRITE_TIMEOUT_MS,
    );
  }

  /**
   * Send service node heartbeat (auth required).
   */
  async sendHeartbeat(
    domainId: string,
    connectedRelay: string,
    authToken: string,
  ): Promise<void> {
    const request: ServiceNodeHeartbeatRequest = { domainId, connectedRelay };
    await this.postContract(
      "/nodes/heartbeat",
      request,
      authToken,
      WRITE_TIMEOUT_MS,
    );
  }

  /**
   * Register this machine as a relay node (auth required).
   *
   * Takes the request contract itself rather than a handful of positional
   * arguments: the caller cannot omit the endpoint, the key, the operator or
   * the capacity, because those are the contract, and the registry parses the
   * same declaration.
   */
  async registerRelay(
    request: RegisterRelayRequest,
    authToken: string,
  ): Promise<RelayRegistration> {
    return this.postContract<RegisterRelayRequest, RelayRegistration>(
      "/relays/register",
      request,
      authToken,
      REGISTER_TIMEOUT_MS,
    );
  }

  /**
   * Send relay heartbeat (auth required).
   *
   * A relay is identified in the directory by its endpoint, so that is what
   * the heartbeat carries. It used to send a relay id it had never been given
   * along with traffic counters the registry does not accept.
   */
  async sendRelayHeartbeat(endpoint: string, authToken: string): Promise<void> {
    const request: RelayHeartbeatRequest = { endpoint };
    await this.postContract(
      "/relays/heartbeat",
      request,
      authToken,
      WRITE_TIMEOUT_MS,
    );
  }
}
