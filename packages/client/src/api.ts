import type { Grant, KeyAgreementCertificate, ServiceRelayBinding } from '@tnp/crypto';
import {
  type DnsResolveAnswer,
  type DnsResolveOverlay,
  type DnsResolveResponse,
  type DnsRulesRecord,
  type DomainKeyRecord,
  MAX_RELAY_DIRECTORY_RESPONSE_BYTES,
  parseDnsRulesRecord,
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
   * The raw `GET /relays/directory` body: a SIGNED document the caller must
   * verify (relay-directory.ts) before using anything in it. Bounded before
   * parsing. A 503 means the API has no signing key configured, and there is
   * then no directory — never an unsigned one.
   */
  async getRelayDirectory(): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/relays/directory`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 503) throw new Error('the API serves no signed relay directory (503)');
    if (!res.ok) throw new Error(`TNP API returned ${res.status}`);
    const bytes = await readCapped(res, MAX_RELAY_DIRECTORY_RESPONSE_BYTES);
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
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
  async sendHeartbeat(
    domainId: string,
    connectedRelay: string,
    relayBinding: ServiceRelayBinding | null,
    authToken: string,
  ): Promise<void> {
    const request: ServiceNodeHeartbeatRequest = {
      domainId,
      connectedRelay,
      ...(relayBinding ? { relayBinding } : {}),
    };
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
   * The caller's encrypted personal DNS rules (auth required), or null when
   * none are stored. The response is validated against the contract before
   * it is returned; decrypting it is `dns-rules-store.ts`'s job, and the
   * API never had the key.
   */
  async getDnsRules(authToken: string): Promise<DnsRulesRecord | null> {
    const res = await fetch(`${this.baseUrl}/me/dns-rules`, {
      headers: { Authorization: `Bearer ${authToken}` },
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const failure = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(failure.error ?? `TNP API returned ${res.status}`);
    }
    const parsed = parseDnsRulesRecord(await res.json());
    if (!parsed.ok) throw new Error(`the API returned a malformed rule set: ${parsed.error}`);
    return parsed.value;
  }

  /**
   * Send relay heartbeat (auth required).
   *
   * A relay is identified in the directory by its endpoint, so that is what
   * the heartbeat carries. It used to send a relay id it had never been given
   * along with traffic counters the registry does not accept. It now also
   * carries a fresh proof of the relay key, which keeps the relay in the
   * signed directory.
   */
  async sendRelayHeartbeat(request: RelayHeartbeatRequest, authToken: string): Promise<void> {
    await this.postContract('/relays/heartbeat', request, authToken, WRITE_TIMEOUT_MS);
  }
}

/**
 * A response body of at most `limit` BYTES, or an error — checked against
 * Content-Length before reading and counted while streaming, so an oversized
 * (or lying) response is never buffered whole.
 */
async function readCapped(res: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length') ?? Number.NaN);
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {});
    throw new Error('the relay directory response is too large');
  }
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error('the relay directory response is too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
