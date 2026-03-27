import { TnpApiClient, type DnsAnswer } from "./api";
import type { TnpConfig } from "./config";
import dgram from "dgram";
import net from "net";
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
  private udpServer: dgram.Socket | null = null;
  private tcpServer: net.Server | null = null;
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

  private answerToRecord(qname: string, ans: DnsAnswer): Record<string, unknown> {
    const base = { name: qname, ttl: ans.ttl || 3600, class: Packet.CLASS.IN };
    switch (ans.type.toUpperCase()) {
      case "A":     return { ...base, type: Packet.TYPE.A, address: ans.value };
      case "AAAA":  return { ...base, type: Packet.TYPE.AAAA, address: ans.value };
      case "CNAME": return { ...base, type: Packet.TYPE.CNAME, domain: ans.value };
      case "TXT":   return { ...base, type: Packet.TYPE.TXT, data: ans.value };
      case "MX":    return { ...base, type: Packet.TYPE.MX, exchange: ans.value, priority: 10 };
      case "NS":    return { ...base, type: Packet.TYPE.NS, ns: ans.value };
      default:      return { ...base, type: Packet.TYPE.A, address: ans.value };
    }
  }

  private async resolveTnp(name: string, type: string): Promise<DnsAnswer[]> {
    const clean = name.replace(/\.$/, "").toLowerCase();
    const cacheKey = `${clean}:${type}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.answers;
    const answers = await this.apiClient.resolve(clean, type);
    this.cache.set(cacheKey, { answers, expiresAt: Date.now() + this.cacheTtlMs });
    return answers;
  }

  private forwardUpstreamRaw(queryBuf: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      const [host, portStr] = this.config.upstreamDns.split(":");
      const port = parseInt(portStr || "53", 10);

      const timeout = setTimeout(() => { socket.close(); reject(new Error("timeout")); }, 4000);
      socket.on("message", (msg: Buffer) => { clearTimeout(timeout); socket.close(); resolve(msg); });
      socket.on("error", (err: Error) => { clearTimeout(timeout); socket.close(); reject(err); });
      socket.send(queryBuf, port, host);
    });
  }

  private async handleQuery(queryBuf: Buffer): Promise<Buffer> {
    const request = Packet.parse(queryBuf);
    const questions = request.questions || [];

    if (questions.length === 0) return queryBuf;

    const { name, type } = questions[0];

    if (this.isTnpDomain(name)) {
      const typeStr = this.typeToString(type);
      try {
        const answers = await this.resolveTnp(name, typeStr);
        const response = Packet.createResponseFromRequest(request);
        for (const ans of answers) {
          response.answers.push(this.answerToRecord(name, ans));
        }
        return this.writeResponse(response);
      } catch (err) {
        console.error(`[tnp] resolve error for ${name}: ${err}`);
        return this.writeEmptyResponse(request);
      }
    }

    // Forward to upstream as raw bytes
    try {
      return await this.forwardUpstreamRaw(queryBuf);
    } catch (err) {
      console.error(`[tnp] upstream error for ${name}: ${err}`);
      return this.writeEmptyResponse(request);
    }
  }

  private writeEmptyResponse(request: Record<string, unknown>): Buffer {
    // Build a minimal NXDOMAIN/empty response
    const id = (request as { header: { id: number } }).header.id;
    const writer = new Packet.Writer();
    writer.write(id, 16);
    writer.write(0x8180, 16); // Response, RD, RA
    writer.write(1, 16); // QDCOUNT
    writer.write(0, 16); // ANCOUNT
    writer.write(0, 16); // NSCOUNT
    writer.write(0, 16); // ARCOUNT
    // Copy question section from original query
    const q = (request as { questions: Array<{ name: string; type: number; class: number }> }).questions[0];
    const cleanName = q.name.replace(/\.$/, "");
    for (const label of cleanName.split(".")) {
      writer.write(label.length, 8);
      for (const c of label) writer.write(c.charCodeAt(0), 8);
    }
    writer.write(0, 8);
    writer.write(q.type, 16);
    writer.write(q.class || 1, 16);
    return Buffer.from(writer.toBuffer());
  }

  private writeResponse(response: Record<string, unknown>): Buffer {
    // Use dns2 internal write if available, otherwise fall back to raw
    try {
      const writerFn = (Packet as Record<string, unknown>).write as ((r: unknown) => Buffer) | undefined;
      if (writerFn) return writerFn(response);
    } catch {}

    // Manual serialization of a simple A response
    const resp = response as {
      header: { id: number };
      questions: Array<{ name: string; type: number; class: number }>;
      answers: Array<{ name: string; type: number; class: number; ttl: number; address?: string }>;
    };
    const writer = new Packet.Writer();
    writer.write(resp.header.id, 16);
    writer.write(0x8180, 16);
    writer.write(resp.questions.length, 16);
    writer.write(resp.answers.length, 16);
    writer.write(0, 16);
    writer.write(0, 16);

    // Question
    for (const q of resp.questions) {
      const cleanName = q.name.replace(/\.$/, "");
      for (const label of cleanName.split(".")) {
        writer.write(label.length, 8);
        for (const c of label) writer.write(c.charCodeAt(0), 8);
      }
      writer.write(0, 8);
      writer.write(q.type, 16);
      writer.write(q.class || 1, 16);
    }

    // Answers
    for (const a of resp.answers) {
      const cleanName = a.name.replace(/\.$/, "");
      for (const label of cleanName.split(".")) {
        writer.write(label.length, 8);
        for (const c of label) writer.write(c.charCodeAt(0), 8);
      }
      writer.write(0, 8);
      writer.write(a.type, 16);
      writer.write(a.class || 1, 16);
      writer.write(a.ttl, 32);
      if (a.type === Packet.TYPE.A && a.address) {
        writer.write(4, 16); // RDLENGTH
        for (const octet of a.address.split(".")) {
          writer.write(parseInt(octet, 10), 8);
        }
      } else {
        writer.write(0, 16); // RDLENGTH 0
      }
    }

    return Buffer.from(writer.toBuffer());
  }

  async start(): Promise<void> {
    const { listenAddr, listenPort } = this.config;

    // UDP server
    this.udpServer = dgram.createSocket("udp4");
    this.udpServer.on("message", async (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      try {
        const response = await this.handleQuery(msg);
        this.udpServer!.send(response, rinfo.port, rinfo.address);
      } catch (err) {
        console.error(`[tnp] udp error: ${err}`);
      }
    });
    this.udpServer.bind(listenPort, listenAddr);

    // TCP server (for DNS-over-TLS via stunnel)
    this.tcpServer = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("data", async (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        // TCP DNS uses 2-byte length prefix
        while (buffer.length >= 2) {
          const msgLen = buffer.readUInt16BE(0);
          if (buffer.length < 2 + msgLen) break;
          const queryBuf = buffer.subarray(2, 2 + msgLen);
          buffer = buffer.subarray(2 + msgLen);
          try {
            const response = await this.handleQuery(Buffer.from(queryBuf));
            const lenBuf = Buffer.alloc(2);
            lenBuf.writeUInt16BE(response.length, 0);
            socket.write(Buffer.concat([lenBuf, response]));
          } catch (err) {
            console.error(`[tnp] tcp error: ${err}`);
          }
        }
      });
    });
    this.tcpServer.listen(listenPort, listenAddr);

    console.log(`[tnp] DNS proxy listening on ${listenAddr}:${listenPort} (UDP+TCP)`);
  }

  stop() {
    this.udpServer?.close();
    this.tcpServer?.close();
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
