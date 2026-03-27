export interface DnsAnswer {
  name: string;
  type: string;
  value: string;
  ttl: number;
}

interface ResolveResponse {
  name: string;
  type: string;
  answers: DnsAnswer[];
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

  async fetchTlds(): Promise<string[]> {
    const url = `${this.baseUrl}/dns/tlds`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });

    if (!res.ok) {
      throw new Error(`TNP API returned ${res.status}`);
    }

    return (await res.json()) as string[];
  }
}
