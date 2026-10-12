/**
 * SOCKS5 proxy for the TNP overlay network.
 *
 * Accepts CONNECT requests for TNP-native names only and routes them through
 * encrypted tunnels via relay nodes. It is not a general-purpose proxy and
 * never contacts the TNP API about anything that is not a TNP name: it used to
 * look up EVERY destination with `GET /nodes/<host>`, so a browser pointed at
 * it reported the user's entire browsing history — public sites and IP
 * literals included — to the registry.
 *
 * SOCKS5 protocol (RFC 1928):
 * 1. Greeting: client -> [0x05, nMethods, methods...]
 *    Reply:    server -> [0x05, 0x00] (no auth), or [0x05, 0xFF] if the
 *              client did not offer "no auth"
 * 2. Connect:  client -> [0x05, 0x01, 0x00, addrType, addr..., port]
 *    Reply:    server -> [0x05, rep, 0x00, 0x01, 0,0,0,0, 0,0]
 * 3. Data:     bidirectional pipe through tunnel
 */

import net from 'node:net';
import { BUILTIN_NATIVE_TLDS, classifyName, type NamespaceType } from '@tnp/namespace';
import { ErrorCode } from '@tnp/protocol/v1';
import { pipeSocket } from './overlay/pipe';
import { OverlayVerificationError } from './overlay/verify';
import { type TunnelManager, TunnelError } from './tunnel';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SocksProxyConfig {
  port: number;
  /** Bind address. Defaults to loopback; anything else exposes the proxy. */
  host?: string;
  /** Opens verified end-to-end streams; resolves overlay info itself when no hint is given. */
  tunnelManager: Pick<TunnelManager, 'openStream'>;
  /**
   * The overlay block the DNS proxy already fetched for a name, if any. A hint
   * only: the tunnel manager verifies it exactly as if it came from the API.
   */
  getOverlayInfo?: (domain: string) => unknown | undefined;
  /**
   * Local, offline classification of a destination name. Defaults to the
   * built-in native TLD list; `tnp connect` passes the resolver's live table so
   * registry-approved TLDs work too.
   */
  classify?: (name: string) => NamespaceType;
}

// ---------------------------------------------------------------------------
// SOCKS5 constants
// ---------------------------------------------------------------------------

const SOCKS_VERSION = 0x05;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const METHOD_NO_AUTH = 0x00;
const METHOD_NONE_ACCEPTABLE = 0xff;
const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_NOT_ALLOWED = 0x02;
const REP_HOST_UNREACHABLE = 0x04;
const REP_COMMAND_NOT_SUPPORTED = 0x07;
const REP_ADDRESS_TYPE_NOT_SUPPORTED = 0x08;

/**
 * Most bytes accepted before the handshake completes. The largest legal
 * greeting is 257 bytes and the largest CONNECT 262, so a client that sends
 * more without completing either is not speaking SOCKS5.
 */
const MAX_HANDSHAKE_BYTES = 1024;

/** Give up on a client that has not finished the handshake in this long. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** A DNS hostname: letters, digits, hyphens and dots, at most 253 octets. */
const HOSTNAME_RE =
  /^(?=.{1,253}\.?$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{1,63}\.?$/i;

type ParsedRequest =
  | { kind: 'incomplete' }
  | { kind: 'connect'; domain: string; port: number; consumed: number }
  | { kind: 'reject'; rep: number };

type ParsedGreeting =
  | { kind: 'incomplete' }
  | { kind: 'bad-version' }
  | { kind: 'ok'; noAuthOffered: boolean; consumed: number };

/** Parse a SOCKS5 greeting from the start of `buf`. */
export function parseGreeting(buf: Buffer): ParsedGreeting {
  if (buf.length < 1) return { kind: 'incomplete' };
  if (buf[0] !== SOCKS_VERSION) return { kind: 'bad-version' };
  if (buf.length < 2) return { kind: 'incomplete' };
  const nMethods = buf[1];
  if (buf.length < 2 + nMethods) return { kind: 'incomplete' };
  const methods = buf.subarray(2, 2 + nMethods);
  return { kind: 'ok', noAuthOffered: methods.includes(METHOD_NO_AUTH), consumed: 2 + nMethods };
}

/**
 * Parse a SOCKS5 request from the start of `buf`.
 *
 * Anything other than CONNECT to a domain name is rejected with the reply
 * code RFC 1928 defines for it, as soon as the header says so — it does not
 * wait for (and buffer) the rest of a request it is going to refuse anyway.
 * IP literals are refused outright: an overlay destination is a TNP name, and
 * there is nothing an IP address could be looked up as.
 */
export function parseRequest(buf: Buffer): ParsedRequest {
  if (buf.length < 4) return { kind: 'incomplete' };
  if (buf[0] !== SOCKS_VERSION) return { kind: 'reject', rep: REP_GENERAL_FAILURE };
  if (buf[1] !== CMD_CONNECT) return { kind: 'reject', rep: REP_COMMAND_NOT_SUPPORTED };

  const atyp = buf[3];
  if (atyp === ATYP_IPV4 || atyp === ATYP_IPV6) return { kind: 'reject', rep: REP_NOT_ALLOWED };
  if (atyp !== ATYP_DOMAIN) return { kind: 'reject', rep: REP_ADDRESS_TYPE_NOT_SUPPORTED };

  if (buf.length < 5) return { kind: 'incomplete' };
  const domainLen = buf[4];
  const end = 5 + domainLen + 2;
  if (buf.length < end) return { kind: 'incomplete' };

  const domain = buf.subarray(5, 5 + domainLen).toString('latin1');
  const port = buf.readUInt16BE(5 + domainLen);
  return { kind: 'connect', domain, port, consumed: end };
}

// ---------------------------------------------------------------------------
// SocksProxy
// ---------------------------------------------------------------------------

export class SocksProxy {
  private server: net.Server;
  private tunnelManager: Pick<TunnelManager, 'openStream'>;
  private getOverlayInfo: ((domain: string) => unknown | undefined) | null;
  private classify: (name: string) => NamespaceType;
  /** Resolves once the listener is bound. */
  readonly ready: Promise<void>;

  constructor(config: SocksProxyConfig) {
    this.tunnelManager = config.tunnelManager;
    this.getOverlayInfo = config.getOverlayInfo ?? null;
    this.classify = config.classify ?? ((name) => classifyName(name, BUILTIN_NATIVE_TLDS));
    const host = config.host ?? '127.0.0.1';

    // Half-open, so an application that finishes sending can still receive the
    // whole response: its FIN becomes the circuit's FIN, not a teardown.
    this.server = net.createServer({ allowHalfOpen: true }, (socket) => {
      this.handleConnection(socket);
    });

    this.server.on('error', (err: Error) => {
      console.error(`[socks] server error: ${err.message}`);
    });

    this.ready = new Promise((resolve) => {
      this.server.listen(config.port, host, () => {
        console.log(`[socks] SOCKS5 proxy listening on ${host}:${this.port}`);
        resolve();
      });
    });
  }

  /** The bound port (useful when configured with port 0). */
  get port(): number {
    const address = this.server.address();
    return address && typeof address === 'object' ? address.port : 0;
  }

  stop(): void {
    this.server.close();
  }

  // ---------- Connection handling ----------

  private handleConnection(socket: net.Socket): void {
    socket.on('error', (err: Error) => {
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
        console.error(`[socks] socket error: ${err.message}`);
      }
    });

    // State machine: greeting -> request -> pipe. Every chunk is appended and
    // then consumed as far as possible, so a client that pipelines its CONNECT
    // behind the greeting in one packet is served, not stalled.
    let state: 'greeting' | 'request' | 'done' = 'greeting';
    let buffer = Buffer.alloc(0);
    const handshakeTimer = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS);
    socket.once('close', () => clearTimeout(handshakeTimer));

    const finishHandshake = () => {
      state = 'done';
      clearTimeout(handshakeTimer);
      socket.removeListener('data', onData);
    };

    const onData = (chunk: Buffer) => {
      if (state === 'done') return;
      buffer = Buffer.concat([buffer, chunk]);

      // Only an INCOMPLETE handshake is bounded: a complete CONNECT may arrive
      // in the same chunk as any amount of application data, which is early
      // data for the tunnel, not handshake.
      const stillIncomplete = () => {
        if (buffer.length <= MAX_HANDSHAKE_BYTES) return;
        finishHandshake();
        socket.destroy();
      };

      if (state === 'greeting') {
        const greeting = parseGreeting(buffer);
        if (greeting.kind === 'incomplete') return stillIncomplete();
        if (greeting.kind === 'bad-version') {
          finishHandshake();
          socket.destroy();
          return;
        }
        if (!greeting.noAuthOffered) {
          // RFC 1928 §3: no acceptable method. Picking "no auth" anyway would
          // speak a protocol the client did not agree to.
          finishHandshake();
          socket.end(Buffer.from([SOCKS_VERSION, METHOD_NONE_ACCEPTABLE]));
          return;
        }
        socket.write(Buffer.from([SOCKS_VERSION, METHOD_NO_AUTH]));
        buffer = buffer.subarray(greeting.consumed);
        state = 'request';
      }

      if (state === 'request') {
        const request = parseRequest(buffer);
        if (request.kind === 'incomplete') return stillIncomplete();
        finishHandshake();
        if (request.kind === 'reject') {
          this.refuse(socket, request.rep);
          return;
        }
        // Bytes the client sent after its CONNECT, before our reply: hold them
        // and the rest of the stream until the tunnel exists.
        socket.pause();
        const early = Buffer.from(buffer.subarray(request.consumed));
        buffer = Buffer.alloc(0);
        void this.handleConnect(socket, request.domain, request.port, early);
      }
    };

    socket.on('data', onData);
  }

  private refuse(socket: net.Socket, rep: number): void {
    this.sendReply(socket, rep);
    socket.end();
  }

  /**
   * Handle a SOCKS5 CONNECT by opening a tunnel to a TNP-native name.
   *
   * The destination is classified locally first. A name that is not TNP's
   * is refused with "not allowed by ruleset" and the API is never asked about
   * it. Only for a native name may the registry be asked where its service
   * node is.
   */
  private async handleConnect(
    socket: net.Socket,
    domain: string,
    port: number,
    early: Buffer,
  ): Promise<void> {
    if (!HOSTNAME_RE.test(domain) || this.classify(domain) !== 'tnp-native') {
      this.refuse(socket, REP_NOT_ALLOWED);
      return;
    }

    try {
      const circuit = await this.tunnelManager.openStream(
        domain,
        port,
        this.getOverlayInfo?.(domain),
      );
      if (socket.destroyed) {
        circuit.abort();
        return;
      }
      this.sendReply(socket, REP_SUCCESS);
      // Backpressure both ways; a failed circuit destroys the socket rather
      // than ending it, so the application never mistakes truncation for EOF.
      pipeSocket(socket, circuit, { early, abortCode: 0 });
    } catch (err) {
      if (socket.destroyed) return;
      if (err instanceof OverlayVerificationError) {
        if (err.reason === 'no-overlay' || err.reason === 'not-native') {
          // Not logged with the name: a proxy log is a browsing history.
          this.refuse(socket, REP_HOST_UNREACHABLE);
        } else {
          // A key that does not verify is a security event the user must see,
          // so this one does name the name.
          console.error(`[socks] ${err.message}`);
          this.refuse(socket, REP_NOT_ALLOWED);
        }
        return;
      }
      const unreachable =
        err instanceof TunnelError &&
        (err.code === ErrorCode.CIRCUIT_REJECTED ||
          err.code === ErrorCode.TARGET_UNREACHABLE ||
          err.code === ErrorCode.TARGET_REFUSED);
      console.error(`[socks] tunnel error: ${err instanceof Error ? err.message : 'error'}`);
      this.refuse(socket, unreachable ? REP_HOST_UNREACHABLE : REP_GENERAL_FAILURE);
    }
  }

  /**
   * Send a SOCKS5 reply.
   * Format: [0x05, rep, 0x00, 0x01, 0,0,0,0, 0,0]
   */
  private sendReply(socket: net.Socket, rep: number): void {
    const reply = Buffer.from([
      SOCKS_VERSION,
      rep,
      0x00, // reserved
      ATYP_IPV4, // address type: IPv4
      0,
      0,
      0,
      0, // bound address: 0.0.0.0
      0,
      0, // bound port: 0
    ]);
    if (!socket.destroyed) socket.write(reply);
  }
}
