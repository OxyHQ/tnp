/**
 * Upstream resolution for public DNS names.
 *
 * Replaces a hardcoded call to Google's DoH **JSON** API whose answers were
 * re-encoded by hand — losing the response code, the authority and additional
 * sections, and the RDATA of every type but A, AAAA and CNAME (audit B3). It
 * also ignored `TnpConfig.upstreamDns` entirely, so every TNP user's public DNS
 * went to one third party regardless of what they configured (audit B4).
 *
 * Both transports here carry the DNS **wire format** end to end, so an upstream
 * NXDOMAIN arrives as NXDOMAIN and nothing has to be reconstructed.
 */

import dgram from "dgram";
import net from "net";

/** Per-attempt timeout. Kept short because a failover attempt follows. */
const QUERY_TIMEOUT_MS = 4_000;

/** DNS-over-HTTPS media type, RFC 8484 §4.1. */
const DOH_CONTENT_TYPE = "application/dns-message";

/** Guard against a hostile or broken upstream returning an enormous body. */
const MAX_RESPONSE_BYTES = 65535;

export type UpstreamTransport = "classic" | "doh";

export interface UpstreamConfig {
  transport: UpstreamTransport;
  /** IP address for `classic`, or an https:// URL for `doh`. */
  address: string;
  port?: number;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly upstream: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

/**
 * Parse an upstream spec.
 *
 * `1.1.1.1`, `1.1.1.1:5353` or `https://cloudflare-dns.com/dns-query`.
 * A bare address is classic DNS on port 53.
 */
export function parseUpstream(spec: string): UpstreamConfig {
  const trimmed = spec.trim();

  if (trimmed.startsWith("https://")) {
    return { transport: "doh", address: trimmed };
  }

  // IPv6 in brackets, optionally with a port: [2001:db8::1]:53
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed) {
    return {
      transport: "classic",
      address: bracketed[1],
      port: bracketed[2] ? Number(bracketed[2]) : 53,
    };
  }

  // A bare IPv6 address contains colons but no port; only treat a single
  // trailing colon-number as a port.
  const withPort = /^([^:]+):(\d+)$/.exec(trimmed);
  if (withPort) {
    return { transport: "classic", address: withPort[1], port: Number(withPort[2]) };
  }

  return { transport: "classic", address: trimmed, port: 53 };
}

/** Send a query and return the raw wire response. */
export async function queryUpstream(
  upstream: UpstreamConfig,
  queryBuf: Buffer,
): Promise<Buffer> {
  return upstream.transport === "doh"
    ? queryDoh(upstream, queryBuf)
    : queryClassicUdp(upstream, queryBuf);
}

/**
 * Re-send a query over TCP.
 *
 * Used when a UDP answer came back truncated. A resolver that ignores TC
 * returns a short answer as if it were complete, which is how a large record
 * set silently turns into a partial one.
 */
export async function queryUpstreamTcp(
  upstream: UpstreamConfig,
  queryBuf: Buffer,
): Promise<Buffer> {
  // DoH has no truncation: HTTP carries the whole message either way.
  if (upstream.transport === "doh") return queryDoh(upstream, queryBuf);
  return queryClassicTcp(upstream, queryBuf);
}

// ---------------------------------------------------------------------------
// Classic DNS
// ---------------------------------------------------------------------------

function queryClassicUdp(upstream: UpstreamConfig, queryBuf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(net.isIPv6(upstream.address) ? "udp6" : "udp4");
    let settled = false;

    const finish = (err: Error | null, response?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else if (response) resolve(response);
    };

    const timer = setTimeout(
      () => finish(new UpstreamError("timed out", upstream.address)),
      QUERY_TIMEOUT_MS,
    );

    socket.on("message", (msg) => finish(null, Buffer.from(msg)));
    socket.on("error", (err) => finish(new UpstreamError(err.message, upstream.address)));
    socket.send(queryBuf, upstream.port ?? 53, upstream.address, (err) => {
      if (err) finish(new UpstreamError(err.message, upstream.address));
    });
  });
}

function queryClassicTcp(upstream: UpstreamConfig, queryBuf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: upstream.address,
      port: upstream.port ?? 53,
    });

    // TCP DNS frames each message with a two-byte big-endian length prefix.
    const framed = Buffer.alloc(2 + queryBuf.byteLength);
    framed.writeUInt16BE(queryBuf.byteLength, 0);
    queryBuf.copy(framed, 2);

    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (err: Error | null, response?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else if (response) resolve(response);
    };

    const timer = setTimeout(
      () => finish(new UpstreamError("timed out", upstream.address)),
      QUERY_TIMEOUT_MS,
    );

    socket.on("connect", () => socket.write(framed));
    socket.on("error", (err) => finish(new UpstreamError(err.message, upstream.address)));
    socket.on("close", () =>
      finish(new UpstreamError("closed before a complete response", upstream.address)),
    );

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_RESPONSE_BYTES + 2) {
        finish(new UpstreamError("response exceeded the maximum DNS message size", upstream.address));
        return;
      }
      if (buffer.byteLength < 2) return;
      const length = buffer.readUInt16BE(0);
      if (buffer.byteLength < 2 + length) return;
      finish(null, Buffer.from(buffer.subarray(2, 2 + length)));
    });
  });
}

// ---------------------------------------------------------------------------
// DNS-over-HTTPS (RFC 8484) — wire format, not the JSON API
// ---------------------------------------------------------------------------

async function queryDoh(upstream: UpstreamConfig, queryBuf: Buffer): Promise<Buffer> {
  // The message ID must be zero on DoH so responses are cacheable by HTTP
  // intermediaries (RFC 8484 §4.1). The caller restores its own ID.
  const outgoing = Buffer.from(queryBuf);
  outgoing.writeUInt16BE(0, 0);

  const response = await fetch(upstream.address, {
    method: "POST",
    headers: { "content-type": DOH_CONTENT_TYPE, accept: DOH_CONTENT_TYPE },
    body: outgoing,
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new UpstreamError(`returned HTTP ${response.status}`, upstream.address);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith(DOH_CONTENT_TYPE)) {
    // A JSON body here means the endpoint speaks the JSON API, not RFC 8484 —
    // a misconfiguration worth naming rather than failing to parse later.
    throw new UpstreamError(
      `returned content-type "${contentType}", expected ${DOH_CONTENT_TYPE}`,
      upstream.address,
    );
  }

  const body = Buffer.from(await response.arrayBuffer());
  if (body.byteLength > MAX_RESPONSE_BYTES) {
    throw new UpstreamError("response exceeded the maximum DNS message size", upstream.address);
  }

  // Restore the caller's ID, which we zeroed above.
  if (body.byteLength >= 2) body.writeUInt16BE(queryBuf.readUInt16BE(0), 0);
  return body;
}
