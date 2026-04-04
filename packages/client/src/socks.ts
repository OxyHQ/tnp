/**
 * SOCKS5 proxy for the TNP overlay network.
 *
 * Intercepts TCP connections to TNP domains and routes them through
 * encrypted tunnels via relay nodes.
 *
 * SOCKS5 protocol (RFC 1928):
 * 1. Greeting: client -> [0x05, nMethods, methods...]
 *    Reply:    server -> [0x05, 0x00] (no auth)
 * 2. Connect:  client -> [0x05, 0x01, 0x00, addrType, addr..., port]
 *    Reply:    server -> [0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0] (success)
 * 3. Data:     bidirectional pipe through tunnel
 */

import net from "net";
import type { TunnelManager } from "./tunnel";
import type { TnpApiClient } from "./api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SocksProxyConfig {
  port: number;
  host: string;
  tunnelManager: TunnelManager;
  apiClient: TnpApiClient;
  /** Cached overlay info lookup (from DnsProxy) */
  getOverlayInfo?: (domain: string) => { pubKey: string; relay: string } | undefined;
}

// ---------------------------------------------------------------------------
// SOCKS5 constants
// ---------------------------------------------------------------------------

const SOCKS_VERSION = 0x05;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const REP_SUCCESS = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_HOST_UNREACHABLE = 0x04;

// ---------------------------------------------------------------------------
// SocksProxy
// ---------------------------------------------------------------------------

export class SocksProxy {
  private server: net.Server;
  private tunnelManager: TunnelManager;
  private apiClient: TnpApiClient;
  private getOverlayInfo: ((domain: string) => { pubKey: string; relay: string } | undefined) | null;

  constructor(config: SocksProxyConfig) {
    this.tunnelManager = config.tunnelManager;
    this.apiClient = config.apiClient;
    this.getOverlayInfo = config.getOverlayInfo ?? null;

    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    this.server.on("error", (err: Error) => {
      console.error(`[socks] server error: ${err.message}`);
    });

    this.server.listen(config.port, config.host, () => {
      console.log(`[socks] SOCKS5 proxy listening on ${config.host}:${config.port}`);
    });
  }

  stop(): void {
    this.server.close();
  }

  // ---------- Connection handling ----------

  private handleConnection(socket: net.Socket): void {
    socket.once("error", (err: Error) => {
      if ((err as NodeJS.ErrnoException).code !== "ECONNRESET") {
        console.error(`[socks] socket error: ${err.message}`);
      }
    });

    // State machine: greeting -> request -> pipe
    let state: "greeting" | "request" | "piping" = "greeting";
    let buffer = Buffer.alloc(0);

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (state === "greeting") {
        if (!this.handleGreeting(socket, buffer)) return;
        buffer = Buffer.alloc(0);
        state = "request";
        return;
      }

      if (state === "request") {
        const result = this.parseRequest(buffer);
        if (!result) return; // need more data

        state = "piping";
        socket.removeListener("data", onData);

        this.handleConnect(socket, result.domain, result.port);
      }
    };

    socket.on("data", onData);
  }

  /**
   * Handle SOCKS5 greeting. Returns true if the greeting was consumed.
   */
  private handleGreeting(socket: net.Socket, buf: Buffer): boolean {
    // Minimum greeting: [version, nMethods, method0]
    if (buf.length < 3) return false;

    const version = buf[0];
    if (version !== SOCKS_VERSION) {
      socket.end();
      return false;
    }

    const nMethods = buf[1];
    if (buf.length < 2 + nMethods) return false;

    // Reply: no authentication required
    socket.write(Buffer.from([SOCKS_VERSION, 0x00]));
    return true;
  }

  /**
   * Parse SOCKS5 CONNECT request. Returns null if more data is needed.
   */
  private parseRequest(buf: Buffer): { domain: string; port: number } | null {
    // Minimum: version(1) + cmd(1) + rsv(1) + atyp(1) + addr(variable) + port(2)
    if (buf.length < 7) return null;

    const version = buf[0];
    const cmd = buf[1];
    // buf[2] is reserved
    const atyp = buf[3];

    if (version !== SOCKS_VERSION || cmd !== CMD_CONNECT) {
      return null;
    }

    let domain: string;
    let portOffset: number;

    if (atyp === ATYP_DOMAIN) {
      const domainLen = buf[4];
      if (buf.length < 5 + domainLen + 2) return null;
      domain = buf.subarray(5, 5 + domainLen).toString("utf-8");
      portOffset = 5 + domainLen;
    } else if (atyp === ATYP_IPV4) {
      if (buf.length < 10) return null;
      domain = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
      portOffset = 8;
    } else {
      // IPv6 or unsupported address type
      return null;
    }

    const port = buf.readUInt16BE(portOffset);
    return { domain, port };
  }

  /**
   * Handle a SOCKS5 CONNECT command by opening a tunnel to the domain.
   */
  private async handleConnect(
    socket: net.Socket,
    domain: string,
    port: number,
  ): Promise<void> {
    try {
      // Check overlay cache first (populated by DnsProxy)
      let overlayInfo = this.getOverlayInfo?.(domain);

      // If not cached, query the API directly
      if (!overlayInfo) {
        const nodeInfo = await this.apiClient.getServiceNode(domain);
        if (nodeInfo && nodeInfo.connectedRelay) {
          overlayInfo = {
            pubKey: nodeInfo.publicKey,
            relay: nodeInfo.connectedRelay,
          };
        }
      }

      if (!overlayInfo) {
        console.error(`[socks] no overlay info for ${domain}`);
        this.sendReply(socket, REP_HOST_UNREACHABLE);
        socket.end();
        return;
      }

      // Open a tunnel through the relay
      const circuit = await this.tunnelManager.openTunnel(
        overlayInfo.relay,
        domain,
        overlayInfo.pubKey,
      );

      // Send SOCKS5 success reply
      this.sendReply(socket, REP_SUCCESS);

      // Pipe: socket -> tunnel (encrypt & send)
      socket.on("data", (chunk: Buffer) => {
        circuit.send(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      });

      // Pipe: tunnel -> socket (receive & decrypt)
      circuit.onData((data: Uint8Array) => {
        if (!socket.destroyed) {
          socket.write(Buffer.from(data));
        }
      });

      // Clean up on close from either side
      socket.on("close", () => {
        circuit.close();
      });

      circuit.onClose(() => {
        if (!socket.destroyed) {
          socket.end();
        }
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[socks] tunnel error for ${domain}:${port}: ${msg}`);
      this.sendReply(socket, REP_GENERAL_FAILURE);
      socket.end();
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
      0x00,         // reserved
      ATYP_IPV4,    // address type: IPv4
      0, 0, 0, 0,   // bound address: 0.0.0.0
      0, 0,          // bound port: 0
    ]);
    socket.write(reply);
  }
}
