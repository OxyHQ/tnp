/**
 * Embedded relay node for the TNP overlay network.
 *
 * This is a lightweight relay that runs inside the compiled TNP client binary.
 * It accepts WebSocket connections from service nodes (/service?domain=...) and
 * clients (/tunnel), then routes binary frames between them using the same
 * protocol as apps/relay.
 *
 * The relay never decrypts payload content -- it only inspects frame headers
 * (circuitId + type) to route traffic.
 */

import { decodeFrame, encodeFrame, FrameType } from "./frames";
import type { TnpApiClient } from "./api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal WebSocket send interface. Bun.serve websockets expose `send()` and
 * `sendBinary()` but the shapes differ from the browser `WebSocket`. We wrap
 * them behind this interface so the routing logic stays type-safe.
 */
interface WsSender {
  sendBinary(data: ArrayBuffer | Uint8Array): void;
  close(): void;
}

interface Circuit {
  circuitId: number;
  clientWs: WsSender;
  domain: string;
  serviceWs: WsSender;
}

export interface RelayNodeStats {
  serviceNodes: number;
  activeCircuits: number;
  totalConnections: number;
  bytesRelayed: number;
  uptimeSeconds: number;
}

export interface RelayNodeConfig {
  port: number;
  host: string;
  maxConnections: number;
  authToken: string;
  location: string;
  apiBaseUrl: string;
}

// ---------------------------------------------------------------------------
// Connection Manager (embedded, no Bun server types)
// ---------------------------------------------------------------------------

class EmbeddedConnectionManager {
  private serviceNodes = new Map<string, WsSender>();
  private circuits = new Map<number, Circuit>();

  registerServiceNode(domain: string, ws: WsSender): void {
    const existing = this.serviceNodes.get(domain);
    if (existing) {
      this.removeAllCircuitsForDomain(domain);
    }
    this.serviceNodes.set(domain, ws);
  }

  removeServiceNode(domain: string): void {
    this.serviceNodes.delete(domain);
    this.removeAllCircuitsForDomain(domain);
  }

  hasServiceNode(domain: string): boolean {
    return this.serviceNodes.has(domain);
  }

  getServiceNode(domain: string): WsSender | undefined {
    return this.serviceNodes.get(domain);
  }

  openCircuit(
    circuitId: number,
    clientWs: WsSender,
    domain: string,
  ): boolean {
    const serviceWs = this.serviceNodes.get(domain);
    if (!serviceWs) return false;

    if (this.circuits.has(circuitId)) {
      this.closeCircuit(circuitId);
    }

    this.circuits.set(circuitId, { circuitId, clientWs, domain, serviceWs });
    return true;
  }

  getCircuit(circuitId: number): Circuit | undefined {
    return this.circuits.get(circuitId);
  }

  closeCircuit(circuitId: number): void {
    this.circuits.delete(circuitId);
  }

  removeAllCircuitsForSocket(ws: WsSender): number {
    let removed = 0;
    for (const [id, circuit] of this.circuits) {
      if (circuit.clientWs === ws || circuit.serviceWs === ws) {
        this.circuits.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get serviceNodeCount(): number {
    return this.serviceNodes.size;
  }

  get circuitCount(): number {
    return this.circuits.size;
  }

  private removeAllCircuitsForDomain(domain: string): void {
    for (const [id, circuit] of this.circuits) {
      if (circuit.domain === domain) {
        this.circuits.delete(id);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Relay Node
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class RelayNode {
  private manager = new EmbeddedConnectionManager();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  private totalConnections = 0;
  private bytesRelayed = 0;
  private relayId: string | null = null;
  private running = false;

  constructor(private config: RelayNodeConfig) {}

  get isRunning(): boolean {
    return this.running;
  }

  getStats(): RelayNodeStats {
    return {
      serviceNodes: this.manager.serviceNodeCount,
      activeCircuits: this.manager.circuitCount,
      totalConnections: this.totalConnections,
      bytesRelayed: this.bytesRelayed,
      uptimeSeconds: this.startTime > 0 ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
    };
  }

  async start(apiClient: TnpApiClient): Promise<void> {
    if (this.running) {
      throw new Error("Relay node is already running");
    }

    this.startTime = Date.now();
    this.running = true;

    // Register with the API
    if (this.config.authToken) {
      try {
        const result = await apiClient.registerRelay(
          this.config.port,
          this.config.location,
          this.config.authToken,
        );
        this.relayId = result.relayId;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to register relay: ${msg}`);
      }
    }

    // Start the WebSocket server using Bun.serve
    const manager = this.manager;
    const trackBytes = (n: number): void => {
      this.bytesRelayed += n;
    };
    const trackConnection = (): void => {
      this.totalConnections++;
    };
    const maxConn = this.config.maxConnections;

    this.server = Bun.serve({
      hostname: this.config.host,
      port: this.config.port,

      fetch(req, server) {
        const url = new URL(req.url);

        if (url.pathname === "/service") {
          const domain = url.searchParams.get("domain")?.trim().toLowerCase();
          if (!domain) {
            return new Response("Missing ?domain query parameter", { status: 400 });
          }
          const upgraded = server.upgrade(req, { data: { type: "service" as const, domain } });
          if (!upgraded) {
            return new Response("WebSocket upgrade failed", { status: 500 });
          }
          return undefined;
        }

        if (url.pathname === "/tunnel") {
          if (manager.circuitCount >= maxConn) {
            return new Response("Max connections reached", { status: 503 });
          }
          const upgraded = server.upgrade(req, { data: { type: "client" as const } });
          if (!upgraded) {
            return new Response("WebSocket upgrade failed", { status: 500 });
          }
          return undefined;
        }

        if (url.pathname === "/health") {
          return Response.json({ ok: true, service: "tnp-relay-node" });
        }

        if (url.pathname === "/stats") {
          return Response.json({
            serviceNodes: manager.serviceNodeCount,
            activeCircuits: manager.circuitCount,
          });
        }

        return new Response("Not Found", { status: 404 });
      },

      websocket: {
        perMessageDeflate: false,

        open(ws) {
          trackConnection();
          const data = ws.data as { type: string; domain?: string };
          if (data.type === "service" && data.domain) {
            manager.registerServiceNode(data.domain, ws);
          }
        },

        message(ws, raw) {
          const bytes = toUint8Array(raw);
          trackBytes(bytes.byteLength);

          let frame;
          try {
            frame = decodeFrame(bytes);
          } catch {
            return;
          }

          const data = ws.data as { type: string; domain?: string };

          if (data.type === "service") {
            handleServiceMessage(manager, ws, frame);
          } else {
            handleClientMessage(manager, ws, frame);
          }
        },

        close(ws) {
          const data = ws.data as { type: string; domain?: string };
          if (data.type === "service" && data.domain) {
            manager.removeServiceNode(data.domain);
          } else {
            manager.removeAllCircuitsForSocket(ws);
          }
        },
      },
    });

    // Start heartbeat if registered
    if (this.relayId && this.config.authToken) {
      this.heartbeatTimer = setInterval(() => {
        if (this.relayId) {
          apiClient
            .sendRelayHeartbeat(
              this.relayId,
              {
                serviceNodes: this.manager.serviceNodeCount,
                activeCircuits: this.manager.circuitCount,
              },
              this.config.authToken,
            )
            .catch(() => {
              // Heartbeat failure is non-fatal
            });
        }
      }, 30_000);
    }
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.server) {
      this.server.stop();
      this.server = null;
    }
    this.running = false;
    this.relayId = null;
  }
}

// ---------------------------------------------------------------------------
// Frame routing
// ---------------------------------------------------------------------------

function toUint8Array(data: string | Buffer | ArrayBuffer | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return textEncoder.encode(data as string);
}

function sendError(ws: WsSender, circuitId: number, message: string): void {
  const payload = textEncoder.encode(message);
  ws.sendBinary(encodeFrame(circuitId, FrameType.ERROR, payload));
}

function handleClientMessage(
  manager: EmbeddedConnectionManager,
  clientWs: WsSender,
  frame: { circuitId: number; type: FrameType; payload: Uint8Array },
): void {
  switch (frame.type) {
    case FrameType.OPEN: {
      const domain = textDecoder.decode(frame.payload).trim().toLowerCase();
      if (!domain) {
        sendError(clientWs, frame.circuitId, "Empty domain in OPEN frame");
        return;
      }

      if (!manager.hasServiceNode(domain)) {
        sendError(clientWs, frame.circuitId, `No service node for domain: ${domain}`);
        return;
      }

      const opened = manager.openCircuit(frame.circuitId, clientWs, domain);
      if (!opened) {
        sendError(clientWs, frame.circuitId, `Failed to open circuit to ${domain}`);
        return;
      }

      clientWs.sendBinary(encodeFrame(frame.circuitId, FrameType.OPENED, new Uint8Array(0)));

      const serviceWs = manager.getServiceNode(domain);
      if (serviceWs) {
        serviceWs.sendBinary(encodeFrame(frame.circuitId, FrameType.OPEN, frame.payload));
      }
      break;
    }

    case FrameType.DATA: {
      const circuit = manager.getCircuit(frame.circuitId);
      if (!circuit) {
        sendError(clientWs, frame.circuitId, "Unknown circuit");
        return;
      }
      circuit.serviceWs.sendBinary(encodeFrame(frame.circuitId, FrameType.DATA, frame.payload));
      break;
    }

    case FrameType.CLOSE: {
      const circuit = manager.getCircuit(frame.circuitId);
      if (circuit) {
        circuit.serviceWs.sendBinary(encodeFrame(frame.circuitId, FrameType.CLOSE, new Uint8Array(0)));
      }
      manager.closeCircuit(frame.circuitId);
      break;
    }

    default:
      sendError(clientWs, frame.circuitId, "Unexpected frame type from client");
  }
}

function handleServiceMessage(
  manager: EmbeddedConnectionManager,
  _serviceWs: WsSender,
  frame: { circuitId: number; type: FrameType; payload: Uint8Array },
): void {
  const circuit = manager.getCircuit(frame.circuitId);
  if (!circuit) return;

  switch (frame.type) {
    case FrameType.DATA:
      circuit.clientWs.sendBinary(encodeFrame(frame.circuitId, FrameType.DATA, frame.payload));
      break;

    case FrameType.CLOSE:
      circuit.clientWs.sendBinary(encodeFrame(frame.circuitId, FrameType.CLOSE, new Uint8Array(0)));
      manager.closeCircuit(frame.circuitId);
      break;

    case FrameType.ERROR:
      circuit.clientWs.sendBinary(encodeFrame(frame.circuitId, FrameType.ERROR, frame.payload));
      break;

    default:
      break;
  }
}
