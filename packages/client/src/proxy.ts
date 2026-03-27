import { TnpApiClient, type DnsAnswer } from "./api";
import type { TnpConfig } from "./config";
import dns2 from "dns2";

const { Packet } = dns2;

interface CacheEntry {
  answers: DnsAnswer[];
  expiresAt: number;
}

export class DnsProxy {
  private apiClient: TnpApiClient;
  private tlds = new Set<string>();
  private cache = new Map<string, CacheEntry>();
  private cacheTtlMs: number;
  private server: ReturnType<typeof dns2.createServer> | null = null;
  private config: TnpConfig;

  constructor(config: TnpConfig) {
    this.config = config;
    this.apiClient = new TnpApiClient(config.apiBaseUrl);
    this.cacheTtlMs = config.cacheTtlSeconds * 1000;
  }

  setTlds(tlds: string[]) {
    this.tlds = new Set(tlds.map((t) => t.toLowerCase()));
    console.log(`[tnp] loaded ${this.tlds.size} TLDs: ${tlds.join(", ")}`);
  }

  private isTnpDomain(name: string): boolean {
    const clean = name.replace(/\.$/, "").toLowerCase();
    const parts = clean.split(".");
    if (parts.length < 2) return false;
    return this.tlds.has(parts[parts.length - 1]);
  }

  private typeToString(type: number): string {
    const map: Record<number, string> = {
      [Packet.TYPE.A]: "A",
      [Packet.TYPE.AAAA]: "AAAA",
      [Packet.TYPE.CNAME]: "CNAME",
      [Packet.TYPE.TXT]: "TXT",
      [Packet.TYPE.MX]: "MX",
      [Packet.TYPE.NS]: "NS",
    };
    return map[type] || "A";
  }

  private answerToPacket(qname: string, ans: DnsAnswer): Record<string, unknown> {
    const base = {
      name: qname,
      ttl: ans.ttl || 3600,
      class: Packet.CLASS.IN,
    };

    switch (ans.type.toUpperCase()) {
      case "A":
        return { ...base, type: Packet.TYPE.A, address: ans.value };
      case "AAAA":
        return { ...base, type: Packet.TYPE.AAAA, address: ans.value };
      case "CNAME":
        return { ...base, type: Packet.TYPE.CNAME, domain: ans.value };
      case "TXT":
        return { ...base, type: Packet.TYPE.TXT, data: ans.value };
      case "MX":
        return { ...base, type: Packet.TYPE.MX, exchange: ans.value, priority: 10 };
      case "NS":
        return { ...base, type: Packet.TYPE.NS, ns: ans.value };
      default:
        return { ...base, type: Packet.TYPE.A, address: ans.value };
    }
  }

  private async resolveTnp(name: string, type: string): Promise<DnsAnswer[]> {
    const clean = name.replace(/\.$/, "").toLowerCase();
    const cacheKey = `${clean}:${type}`;

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.answers;
    }

    const answers = await this.apiClient.resolve(clean, type);

    this.cache.set(cacheKey, {
      answers,
      expiresAt: Date.now() + this.cacheTtlMs,
    });

    return answers;
  }

  private async forwardUpstream(
    name: string,
    type: number
  ): Promise<Record<string, unknown>> {
    const client = new dns2.UDPClient({ dns: this.config.upstreamDns });
    try {
      const typeStr = this.typeToString(type);
      return await client.resolve(name, typeStr);
    } finally {
      client.close();
    }
  }

  async start(): Promise<void> {
    this.server = dns2.createServer({
      udp: true,
      tcp: true,
      handle: async (request: Record<string, unknown>, send: (response: unknown) => void) => {
        const questions = (request as { questions: Array<{ name: string; type: number }> }).questions;

        if (!questions || questions.length === 0) {
          send(Packet.createResponseFromRequest(request));
          return;
        }

        const { name, type } = questions[0];

        if (this.isTnpDomain(name)) {
          const response = Packet.createResponseFromRequest(request);
          const typeStr = this.typeToString(type);
          try {
            const answers = await this.resolveTnp(name, typeStr);
            for (const ans of answers) {
              (response as { answers: unknown[] }).answers.push(
                this.answerToPacket(name, ans)
              );
            }
          } catch (err) {
            console.error(`[tnp] resolve error for ${name}: ${err}`);
          }
          send(response);
        } else {
          try {
            const upstream = await this.forwardUpstream(name, type);
            // Build a proper response with the original request header
            const response = Packet.createResponseFromRequest(request);
            const upAny = upstream as Record<string, unknown[]>;
            const resAny = response as Record<string, unknown[]>;
            if (upAny.answers) resAny.answers = upAny.answers;
            if (upAny.authorities) resAny.authorities = upAny.authorities;
            if (upAny.additionals) resAny.additionals = upAny.additionals;
            send(response);
          } catch (err) {
            console.error(`[tnp] upstream error for ${name}: ${err}`);
            send(Packet.createResponseFromRequest(request));
          }
        }
      },
    });

    this.server.on("listening", () => {
      console.log(`[tnp] DNS proxy listening on ${this.config.listenAddr}:${this.config.listenPort}`);
    });

    this.server.listen({
      udp: {
        port: this.config.listenPort,
        address: this.config.listenAddr,
      },
      tcp: {
        port: this.config.listenPort,
        address: this.config.listenAddr,
      },
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
    }
  }

  async syncTlds() {
    try {
      const tlds = await this.apiClient.fetchTlds();
      this.setTlds(tlds);
    } catch (err) {
      console.error(`[tnp] failed to sync TLDs: ${err}`);
    }
  }

  startTldSync(intervalMs: number = 5 * 60 * 1000) {
    this.syncTlds();
    setInterval(() => this.syncTlds(), intervalMs);
  }
}
