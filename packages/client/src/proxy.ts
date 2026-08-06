import { TnpApiClient, type DnsAnswer } from "./api";
import type { DnsProxyConfig } from "./config";
import { classifyName, isReservedTld, normalizeName, type NamespaceType } from "@tnp/namespace";
import {
  buildResponse,
  decodeQuery,
  encode,
  encodeForUdp,
  encodeRawError,
  rcodeOf,
  RCODE,
  type Answer,
  type DecodedPacket,
  type Packet,
} from "./dns/wire";
import {
  parseUpstream,
  queryUpstream,
  queryUpstreamTcp,
  UpstreamError,
  type UpstreamConfig,
} from "./dns/upstream";
import dgram from "dgram";
import net from "net";

/** Record types the TNP registry can serve. */
const TNP_RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS"] as const;
type TnpRecordType = (typeof TNP_RECORD_TYPES)[number];

/**
 * MX preference used when a stored record does not carry one.
 *
 * The registry's record model is `{ type, name, value, ttl }` with no
 * preference field, so a bare exchange gets this value. A stored value of the
 * form `"10 mail.example.ox"` is parsed instead. Giving MX a first-class
 * preference belongs with the record-model work, not here.
 */
const DEFAULT_MX_PREFERENCE = 10;

interface CacheEntry {
  answers: DnsAnswer[];
  expiresAt: number;
}

export class DnsProxy {
  private apiClient: TnpApiClient;
  /** TLD policy table: native TLD -> whether it is flagged custom by the registry. */
  private tlds = new Map<string, boolean>();
  private cache = new Map<string, CacheEntry>();
  private cacheTtlMs: number;
  private upstreams: UpstreamConfig[];
  private udpServer: dgram.Socket | null = null;
  private tcpServer: net.Server | null = null;
  private config: DnsProxyConfig;

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

  constructor(config: DnsProxyConfig) {
    this.config = config;
    this.apiClient = new TnpApiClient(config.apiBaseUrl);
    this.cacheTtlMs = config.cacheTtlSeconds * 1000;
    this.upstreams = parseUpstreams(config.upstreamDns);
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
    return this.overlayCache.get(normalizeName(domain));
  }

  /** Expose the API client for shared use by other components. */
  getApiClient(): TnpApiClient {
    return this.apiClient;
  }

  /** The upstream resolvers in use, in failover order. */
  getUpstreams(): readonly UpstreamConfig[] {
    return this.upstreams;
  }

  /**
   * Load the TLD policy table.
   *
   * Reserved TLDs are dropped rather than stored. The server already filters
   * them, but a resolver that shadows public names on the server's say-so is
   * one compromised or stale API away from redirecting `google.com` — so the
   * client enforces the namespace rule itself (docs/architecture/naming.md,
   * rule N1).
   */
  setTlds(tlds: Array<string | { name: string; custom?: boolean }>) {
    this.tlds = new Map<string, boolean>();
    const refused: string[] = [];

    for (const t of tlds) {
      const name = normalizeName(typeof t === "string" ? t : t.name);
      if (isReservedTld(name)) {
        refused.push(name);
        continue;
      }
      const custom = typeof t === "string" ? true : (t.custom ?? true);
      this.tlds.set(name, custom);
    }

    console.log(`[tnp] loaded ${this.tlds.size} TLDs: ${[...this.tlds.keys()].join(", ")}`);
    if (refused.length > 0) {
      console.warn(
        `[tnp] refused ${refused.length} reserved TLD(s) offered by the API: ${refused.join(", ")}. ` +
          `These are delegated by the public DNS root and are resolved upstream, not by TNP.`,
      );
    }
  }

  /**
   * Which authority owns this name. Pure, offline, and independent of whether
   * the name is registered — see docs/architecture/naming.md §1.
   */
  classify(name: string): NamespaceType {
    return classifyName(name, this.tlds.keys());
  }

  /**
   * Convert a registry record into a wire answer.
   *
   * Returns null for a record whose stored value does not fit its type, rather
   * than emitting a structurally valid but wrong record — the previous encoder
   * wrote `RDLENGTH 0` for everything that was not an A record, which produced
   * empty answers that looked successful.
   */
  private toAnswer(qname: string, record: DnsAnswer): Answer | null {
    const ttl = record.ttl > 0 ? record.ttl : 3600;
    const name = qname;
    const value = record.value.trim();

    switch (record.type.toUpperCase() as TnpRecordType) {
      case "A":
        return net.isIPv4(value) ? { type: "A", name, ttl, data: value } : null;
      case "AAAA":
        return net.isIPv6(value) ? { type: "AAAA", name, ttl, data: value } : null;
      case "CNAME":
        return { type: "CNAME", name, ttl, data: value };
      case "NS":
        return { type: "NS", name, ttl, data: value };
      case "TXT":
        return { type: "TXT", name, ttl, data: value };
      case "MX": {
        const match = /^(\d+)\s+(\S+)$/.exec(value);
        return {
          type: "MX",
          name,
          ttl,
          data: match
            ? { preference: Number(match[1]), exchange: match[2] }
            : { preference: DEFAULT_MX_PREFERENCE, exchange: value },
        };
      }
      default:
        return null;
    }
  }

  private async resolveTnp(name: string, type: string): Promise<DnsAnswer[]> {
    const clean = normalizeName(name);
    const cacheKey = `${clean}:${type}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.answers;

    const response = await this.apiClient.resolveWithOverlay(clean, type);

    // If overlay is enabled and the domain has an active service node,
    // cache the overlay info and return 127.0.0.1 to route through SOCKS5
    if (this.overlayEnabled && response.overlay?.available) {
      this.overlayCache.set(clean, {
        pubKey: response.overlay.serviceNodePubKey,
        relay: response.overlay.relay,
      });

      if (type === "A" || type === "ANY") {
        const synthetic: DnsAnswer[] = [
          { name: clean, type: "A", value: "127.0.0.1", ttl: 60 },
        ];
        this.cache.set(cacheKey, {
          answers: synthetic,
          expiresAt: Date.now() + this.cacheTtlMs,
        });
        return synthetic;
      }
    }

    this.cache.set(cacheKey, {
      answers: response.answers,
      expiresAt: Date.now() + this.cacheTtlMs,
    });
    return response.answers;
  }

  /**
   * Forward a public-DNS query upstream, in wire format end to end.
   *
   * Tries each configured upstream in order. A truncated UDP answer is retried
   * over TCP: returning it as-is would hand the client a silently partial
   * record set.
   */
  private async forwardUpstream(query: DecodedPacket, queryBuf: Buffer): Promise<Buffer> {
    let lastError: Error | null = null;

    for (const upstream of this.upstreams) {
      try {
        let response = await queryUpstream(upstream, queryBuf);

        // Bit 9 of the flags word is TC.
        if (response.byteLength >= 4 && (response.readUInt16BE(2) & 0x0200) !== 0) {
          response = await queryUpstreamTcp(upstream, queryBuf);
        }

        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const where = err instanceof UpstreamError ? err.upstream : upstream.address;
        console.warn(`[tnp] upstream ${where} failed: ${lastError.message}`);
      }
    }

    // Every upstream failed. SERVFAIL is the honest answer; the old resolver
    // returned an empty NOERROR here, which tells the client the name exists
    // and simply has no records (audit B3).
    console.error(
      `[tnp] all ${this.upstreams.length} upstream(s) failed: ${lastError?.message ?? "unknown"}`,
    );
    return encode(buildResponse(query, { rcode: "SERVFAIL" }));
  }

  /**
   * Answer one query. Returns the raw wire response.
   *
   * `forUdp` decides whether an oversized response is truncated with TC set.
   */
  async handleQuery(queryBuf: Buffer, forUdp: boolean): Promise<Buffer> {
    let query: DecodedPacket;
    try {
      query = decodeQuery(queryBuf);
    } catch (err) {
      console.warn(`[tnp] malformed query: ${err instanceof Error ? err.message : String(err)}`);
      return encodeRawError(queryBuf, "FORMERR") ?? Buffer.alloc(0);
    }

    const question = query.questions?.[0];
    if (!question) {
      return encode(buildResponse(query, { rcode: "FORMERR" }));
    }

    // Classification happens first, offline, always. A public-dns name never
    // reaches the TNP API — that is both the namespace guarantee and a privacy
    // property, since it stops the API from learning the user's public
    // browsing (docs/architecture/naming.md rule N4).
    if (this.classify(question.name) !== "tnp-native") {
      const response = await this.forwardUpstream(query, queryBuf);
      return forUdp ? capUdp(query, response) : response;
    }

    const packet = await this.resolveNative(query, question.name, question.type);
    return forUdp ? encodeForUdp(query, packet) : encode(packet);
  }

  /**
   * Answer a TNP-native name from the registry.
   *
   * Never falls through to public DNS: forwarding a nonexistent TNP name
   * upstream would let a TNP registration outrank a public one by simply not
   * existing yet.
   */
  private async resolveNative(
    query: DecodedPacket,
    qname: string,
    qtype: string,
  ): Promise<Packet> {
    let records: DnsAnswer[];
    try {
      records = await this.resolveTnp(qname, qtype);
    } catch (err) {
      // The registry is unreachable or errored. SERVFAIL says "ask again";
      // an empty NOERROR would say "this name has no such records", which is a
      // claim we are not in a position to make.
      console.error(
        `[tnp] registry lookup failed for ${qname}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return buildResponse(query, { rcode: "SERVFAIL" });
    }

    const answers = records
      .map((record) => this.toAnswer(qname, record))
      .filter((answer): answer is NonNullable<typeof answer> => answer !== null);

    // No records for a TNP-native name means the name does not exist here.
    // NXDOMAIN is distinguishable from "exists, no records of this type";
    // the old resolver returned NOERROR for both.
    return buildResponse(query, {
      rcode: answers.length > 0 ? "NOERROR" : "NXDOMAIN",
      answers,
      authoritative: true,
    });
  }

  async start(): Promise<void> {
    const { listenAddr, listenPort } = this.config;

    console.log(
      `[tnp] upstream resolvers: ${this.upstreams
        .map((u) => `${u.transport}:${u.address}`)
        .join(", ")}`,
    );

    this.udpServer = dgram.createSocket({ type: "udp4", reuseAddr: true });

    this.udpServer.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      // Defer to the next tick so a synchronous handler cannot block Bun's
      // event loop while the upstream fetch is in flight.
      setTimeout(() => {
        this.handleQuery(Buffer.from(msg), true)
          .then((response) => {
            if (response.byteLength === 0) return;
            this.udpServer?.send(response, 0, response.length, rinfo.port, rinfo.address);
          })
          .catch((err) => {
            console.error(`[tnp] udp error: ${err instanceof Error ? err.stack : err}`);
          });
      }, 0);
    });

    this.udpServer.on("error", (err: Error) => console.error(`[tnp] udp server error: ${err}`));
    this.udpServer.bind(listenPort, listenAddr);

    // TCP DNS frames each message with a two-byte length prefix.
    const TCP_MAX_BUFFER = 65535 + 2;
    const TCP_IDLE_TIMEOUT_MS = 10_000;

    this.tcpServer = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);

      socket.setTimeout(TCP_IDLE_TIMEOUT_MS);
      socket.on("timeout", () => socket.destroy());
      socket.on("error", () => socket.destroy());

      socket.on("data", (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);

        if (buffer.length > TCP_MAX_BUFFER) {
          console.warn("[tnp] tcp client exceeded max buffer size, closing connection");
          socket.destroy();
          return;
        }

        const processNext = () => {
          if (buffer.length < 2) return;
          const msgLen = buffer.readUInt16BE(0);
          if (buffer.length < 2 + msgLen) return;
          const queryBuf = Buffer.from(buffer.subarray(2, 2 + msgLen));
          buffer = buffer.subarray(2 + msgLen);

          this.handleQuery(queryBuf, false)
            .then((response) => {
              if (response.byteLength > 0) {
                const lenBuf = Buffer.alloc(2);
                lenBuf.writeUInt16BE(response.length, 0);
                socket.write(Buffer.concat([lenBuf, response]));
              }
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
    this.tldSyncInterval.unref?.();
  }
}

/**
 * Parse the configured upstream list.
 *
 * Comma-separated, tried in order on failure. `TnpConfig.upstreamDns` was
 * previously settable, shown in the settings editor, and never read — every
 * public query went to a hardcoded endpoint regardless (audit B4).
 */
export function parseUpstreams(spec: string): UpstreamConfig[] {
  const entries = spec
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(parseUpstream);

  if (entries.length === 0) {
    throw new Error(
      "No upstream DNS resolver configured. Set upstreamDns to an address " +
        '(e.g. "1.1.1.1") or an RFC 8484 DoH URL.',
    );
  }

  return entries;
}

/**
 * Truncate an already-encoded upstream response that will not fit in the
 * client's UDP budget. Re-encoding is avoided so upstream RDATA we do not model
 * passes through untouched.
 */
function capUdp(query: DecodedPacket, response: Buffer): Buffer {
  const limit = ednsLimit(query);
  if (response.byteLength <= limit) return response;

  // Header only, TC set: the client retries over TCP and gets the whole answer.
  const header = Buffer.from(response.subarray(0, 12));
  header.writeUInt16BE(header.readUInt16BE(2) | 0x0200, 2);
  header.writeUInt16BE(0, 6); // ANCOUNT
  header.writeUInt16BE(0, 8); // NSCOUNT
  header.writeUInt16BE(0, 10); // ARCOUNT
  header.writeUInt16BE(0, 4); // QDCOUNT — the question is dropped with the body
  return header;
}

function ednsLimit(query: DecodedPacket): number {
  const opt = query.additionals?.find((record) => record.type === "OPT");
  if (opt && opt.type === "OPT") return Math.min(Math.max(opt.udpPayloadSize, 512), 4096);
  return 512;
}

export { RCODE, rcodeOf };
