import type { Grant, KeyAgreementCertificate } from '@tnp/crypto';
import {
  type DnsResolveAnswer,
  type DnsResolveOverlay,
  type DnsResolveResponse,
  type DomainKeyRecord,
  parseDomainKeyRecord,
  type RegisterDomainKeyRequest,
  type RegisterRelayRequest,
  type RegisterServiceNodeRequest,
  type RelayDirectoryEntry,
  type RelayHeartbeatRequest,
  type RelayRegistration,
  type ServiceNodeHeartbeatRequest,
  type ServiceNodeLookup,
} from '@tnp/shared-types';

// The `/dns/resolve` response is declared once, in @tnp/shared-types, next to
// the other registry contracts. `rcode` is optional there because an older API
// image omits it. The resolver honours it (NOERROR + no answers = NODATA) and
// falls back to reading empty `answers` as NXDOMAIN only when it is absent.
export type DnsAnswer = DnsResolveAnswer;
export type OverlayInfo = DnsResolveOverlay;
export type ResolveResponse = DnsResolveResponse;

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
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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

    const data = (await res.json()) as Array<string | { name: string; custom?: boolean }>;
    // Handle both old format (string[]) and new format ({ name, custom }[])
    return data.map((t) =>
      typeof t === 'string'
        ? { name: t, custom: true }
        : { name: t.name, custom: t.custom ?? true },
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
  async getRelays(operator?: 'oxy' | 'community'): Promise<RelayDirectoryEntry[]> {
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
   * Publish a service node's grant chain and key-agreement certificate (auth
   * required). The registry verifies them against the domain key before
   * storing; clients verify them again and do not rely on that.
   */
  async registerServiceNode(
    domainId: string,
    chain: Grant[],
    kaCert: KeyAgreementCertificate,
    authToken: string,
  ): Promise<void> {
    const request: RegisterServiceNodeRequest = { domainId, chain, kaCert };
    await this.postContract('/nodes/register', request, authToken, WRITE_TIMEOUT_MS);
  }

  /** The domain key the registry publishes for `name`, or null when it has none. */
  async getDomainKey(name: string): Promise<DomainKeyRecord | null> {
    const res = await fetch(`${this.baseUrl}/domain-keys/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`TNP API returned ${res.status}`);
    const parsed = parseDomainKeyRecord(await res.json());
    if (!parsed.ok || parsed.value.name !== name) {
      throw new Error('the registry returned a malformed domain key record');
    }
    return parsed.value;
  }

  /** Register the first domain key for a name, or a rotation signed by the current one (owner only). */
  async registerDomainKey(
    request: RegisterDomainKeyRequest,
    authToken: string,
  ): Promise<DomainKeyRecord> {
    return this.postContract<RegisterDomainKeyRequest, DomainKeyRecord>(
      '/domain-keys',
      request,
      authToken,
      WRITE_TIMEOUT_MS,
    );
  }

  /** The registry id of a name the caller owns (`/nodes` endpoints are keyed by it). */
  async lookupOwnedDomainId(name: string, authToken: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/domains/lookup/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) throw new Error(`could not look up ${name}: TNP API returned ${res.status}`);
    const body = (await res.json()) as { _id?: unknown };
    if (typeof body._id !== 'string')
      throw new Error(`could not look up ${name}: malformed response`);
    return body._id;
  }

  /**
   * Send service node heartbeat (auth required).
   */
  async sendHeartbeat(domainId: string, connectedRelay: string, authToken: string): Promise<void> {
    const request: ServiceNodeHeartbeatRequest = { domainId, connectedRelay };
    await this.postContract('/nodes/heartbeat', request, authToken, WRITE_TIMEOUT_MS);
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
      '/relays/register',
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
    await this.postContract('/relays/heartbeat', request, authToken, WRITE_TIMEOUT_MS);
  }
}
