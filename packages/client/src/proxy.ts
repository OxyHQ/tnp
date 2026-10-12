import { TnpApiClient, type DnsAnswer, type OverlayInfo as DnsResolveOverlay } from './api';
import type { DnsProxyConfig } from './config';
import {
  BUILTIN_NATIVE_TLDS,
  classifyName,
  normalizeName,
  validateNativeTld,
  type NamespaceType,
} from '@tnp/namespace';
import {
  buildResponse,
  capEncodedForUdp,
  clearAuthenticData,
  decodeQuery,
  encode,
  encodeForUdp,
  encodeRawError,
  rcodeOf,
  RCODE,
  upstreamQuery,
  type Answer,
  type DecodedPacket,
  type Packet,
} from './dns/wire';
import {
  parseUpstream,
  queryUpstream,
  queryUpstreamTcp,
  UpstreamError,
  type UpstreamConfig,
} from './dns/upstream';
import { DnsCache } from './dns/cache';
import { encodeTruncated, inspectQuery } from './dns/guard';
import { isLoopback, SourceRateLimiter } from './dns/rate-limit';
import dgram from 'node:dgram';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname } from 'node:path';

/**
 * TTL for the synthetic 127.0.0.1 answer that routes an overlay domain into the
 * local SOCKS5 proxy. Short on purpose: it is valid only while this device's
 * overlay client is running, so it must not outlive the session in a
 * downstream cache.
 */
const OVERLAY_TTL_SECONDS = 60;

/** Record types the TNP registry can serve. */
const TNP_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS'] as const;
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

/** Longest single TXT character-string (RFC 1035 §3.3: one length octet). */
const TXT_CHUNK_BYTES = 255;

/** Default per-source UDP rate limit (non-loopback sources only). */
const DEFAULT_RATE_LIMIT = { perSecond: 20, burst: 100 };
const DEFAULT_MAX_TCP_CONNECTIONS = 128;
const DEFAULT_MAX_INFLIGHT = 256;

/** TCP: most bytes buffered from one client before it is disconnected. */
const TCP_MAX_BUFFER = 4096;
/** TCP: close a connection that sends nothing for this long. */
const TCP_IDLE_TIMEOUT_MS = 10_000;
/**
 * TCP: close every connection this long after it was accepted, however busy.
 * The idle timer alone is re-armed by every byte, so a client trickling one
 * byte at a time could hold a slot forever.
 */
const TCP_SESSION_DEADLINE_MS = 30_000;

/**
 * Answer to a TNP-native lookup, with the three outcomes kept apart: the
 * old code returned an empty list for both "no such name" and "no records of
 * this type", and then sent NXDOMAIN for both.
 */
type NativeResult =
  | { kind: 'answers'; records: DnsAnswer[] }
  | { kind: 'nodata' }
  | { kind: 'nxdomain' };

/** Most overlay blocks kept for the SOCKS proxy. */
const MAX_OVERLAY_CACHE = 1024;

export class DnsProxy {
  private apiClient: TnpApiClient;
  /**
   * TLD policy table: native TLD -> whether it is flagged custom by the
   * registry. Never empty: it always holds `BUILTIN_NATIVE_TLDS`, so a native
   * name is classified as native from the first packet, before any TLD sync
   * and whether or not the registry is reachable.
   */
  private tlds = builtinTable();
  private cache: DnsCache<DnsAnswer>;
  private upstreams: UpstreamConfig[];
  private udpServer: dgram.Socket | null = null;
  private tcpServer: net.Server | null = null;
  private config: DnsProxyConfig;
  private readonly rateLimiter: SourceRateLimiter | null;
  private readonly maxInflight: number;
  private readonly maxTcpConnections: number;
  private inflight = 0;
  private tcpConnections = 0;
  private slipCounter = 0;

  /**
   * Overlay info cache. When a domain has an active service node, the DNS proxy
   * returns 127.0.0.1 so traffic goes through the local SOCKS5 proxy, which
   * reads the cached overlay block from here. It is UNVERIFIED registry data:
   * the tunnel manager verifies it (pin, chain, certificate) before use.
   * Bounded like the answer cache.
   */
  private overlayCache = new Map<string, DnsResolveOverlay>();

  /** Whether overlay routing is enabled (set when SOCKS5 proxy is running) */
  private overlayEnabled = false;

  /** Handle for the periodic TLD sync interval, so it can be cleared on stop. */
  private tldSyncInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: DnsProxyConfig,
    private readonly onTraffic?: (direction: 'inbound' | 'outbound') => void,
  ) {
    this.config = config;
    this.apiClient = new TnpApiClient(config.apiBaseUrl);
    this.cache = new DnsCache<DnsAnswer>({ maxEntries: config.cacheMaxEntries });
    this.upstreams = parseUpstreams(config.upstreamDns);
    const rateLimit = config.rateLimit === undefined ? DEFAULT_RATE_LIMIT : config.rateLimit;
    this.rateLimiter = rateLimit ? new SourceRateLimiter(rateLimit) : null;
    this.maxInflight = config.maxInflight ?? DEFAULT_MAX_INFLIGHT;
    this.maxTcpConnections = config.maxTcpConnections ?? DEFAULT_MAX_TCP_CONNECTIONS;
    this.loadPersistedTlds();
  }

  /** Observability must never change DNS answers or expose query contents. */
  private observeTraffic(direction: 'inbound' | 'outbound'): void {
    try {
      this.onTraffic?.(direction);
    } catch {
      /* Best-effort counters. */
    }
  }

  get listening(): boolean {
    try {
      return Boolean(this.tcpServer?.listening && this.udpServer?.address());
    } catch {
      return false;
    }
  }

  /** The bound UDP port, once listening. Useful when configured with port 0. */
  get udpPort(): number | null {
    try {
      return this.udpServer?.address().port ?? null;
    } catch {
      return null;
    }
  }

  /** The bound TCP port, once listening. */
  get tcpPort(): number | null {
    const address = this.tcpServer?.address();
    return address && typeof address === 'object' ? address.port : null;
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
  getOverlayInfo(domain: string): DnsResolveOverlay | undefined {
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

  /** The native TLDs currently classified as TNP's. */
  getNativeTlds(): string[] {
    return [...this.tlds.keys()];
  }

  /**
   * Load the TLD policy table.
   *
   * The built-in native TLDs are always kept: an API response — empty, stale,
   * truncated or hostile — can add approved TLDs but never remove `.ox`,
   * because a client without `.ox` in its table forwards `.ox` lookups to the
   * public upstream.
   *
   * Reserved TLDs are dropped rather than stored. The server already filters
   * them, but a resolver that shadows public names on the server's say-so is
   * one compromised or stale API away from redirecting `google.com` — so the
   * client enforces the namespace rule itself (docs/architecture/naming.md,
   * rule N1).
   */
  setTlds(tlds: Array<string | { name: string; custom?: boolean }>): void {
    const table = builtinTable();
    const refused: string[] = [];

    for (const t of tlds) {
      const raw = typeof t === 'string' ? t : t?.name;
      if (typeof raw !== 'string') continue;
      const valid = validateNativeTld(raw);
      if (!valid.ok) {
        refused.push(normalizeName(raw));
        continue;
      }
      const custom = typeof t === 'string' ? true : (t.custom ?? true);
      table.set(valid.tld, custom);
    }

    this.tlds = table;

    // Classification depends on this table, so entries cached under the old
    // one may now belong to the other namespace.
    this.cache.clear();

    console.log(`[tnp] loaded ${this.tlds.size} TLDs: ${[...this.tlds.keys()].join(', ')}`);
    if (refused.length > 0) {
      console.warn(
        `[tnp] refused ${refused.length} reserved or invalid TLD(s) offered by the API: ${refused.join(', ')}. ` +
          `Reserved TLDs are delegated by the public DNS root or in private use, and are resolved upstream, not by TNP.`,
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
      case 'A':
        return net.isIPv4(value) ? { type: 'A', name, ttl, data: value } : null;
      case 'AAAA':
        return net.isIPv6(value) ? { type: 'AAAA', name, ttl, data: value } : null;
      case 'CNAME':
        return { type: 'CNAME', name, ttl, data: value };
      case 'NS':
        return { type: 'NS', name, ttl, data: value };
      case 'TXT':
        return { type: 'TXT', name, ttl, data: txtStrings(record.value) };
      case 'MX': {
        const match = /^(\d+)\s+(\S+)$/.exec(value);
        return {
          type: 'MX',
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

  /**
   * Look up a TNP-native name, via the cache.
   *
   * Honours the registry's `rcode` (`dns-resolve` contract in
   * `@tnp/shared-types`): `NOERROR` with no answers is NODATA — the name exists
   * without records of this type — and is never turned into NXDOMAIN. An API
   * that predates `rcode` gets the old reading, empty meaning NXDOMAIN.
   */
  private async resolveTnp(name: string, type: string): Promise<NativeResult> {
    const clean = normalizeName(name);

    const cached = this.cache.get(clean, type);
    if (cached) {
      if (cached.negative) return { kind: 'nxdomain' };
      return cached.records.length === 0
        ? { kind: 'nodata' }
        : { kind: 'answers', records: cached.records };
    }

    const response = await this.apiClient.resolveWithOverlay(clean, type);
    if (!response || !Array.isArray(response.answers)) {
      throw new Error('registry returned a malformed resolve response');
    }

    // If overlay is enabled and the domain has an active service node, cache
    // the overlay info and answer with 127.0.0.1 so the connection is picked up
    // by the local SOCKS5 proxy.
    if (this.overlayEnabled && response.overlay?.available) {
      this.overlayCache.delete(clean);
      if (this.overlayCache.size >= MAX_OVERLAY_CACHE) {
        this.overlayCache.delete(this.overlayCache.keys().next().value as string);
      }
      this.overlayCache.set(clean, response.overlay);

      if (type === 'A' || type === 'ANY') {
        const synthetic: DnsAnswer[] = [
          { name: clean, type: 'A', value: '127.0.0.1', ttl: OVERLAY_TTL_SECONDS },
        ];
        this.cache.set(clean, type, synthetic);
        return { kind: 'answers', records: synthetic };
      }
    }

    if (response.answers.length === 0) {
      // Negative caching (RFC 2308). Without it every lookup of a nonexistent
      // name is a fresh round trip to the registry.
      if (response.rcode === 'NOERROR') {
        this.cache.setNoData(clean, type);
        return { kind: 'nodata' };
      }
      this.cache.setNegative(clean, type);
      return { kind: 'nxdomain' };
    }

    this.cache.set(clean, type, response.answers);
    return { kind: 'answers', records: response.answers };
  }

  /**
   * Forward a public-DNS query upstream, in wire format end to end.
   *
   * What goes upstream is rebuilt from the client's question (`upstreamQuery`):
   * no client EDNS options, no DO, padded on DoH. Tries each configured
   * upstream in order. A truncated UDP answer is retried over TCP: returning it
   * as-is would hand the client a silently partial record set.
   */
  private async forwardUpstream(query: DecodedPacket): Promise<Buffer> {
    let lastError: Error | null = null;

    for (const upstream of this.upstreams) {
      try {
        const outgoing = upstreamQuery(query, { pad: upstream.transport === 'doh' });
        if (upstream.transport === 'classic') this.observeTraffic('outbound');
        let response = await queryUpstream(upstream, outgoing);
        if (upstream.transport === 'classic') this.observeTraffic('inbound');

        // Bit 9 of the flags word is TC.
        if (response.byteLength >= 4 && (response.readUInt16BE(2) & 0x0200) !== 0) {
          this.observeTraffic('outbound');
          response = await queryUpstreamTcp(upstream, outgoing);
          this.observeTraffic('inbound');
        }

        return clearAuthenticData(response);
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
      `[tnp] all ${this.upstreams.length} upstream(s) failed: ${lastError?.message ?? 'unknown'}`,
    );
    return encode(buildResponse(query, { rcode: 'SERVFAIL' }));
  }

  /**
   * Answer one query. Returns the raw wire response, or an empty buffer when
   * the packet deserves no reply at all.
   *
   * The packet is vetted from its raw bytes (`inspectQuery`) before it is
   * decoded, so a hostile packet costs one bounded pass, not a decode.
   * `forUdp` decides whether an oversized response is truncated with TC set.
   */
  async handleQuery(queryBuf: Buffer, forUdp: boolean): Promise<Buffer> {
    const verdict = inspectQuery(queryBuf, forUdp ? 'udp' : 'tcp');
    if (verdict.kind === 'drop') return Buffer.alloc(0);
    if (verdict.kind === 'error') {
      return encodeRawError(queryBuf, verdict.rcode) ?? Buffer.alloc(0);
    }

    let query: DecodedPacket;
    try {
      query = decodeQuery(queryBuf);
    } catch (err) {
      console.warn(`[tnp] malformed query: ${err instanceof Error ? err.message : String(err)}`);
      return encodeRawError(queryBuf, 'FORMERR') ?? Buffer.alloc(0);
    }

    const question = query.questions?.[0];
    if (!question) {
      return encode(buildResponse(query, { rcode: 'FORMERR' }));
    }

    // Bound the work in flight: every resolution holds an upstream socket or a
    // registry request for up to several seconds. Beyond the limit, SERVFAIL
    // now beats queueing — and a native name still never goes upstream.
    if (this.inflight >= this.maxInflight) {
      return encode(buildResponse(query, { rcode: 'SERVFAIL' }));
    }
    this.inflight++;
    try {
      // Classification happens first, offline, always. A public-dns name never
      // reaches the TNP API — that is both the namespace guarantee and a privacy
      // property, since it stops the API from learning the user's public
      // browsing (docs/architecture/naming.md rule N4). A native name never
      // reaches the upstream: see resolveNative.
      if (this.classify(question.name) !== 'tnp-native') {
        const response = await this.forwardUpstream(query);
        return forUdp ? capEncodedForUdp(query, response) : response;
      }

      const packet = await this.resolveNative(query, question.name, question.type);
      return forUdp ? encodeForUdp(query, packet) : encode(packet);
    } finally {
      this.inflight--;
    }
  }

  /**
   * Answer a TNP-native name from the registry.
   *
   * Never falls through to public DNS: forwarding a nonexistent TNP name
   * upstream would let a TNP registration outrank a public one by simply not
   * existing yet, and would hand the name to the upstream operator and, for a
   * plaintext upstream, to everyone on the path.
   */
  private async resolveNative(query: DecodedPacket, qname: string, qtype: string): Promise<Packet> {
    let result: NativeResult;
    try {
      result = await this.resolveTnp(qname, qtype);
    } catch (err) {
      // The registry is unreachable or errored. SERVFAIL says "ask again";
      // an empty NOERROR would say "this name has no such records", which is a
      // claim we are not in a position to make. The name is not logged: a
      // resolver log is a browsing history.
      console.error(
        `[tnp] registry lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return buildResponse(query, { rcode: 'SERVFAIL' });
    }

    if (result.kind === 'nxdomain') {
      return buildResponse(query, { rcode: 'NXDOMAIN', authoritative: true });
    }
    if (result.kind === 'nodata') {
      return buildResponse(query, { rcode: 'NOERROR', authoritative: true });
    }

    const answers = result.records
      .map((record) => this.toAnswer(qname, record))
      .filter((answer): answer is NonNullable<typeof answer> => answer !== null);

    return buildResponse(query, { rcode: 'NOERROR', answers, authoritative: true });
  }

  async start(): Promise<void> {
    const { listenAddr, listenPort } = this.config;

    console.log(
      `[tnp] upstream resolvers: ${this.upstreams
        .map((u) => `${u.transport}:${u.address}`)
        .join(', ')}`,
    );
    const plaintext = this.upstreams.filter((u) => u.transport === 'classic');
    if (plaintext.length > 0) {
      console.warn(
        `[tnp] WARNING: ${plaintext.map((u) => u.address).join(', ')} is plaintext DNS. ` +
          `Anyone on the network path can read and forge every public name this device looks up. ` +
          `Use an https:// DoH upstream unless you mean this.`,
      );
    }

    this.udpServer = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.udpServer.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      this.observeTraffic('inbound');
      const query = Buffer.from(msg);

      if (
        this.rateLimiter &&
        !isLoopback(rinfo.address) &&
        !this.rateLimiter.allow(rinfo.address)
      ) {
        // Over the limit: drop, except that every second refused query gets a
        // TC reply no bigger than the query (RRL "slip"), so a real client
        // sharing an address with a flood can still get through over TCP.
        this.slipCounter = (this.slipCounter + 1) % 2;
        if (this.slipCounter !== 0) return;
        const verdict = inspectQuery(query, 'udp');
        if (verdict.kind !== 'ok') return;
        this.sendUdp(encodeTruncated(query, verdict.questionEnd), rinfo);
        return;
      }

      // Defer to the next tick so a synchronous handler cannot block Bun's
      // event loop while the upstream fetch is in flight.
      setTimeout(() => {
        this.handleQuery(query, true)
          .then((response) => this.sendUdp(response, rinfo))
          .catch((err) => {
            console.error(`[tnp] udp error: ${err instanceof Error ? err.message : err}`);
          });
      }, 0);
    });

    this.udpServer.on('error', (err: Error) => console.error(`[tnp] udp server error: ${err}`));

    this.tcpServer = net.createServer((socket) => this.handleTcpConnection(socket));
    this.tcpServer.on('error', (err: Error) => console.error(`[tnp] tcp server error: ${err}`));

    const udp = this.udpServer;
    const tcp = this.tcpServer;
    await new Promise<void>((resolve, reject) => {
      udp.once('error', reject);
      udp.bind(listenPort, listenAddr, () => {
        udp.off('error', reject);
        resolve();
      });
    });
    // Same port for TCP. Port 0 (tests) lets each transport pick its own; read
    // them back with `udpPort` / `tcpPort`.
    await new Promise<void>((resolve, reject) => {
      tcp.once('error', reject);
      tcp.listen(listenPort, listenAddr, () => {
        tcp.off('error', reject);
        resolve();
      });
    });

    console.log(
      `[tnp] DNS proxy listening on ${listenAddr}:${this.udpPort}/udp, ${this.tcpPort}/tcp`,
    );
  }

  private sendUdp(response: Buffer, rinfo: dgram.RemoteInfo): void {
    if (response.byteLength === 0 || !this.udpServer) return;
    this.udpServer.send(response, 0, response.length, rinfo.port, rinfo.address);
    this.observeTraffic('outbound');
  }

  /**
   * Serve one TCP client: two-byte length-prefixed messages, answered one at a
   * time and in order, within a connection cap, an idle timeout, a hard
   * session deadline and a bounded input buffer.
   */
  private handleTcpConnection(socket: net.Socket): void {
    if (this.tcpConnections >= this.maxTcpConnections) {
      socket.destroy();
      return;
    }
    this.tcpConnections++;

    let buffer = Buffer.alloc(0);
    let busy = false;
    const deadline = setTimeout(() => socket.destroy(), TCP_SESSION_DEADLINE_MS);

    socket.setTimeout(TCP_IDLE_TIMEOUT_MS);
    socket.on('timeout', () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      clearTimeout(deadline);
      this.tcpConnections--;
    });

    const processNext = () => {
      if (busy || socket.destroyed || buffer.length < 2) return;
      const msgLen = buffer.readUInt16BE(0);
      if (buffer.length < 2 + msgLen) return;
      const queryBuf = Buffer.from(buffer.subarray(2, 2 + msgLen));
      buffer = buffer.subarray(2 + msgLen);

      busy = true;
      this.observeTraffic('inbound');
      this.handleQuery(queryBuf, false)
        .then((response) => {
          if (response.byteLength > 0 && !socket.destroyed) {
            const lenBuf = Buffer.alloc(2);
            lenBuf.writeUInt16BE(response.length, 0);
            socket.write(Buffer.concat([lenBuf, response]));
            this.observeTraffic('outbound');
          }
        })
        .catch((err) => {
          console.error(`[tnp] tcp error: ${err instanceof Error ? err.message : err}`);
        })
        .finally(() => {
          busy = false;
          processNext();
        });
    };

    socket.on('data', (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > TCP_MAX_BUFFER) {
        socket.destroy();
        return;
      }
      processNext();
    });
  }

  stop() {
    if (this.tldSyncInterval) {
      clearInterval(this.tldSyncInterval);
      this.tldSyncInterval = null;
    }
    try {
      this.udpServer?.close();
    } catch {
      /* not bound */
    }
    this.tcpServer?.close();
  }

  /**
   * Refresh the TLD table from the registry. Returns whether it succeeded.
   *
   * A failure keeps the current table (built-ins plus the last good list), and
   * a success is persisted so the next start has it even offline.
   */
  async syncTlds(): Promise<boolean> {
    try {
      const tlds = await this.apiClient.fetchTlds();
      if (!Array.isArray(tlds)) throw new Error('registry returned a malformed TLD list');
      this.setTlds(tlds);
      this.persistTlds();
      return true;
    } catch (err) {
      console.error(
        `[tnp] failed to sync TLDs, keeping ${this.tlds.size} known: ${err instanceof Error ? err.message : err}`,
      );
      return false;
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

  /** Seed the table from the last good registry list, if one was saved. */
  private loadPersistedTlds(): void {
    const path = this.config.tldCachePath;
    if (!path) return;
    let saved: unknown;
    try {
      saved = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return; // absent or unreadable: built-ins only
    }
    if (!Array.isArray(saved)) return;
    const table = builtinTable();
    for (const entry of saved) {
      if (typeof entry !== 'string') continue;
      const valid = validateNativeTld(entry);
      if (valid.ok) table.set(valid.tld, true);
    }
    this.tlds = table;
  }

  private persistTlds(): void {
    const path = this.config.tldCachePath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify([...this.tlds.keys()])}\n`, { mode: 0o644 });
      renameSync(tmp, path);
    } catch (err) {
      console.warn(
        `[tnp] could not save the TLD list: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function builtinTable(): Map<string, boolean> {
  return new Map(BUILTIN_NATIVE_TLDS.map((tld) => [tld, true]));
}

/**
 * Split a TXT value into character-strings of at most 255 bytes.
 *
 * A TXT record is a sequence of length-prefixed strings with a one-byte
 * length. Handing `dns-packet` one long string writes `length & 0xff` as the
 * prefix — a malformed record that desynchronises every parser reading it.
 */
export function txtStrings(value: string): Buffer[] {
  const bytes = Buffer.from(value, 'utf-8');
  if (bytes.byteLength === 0) return [Buffer.alloc(0)];
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += TXT_CHUNK_BYTES) {
    chunks.push(bytes.subarray(offset, offset + TXT_CHUNK_BYTES));
  }
  return chunks;
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
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(parseUpstream);

  if (entries.length === 0) {
    throw new Error(
      'No upstream DNS resolver configured. Set upstreamDns to an RFC 8484 DoH URL ' +
        '(e.g. "https://1.1.1.1/dns-query") or a plaintext address.',
    );
  }

  return entries;
}

export { RCODE, rcodeOf };
