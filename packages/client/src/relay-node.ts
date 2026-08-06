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

import { decodeFrame, encodeFrame, FrameType } from "@tnp/protocol";
import {
  normalizeRelayEndpoint,
  parseRegisterRelayRequest,
  type RegisterRelayRequest,
} from "@tnp/shared-types";
import type { TnpApiClient } from "./api";
import { loadOrCreateIdentity, toBase64 } from "./crypto";

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
  /**
   * The public `ws://` or `wss://` URL other people's clients dial.
   *
   * Not derivable from `host`/`port`: those are the bind address, which is
   * `0.0.0.0` by default and says nothing about the name, port or TLS
   * termination the relay is actually reachable through. The registry
   * publishes this value verbatim in the directory, so guessing it would
   * publish a relay at an address that is not serving.
   */
  endpoint: string;
  maxConnections: number;
  /** Advertised bandwidth ceiling in Mbit/s. 0 means the operator states none. */
  bandwidth: number;
  authToken: string;
  location: string;
  apiBaseUrl: string;
  identityKeyPath: string;
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

/** How often a registered relay tells the registry it is still serving. */
const HEARTBEAT_INTERVAL_MS = 30_000;

export class RelayNode {
  private manager = new EmbeddedConnectionManager();
  private server: ReturnType<typeof Bun.serve> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  private totalConnections = 0;
  private bytesRelayed = 0;
  /** Canonical endpoint the registry accepted, and the key the heartbeat uses. */
  private registeredEndpoint: string | null = null;
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

  /**
   * Build this relay's registration request.
   *
   * Separate from `start` so the request can be validated — and rejected —
   * before the listener binds a port. It is typed as the API's own contract
   * and then run through the API's own parser, so a field this relay stops
   * sending is a typecheck failure and a value the registry would refuse is a
   * local error naming the field, not a 400 from a round trip.
   */
  private buildRegistration(): RegisterRelayRequest {
    const endpoint = normalizeRelayEndpoint(this.config.endpoint);
    if (endpoint === null) {
      throw new Error(
        `Cannot register relay: endpoint ${JSON.stringify(this.config.endpoint)} is not a ws:// or wss:// URL. ` +
          "Set the public URL clients dial, e.g. --endpoint wss://relay.example.com",
      );
    }

    const identity = loadOrCreateIdentity(this.config.identityKeyPath);

    const request: RegisterRelayRequest = {
      endpoint,
      publicKey: toBase64(identity.publicKey),
      // A relay run from the `tnp` binary is community-operated by definition.
      // The registry currently takes this claim on trust; authenticating it is
      // relay authentication, which is Phase 3 work (docs/architecture/relays.md §2).
      operator: "community",
      capacity: {
        maxConnections: this.config.maxConnections,
        bandwidth: this.config.bandwidth,
      },
      location: this.config.location,
    };

    const parsed = parseRegisterRelayRequest(request);
    if (!parsed.ok) {
      throw new Error(`Cannot register relay: ${parsed.error}`);
    }
    return parsed.value;
  }

  async start(apiClient: TnpApiClient): Promise<void> {
    if (this.running) {
      throw new Error("Relay node is already running");
    }

    // Register with the API before binding anything. A relay that cannot be
    // published is not a relay anyone can reach, and failing here leaves the
    // node stopped rather than listening-but-invisible.
    if (this.config.authToken) {
      const request = this.buildRegistration();
      try {
        const registration = await apiClient.registerRelay(request, this.config.authToken);
        this.registeredEndpoint = registration.endpoint;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to register relay: ${msg}`);
      }
    }

    this.startTime = Date.now();
    this.running = true;

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
    const registeredEndpoint = this.registeredEndpoint;
    if (registeredEndpoint && this.config.authToken) {
      this.heartbeatTimer = setInterval(() => {
        apiClient
          .sendRelayHeartbeat(registeredEndpoint, this.config.authToken)
          .catch((err: unknown) => {
            // A missed heartbeat is not fatal — the registry degrades the relay
            // and it recovers on the next one — but a run of them means the
            // relay is quietly dropping out of the directory, so say so.
            console.warn(
              `[relay] heartbeat failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }, HEARTBEAT_INTERVAL_MS);
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
    this.registeredEndpoint = null;
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
