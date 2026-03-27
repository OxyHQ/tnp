import { TnpApiClient, type DnsAnswer } from "./api";
import type { TnpConfig } from "./config";
import dns2 from "dns2";
import dgram from "dgram";

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

  /**
   * Forward a raw DNS query to the upstream resolver via UDP and return the raw response buffer.
   * This preserves the full DNS wire format including all sections.
   */
  private forwardUpstreamRaw(queryBuf: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      const [host, portStr] = this.config.upstreamDns.split(":");
      const port = parseInt(portStr || "53", 10);

      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("upstream DNS timeout"));
      }, 4000);

      socket.on("message", (msg) => {
        clearTimeout(timeout);
        socket.close();
        resolve(msg);
      });

      socket.on("error", (err) => {
        clearTimeout(timeout);
        socket.close();
        reject(err);
      });

      socket.send(queryBuf, port, host);
    });
  }

  async start(): Promise<void> {
    this.server = dns2.createServer({
      udp: true,
      tcp: true,
      handle: async (request: Record<string, unknown>, send: (response: unknown) => void) => {
        const questions = (request as { questions: Array<{ name: string; type: number }> }).questions;

        if (!questions || questions.length === 0) {
          const response = Packet.createResponseFromRequest(request);
          send(response);
          return;
        }

        const { name, type } = questions[0];

        if (this.isTnpDomain(name)) {
          // Resolve TNP domain via API
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
          // Forward to upstream DNS -- encode query, send via UDP, decode response
          try {
            const queryBuf = Packet.encode({
              header: (request as Record<string, unknown>).header,
              questions,
            });
            const responseBuf = await this.forwardUpstreamRaw(queryBuf);
            const decoded = Packet.decode(responseBuf);

            // Build response preserving the original request ID
            const response = Packet.createResponseFromRequest(request);
            (response as Record<string, unknown[]>).answers = (decoded as Record<string, unknown[]>).answers || [];
            (response as Record<string, unknown[]>).authorities = (decoded as Record<string, unknown[]>).authorities || [];
            (response as Record<string, unknown[]>).additionals = (decoded as Record<string, unknown[]>).additionals || [];
            send(response);
          } catch (err) {
            console.error(`[tnp] upstream error for ${name}: ${err}`);
            const response = Packet.createResponseFromRequest(request);
            send(response);
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
