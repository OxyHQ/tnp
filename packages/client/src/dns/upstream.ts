/**
 * Upstream resolution for public DNS names.
 *
 * Replaces a hardcoded call to Google's DoH **JSON** API whose answers were
 * re-encoded by hand — losing the response code, the authority and additional
 * sections, and the RDATA of every type but A, AAAA and CNAME (audit B3). It
 * also ignored `TnpConfig.upstreamDns` entirely, so every TNP user's public DNS
 * went to one third party regardless of what they configured (audit B4).
 *
 * Every transport here carries the DNS **wire format** end to end, so an
 * upstream NXDOMAIN arrives as NXDOMAIN and nothing has to be reconstructed.
 *
 * Classic (UDP/TCP) upstreams are plaintext: anyone on the path — the local
 * network, the ISP — reads every public name the device looks up and can
 * answer in the upstream's place. The default is therefore DoH (RFC 8484), and
 * a classic upstream is a deliberate user choice that is warned about.
 *
 * An answer is accepted only if it answers OUR question: the transaction ID
 * on the wire is a fresh random value per attempt (never the client's), the
 * UDP socket is connected so datagrams from any other source are discarded by
 * the kernel, and the response's question section must match the one we sent.
 * Anything else is ignored and the attempt keeps waiting until its timeout —
 * that is the difference between an off-path spoofer having to win a 2^32
 * race (ID × source port) and simply sending the first packet.
 */

import { randomInt } from 'node:crypto';
import dgram from 'node:dgram';
import net from 'node:net';
import { questionOf } from './guard';

/** Per-attempt timeout. Kept short because a failover attempt follows. */
const QUERY_TIMEOUT_MS = 4_000;

/** DNS-over-HTTPS media type, RFC 8484 §4.1. */
const DOH_CONTENT_TYPE = 'application/dns-message';

/** Guard against a hostile or broken upstream returning an enormous body. */
const MAX_RESPONSE_BYTES = 65535;

export type UpstreamTransport = 'classic' | 'doh';

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
    this.name = 'UpstreamError';
  }
}

/**
 * Parse an upstream spec.
 *
 * `1.1.1.1`, `1.1.1.1:5353` or `https://cloudflare-dns.com/dns-query`.
 * A bare address is classic DNS on port 53. `http://` is refused: DoH without
 * TLS is plaintext DNS with extra steps.
 */
export function parseUpstream(spec: string): UpstreamConfig {
  const trimmed = spec.trim();

  if (/^https:\/\//i.test(trimmed)) {
    return { transport: 'doh', address: trimmed };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    throw new Error(`unsupported upstream "${trimmed}": use an https:// DoH URL or an IP address`);
  }

  // IPv6 in brackets, optionally with a port: [2001:db8::1]:53
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (bracketed) {
    return {
      transport: 'classic',
      address: bracketed[1],
      port: bracketed[2] ? Number(bracketed[2]) : 53,
    };
  }

  // A bare IPv6 address contains colons but no port; only treat a single
  // trailing colon-number as a port.
  const withPort = /^([^:]+):(\d+)$/.exec(trimmed);
  if (withPort) {
    return { transport: 'classic', address: withPort[1], port: Number(withPort[2]) };
  }

  return { transport: 'classic', address: trimmed, port: 53 };
}

/** Send a query and return the raw wire response, carrying the query's own ID. */
export async function queryUpstream(upstream: UpstreamConfig, queryBuf: Buffer): Promise<Buffer> {
  return upstream.transport === 'doh'
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
  if (upstream.transport === 'doh') return queryDoh(upstream, queryBuf);
  return queryClassicTcp(upstream, queryBuf);
}

/**
 * Whether `response` is a response to `sent`: QR set, the expected ID, and
 * the same question (name compared case-insensitively).
 */
export function isResponseTo(response: Buffer, expectedId: number, sent: Buffer): boolean {
  if (response.byteLength < 12) return false;
  if (response.readUInt16BE(0) !== expectedId) return false;
  if ((response.readUInt16BE(2) & 0x8000) === 0) return false;
  const ours = questionOf(sent);
  const theirs = questionOf(response);
  return ours !== null && theirs !== null && ours.equals(theirs);
}

/** A copy of `buf` with its transaction ID replaced. */
function withId(buf: Buffer, id: number): Buffer {
  const out = Buffer.from(buf);
  out.writeUInt16BE(id, 0);
  return out;
}

function freshId(): number {
  return randomInt(0, 0x10000);
}

// ---------------------------------------------------------------------------
// Classic DNS
// ---------------------------------------------------------------------------

function queryClassicUdp(upstream: UpstreamConfig, queryBuf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const callerId = queryBuf.readUInt16BE(0);
    const wireId = freshId();
    const outgoing = withId(queryBuf, wireId);
    const port = upstream.port ?? 53;

    const socket = dgram.createSocket(net.isIPv6(upstream.address) ? 'udp6' : 'udp4');
    let settled = false;

    const finish = (err: Error | null, response?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else if (response) resolve(response);
    };

    const timer = setTimeout(
      () => finish(new UpstreamError('timed out', upstream.address)),
      QUERY_TIMEOUT_MS,
    );

    socket.on('message', (msg, rinfo) => {
      // The socket is connected, so the kernel already discards datagrams from
      // other sources; the explicit check keeps that true on any runtime.
      // (Address compared for IPv4 literals only: an IPv6 or hostname spec can
      // be spelled differently from the address the kernel reports.)
      if (rinfo.port !== port) return;
      if (net.isIPv4(upstream.address) && rinfo.address !== upstream.address) return;
      if (!isResponseTo(msg, wireId, outgoing)) return;
      finish(null, withId(Buffer.from(msg), callerId));
    });
    socket.on('error', (err) => finish(new UpstreamError(err.message, upstream.address)));
    socket.connect(port, upstream.address, () => {
      socket.send(outgoing, (err) => {
        if (err) finish(new UpstreamError(err.message, upstream.address));
      });
    });
  });
}

function queryClassicTcp(upstream: UpstreamConfig, queryBuf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const callerId = queryBuf.readUInt16BE(0);
    const wireId = freshId();
    const outgoing = withId(queryBuf, wireId);

    const socket = net.createConnection({
      host: upstream.address,
      port: upstream.port ?? 53,
    });

    // TCP DNS frames each message with a two-byte big-endian length prefix.
    const framed = Buffer.alloc(2 + outgoing.byteLength);
    framed.writeUInt16BE(outgoing.byteLength, 0);
    outgoing.copy(framed, 2);

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
      () => finish(new UpstreamError('timed out', upstream.address)),
      QUERY_TIMEOUT_MS,
    );

    socket.on('connect', () => socket.write(framed));
    socket.on('error', (err) => finish(new UpstreamError(err.message, upstream.address)));
    socket.on('close', () =>
      finish(new UpstreamError('closed before a complete response', upstream.address)),
    );

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > MAX_RESPONSE_BYTES + 2) {
        finish(
          new UpstreamError('response exceeded the maximum DNS message size', upstream.address),
        );
        return;
      }
      if (buffer.byteLength < 2) return;
      const length = buffer.readUInt16BE(0);
      if (buffer.byteLength < 2 + length) return;
      const message = Buffer.from(buffer.subarray(2, 2 + length));
      if (!isResponseTo(message, wireId, outgoing)) {
        finish(new UpstreamError('response does not match the query', upstream.address));
        return;
      }
      finish(null, withId(message, callerId));
    });
  });
}

// ---------------------------------------------------------------------------
// DNS-over-HTTPS (RFC 8484) — wire format, not the JSON API
// ---------------------------------------------------------------------------

async function queryDoh(upstream: UpstreamConfig, queryBuf: Buffer): Promise<Buffer> {
  // The message ID must be zero on DoH so responses are cacheable by HTTP
  // intermediaries (RFC 8484 §4.1). The caller's ID is restored on return.
  const callerId = queryBuf.readUInt16BE(0);
  const outgoing = withId(queryBuf, 0);

  // POST, not GET: a GET puts the query in the URL, where proxies and server
  // access logs keep it.
  const response = await fetch(upstream.address, {
    method: 'POST',
    headers: { 'content-type': DOH_CONTENT_TYPE, accept: DOH_CONTENT_TYPE },
    body: new Uint8Array(outgoing),
    redirect: 'error',
    signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamError(`returned HTTP ${response.status}`, upstream.address);
  }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.startsWith(DOH_CONTENT_TYPE)) {
    await response.body?.cancel().catch(() => undefined);
    // A JSON body here means the endpoint speaks the JSON API, not RFC 8484 —
    // a misconfiguration worth naming rather than failing to parse later.
    throw new UpstreamError(
      `returned content-type "${contentType}", expected ${DOH_CONTENT_TYPE}`,
      upstream.address,
    );
  }

  const body = await readCapped(response, upstream.address);
  if (!isResponseTo(body, 0, outgoing)) {
    throw new UpstreamError('response does not match the query', upstream.address);
  }

  return withId(body, callerId);
}

/** Read a response body, refusing to buffer more than one DNS message's worth. */
async function readCapped(response: Response, upstream: string): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamError('response exceeded the maximum DNS message size', upstream);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new UpstreamError('response exceeded the maximum DNS message size', upstream);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
