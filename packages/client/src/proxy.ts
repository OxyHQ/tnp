import { TnpApiClient, type DnsAnswer, type ResolveResponse } from "./api";
import type { TnpConfig } from "./config";
import dgram from "dgram";
import net from "net";
import dns2 from "dns2";

const { Packet } = dns2;

function encodeDnsName(name: string): number[] {
  const bytes: number[] = [];
  for (const label of name.split(".")) {
    bytes.push(label.length);
    for (const c of label) bytes.push(c.charCodeAt(0));
  }
  bytes.push(0);
  return bytes;
}

function expandIPv6(addr: string): number[] {
  // Expand :: and parse into 8 x 16-bit words
  let parts = addr.split(":");
  const emptyIdx = parts.indexOf("");
  if (emptyIdx !== -1) {
    const before = parts.slice(0, emptyIdx);
    const after = parts.slice(emptyIdx + 1).filter((p) => p !== "");
    const missing = 8 - before.length - after.length;
    parts = [...before, ...Array(missing).fill("0"), ...after];
  }
  return parts.map((p) => parseInt(p || "0", 16));
}

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

  /**
   * Overlay info cache. When a domain has an active service node, the DNS proxy
   * returns 127.0.0.1 so traffic goes through the local SOCKS5 proxy.
   * The SOCKS5 proxy reads from this cache to find the relay + pubkey.
   */
  private overlayCache = new Map<string, { pubKey: string; relay: string }>();

  /** Whether overlay routing is enabled (set when SOCKS5 proxy is running) */
  private overlayEnabled = false;

  /** Handle for the periodic TLD sync interval, so it can be cleared on stop. */
  private tldSyncInterval: ReturnType<typeof setInterval> | null = null;

  constructor(config: TnpConfig) {
    this.config = config;
    this.apiClient = new TnpApiClient(config.apiBaseUrl);
    this.cacheTtlMs = config.cacheTtlSeconds * 1000;
  }

  /** Enable overlay routing (DNS returns 127.0.0.1 for overlay domains). */
  enableOverlay(): void {
    this.overlayEnabled = true;
  }

  /** Disable overlay routing. */
  disableOverlay(): void {
    this.overlayEnabled = false;
  }

  /**
   * Get overlay info for a domain. Used by the SOCKS5 proxy.
   */
  getOverlayInfo(domain: string): { pubKey: string; relay: string } | undefined {
    const clean = domain.replace(/\.$/, "").toLowerCase();
    return this.overlayCache.get(clean);
  }

  /** Expose the API client for shared use by other components. */
  getApiClient(): TnpApiClient {
    return this.apiClient;
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

    // Fetch full resolve response with overlay info
    const response = await this.apiClient.resolveWithOverlay(clean, type);

    // If overlay is enabled and the domain has an active service node,
    // cache the overlay info and return 127.0.0.1 to route through SOCKS5
    if (this.overlayEnabled && response.overlay?.available) {
      this.overlayCache.set(clean, {
        pubKey: response.overlay.serviceNodePubKey,
        relay: response.overlay.relay,
      });

      // Return a synthetic A record pointing to localhost
      if (type === "A" || type === "ANY") {
        const syntheticAnswers: DnsAnswer[] = [
          { name: clean, type: "A", value: "127.0.0.1", ttl: 60 },
        ];
        this.cache.set(cacheKey, {
          answers: syntheticAnswers,
          expiresAt: Date.now() + this.cacheTtlMs,
        });
        return syntheticAnswers;
      }
    }

    this.cache.set(cacheKey, {
      answers: response.answers,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return response.answers;
  }

  /**
   * Forward a DNS query to Google's DoH JSON API.
   * Returns a DNS wire-format response buffer.
   * Uses fetch() to avoid Bun's dgram multi-socket limitation.
   */
  private async forwardUpstreamRaw(queryBuf: Buffer): Promise<Buffer> {
    const parsed = Packet.parse(queryBuf);
    const q = parsed.questions?.[0];
    if (!q) throw new Error("no question in query");

    const qname = q.name.replace(/\.$/, "");
    const qtype = this.typeToString(q.type);

    const res = await fetch(
      `https://8.8.8.8/resolve?name=${encodeURIComponent(qname)}&type=${qtype}`,
      { signal: AbortSignal.timeout(4000) },
    );

    if (!res.ok) throw new Error(`DoH returned ${res.status}`);

    const json = (await res.json()) as {
      Answer?: Array<{ name: string; type: number; TTL: number; data: string }>;
    };

    // Build a DNS wire-format response
    const writer = new Packet.Writer();
    const id = queryBuf.readUInt16BE(0);
    const answers = json.Answer || [];

    writer.write(id, 16);         // ID
    writer.write(0x8180, 16);     // Flags: QR, RD, RA
    writer.write(1, 16);          // QDCOUNT
    writer.write(answers.length, 16); // ANCOUNT
    writer.write(0, 16);          // NSCOUNT
    writer.write(0, 16);          // ARCOUNT

    // Question section
    for (const label of qname.split(".")) {
      writer.write(label.length, 8);
      for (const c of label) writer.write(c.charCodeAt(0), 8);
    }
    writer.write(0, 8);
    writer.write(q.type, 16);
    writer.write(q.class || 1, 16);

    // Answer section
    for (const ans of answers) {
      const aname = (ans.name || qname).replace(/\.$/, "");
      for (const label of aname.split(".")) {
        writer.write(label.length, 8);
        for (const c of label) writer.write(c.charCodeAt(0), 8);
      }
      writer.write(0, 8);
      writer.write(ans.type, 16);
      writer.write(1, 16); // CLASS IN
      writer.write(ans.TTL, 32);

      if (ans.type === 1) {
        // A record
        writer.write(4, 16);
        for (const octet of ans.data.split(".")) {
          writer.write(parseInt(octet, 10), 8);
        }
      } else if (ans.type === 28) {
        // AAAA -- write 16 bytes
        const expanded = expandIPv6(ans.data);
        writer.write(16, 16);
        for (const part of expanded) {
          writer.write(part, 16);
        }
      } else if (ans.type === 5) {
        // CNAME
        const cname = ans.data.replace(/\.$/, "");
        const cnameBytes = encodeDnsName(cname);
        writer.write(cnameBytes.length, 16);
        for (const b of cnameBytes) writer.write(b, 8);
      } else {
        // Other types -- write as raw string
        const dataBytes = Buffer.from(ans.data, "utf-8");
        writer.write(dataBytes.length, 16);
        for (const b of dataBytes) writer.write(b, 8);
      }
    }

    return Buffer.from(writer.toBuffer());
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
    } catch (err) {
      console.warn(`[tnp] dns2 Packet.write failed, using manual serialization: ${err instanceof Error ? err.message : String(err)}`);
    }

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
    const self = this;

    // UDP server
    this.udpServer = dgram.createSocket({ type: "udp4", reuseAddr: true });

    const handleUdpMessage = function(msg: Buffer, rinfo: dgram.RemoteInfo) {
      // Defer to next tick to unblock Bun's event loop for fetch()
      setTimeout(() => {
        self.handleQuery(Buffer.from(msg))
          .then((response) => {
            self.udpServer?.send(response, 0, response.length, rinfo.port, rinfo.address);
          })
          .catch((err) => {
            console.error(`[tnp] udp error: ${err instanceof Error ? err.stack : err}`);
          });
      }, 0);
    };

    this.udpServer.on("message", handleUdpMessage);
    this.udpServer.on("error", (err: Error) => console.error(`[tnp] udp server error: ${err}`));
    this.udpServer.bind(listenPort, listenAddr);

    // TCP server (for DNS-over-TLS via stunnel)
    // DNS TCP messages have a 2-byte length prefix. Max DNS message is 65535 bytes.
    const TCP_MAX_BUFFER = 65535 + 2; // max message + length prefix
    const TCP_IDLE_TIMEOUT_MS = 10_000;

    this.tcpServer = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);

      socket.setTimeout(TCP_IDLE_TIMEOUT_MS);
      socket.on("timeout", () => {
        socket.destroy();
      });

      socket.on("data", (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);

        // Protect against memory exhaustion from oversized or malicious input
        if (buffer.length > TCP_MAX_BUFFER) {
          console.warn("[tnp] tcp client exceeded max buffer size, closing connection");
          socket.destroy();
          return;
        }

        // TCP DNS uses 2-byte length prefix
        const processNext = () => {
          if (buffer.length < 2) return;
          const msgLen = buffer.readUInt16BE(0);
          if (buffer.length < 2 + msgLen) return;
          const queryBuf = Buffer.from(buffer.subarray(2, 2 + msgLen));
          buffer = buffer.subarray(2 + msgLen);
          this.handleQuery(queryBuf)
            .then((response) => {
              const lenBuf = Buffer.alloc(2);
              lenBuf.writeUInt16BE(response.length, 0);
              socket.write(Buffer.concat([lenBuf, response]));
              processNext();
            })
            .catch((err) => {
              console.error(`[tnp] tcp error: ${err}`);
              processNext();
            });
        };
        processNext();
      });
    });
    this.tcpServer.listen(listenPort, listenAddr);

    console.log(`[tnp] DNS proxy listening on ${listenAddr}:${listenPort} (UDP+TCP)`);
  }

  stop() {
    if (this.tldSyncInterval) {
      clearInterval(this.tldSyncInterval);
      this.tldSyncInterval = null;
    }
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
    // Callers control the initial sync via proxy.syncTlds() -- this only sets up the recurring timer.
    if (this.tldSyncInterval) {
      clearInterval(this.tldSyncInterval);
    }
    this.tldSyncInterval = setInterval(() => this.syncTlds(), intervalMs);
  }
}
