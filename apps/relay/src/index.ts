import type { ServerWebSocket } from "bun";
import { ConnectionManager, type ClientData, type ServiceNodeData } from "./connections.js";
import { decodeFrame, encodeFrame, FrameType } from "./frames.js";

const RELAY_PORT = Number(process.env.RELAY_PORT) || 8080;
const RELAY_HOST = process.env.RELAY_HOST ?? "0.0.0.0";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const manager = new ConnectionManager();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toUint8Array(data: string | Buffer | ArrayBuffer | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Buffer.isBuffer(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // String — shouldn't happen for binary WS, but handle gracefully
  return textEncoder.encode(data);
}

function sendError(ws: ServerWebSocket<ClientData>, circuitId: number, message: string): void {
  const payload = textEncoder.encode(message);
  ws.sendBinary(encodeFrame(circuitId, FrameType.ERROR, payload));
}

// ---------------------------------------------------------------------------
// HTTP routing + WebSocket upgrade
// ---------------------------------------------------------------------------

type WsData = ClientData | ServiceNodeData;

const server = Bun.serve<WsData>({
  hostname: RELAY_HOST,
  port: RELAY_PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    // --- WebSocket upgrade paths ---

    if (url.pathname === "/service") {
      const domain = url.searchParams.get("domain")?.trim().toLowerCase();
      if (!domain) {
        return new Response("Missing ?domain query parameter", { status: 400 });
      }
      const upgraded = server.upgrade<ServiceNodeData>(req, {
        data: { domain },
      });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 500 });
      }
      return undefined;
    }

    if (url.pathname === "/tunnel") {
      const upgraded = server.upgrade<ClientData>(req, {
        data: { type: "client" as const },
      });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 500 });
      }
      return undefined;
    }

    // --- HTTP endpoints ---

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "tnp-relay" });
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
    // Accept binary frames
    perMessageDeflate: false,

    open(ws: ServerWebSocket<WsData>) {
      const data = ws.data;
      if ("domain" in data) {
        // Service node connected
        manager.registerServiceNode(data.domain, ws as ServerWebSocket<ServiceNodeData>);
      } else {
        console.log("[relay] client connected");
      }
    },

    message(ws: ServerWebSocket<WsData>, raw: string | Buffer) {
      const bytes = toUint8Array(raw);

      let frame;
      try {
        frame = decodeFrame(bytes);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Malformed frame";
        console.log(`[relay] dropping malformed frame: ${message}`);
        return;
      }

      const data = ws.data;

      // ----- Service node messages -----
      if ("domain" in data) {
        handleServiceNodeMessage(ws as ServerWebSocket<ServiceNodeData>, frame);
        return;
      }

      // ----- Client messages -----
      handleClientMessage(ws as ServerWebSocket<ClientData>, frame);
    },

    close(ws: ServerWebSocket<WsData>) {
      const data = ws.data;
      if ("domain" in data) {
        manager.removeServiceNode(data.domain);
      } else {
        console.log("[relay] client disconnected");
        manager.removeAllCircuits(ws);
      }
    },
  },
});

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

function handleClientMessage(
  clientWs: ServerWebSocket<ClientData>,
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

      // Confirm to the client
      clientWs.sendBinary(
        encodeFrame(frame.circuitId, FrameType.OPENED, new Uint8Array(0)),
      );

      // Notify the service node that a new circuit was opened
      const serviceWs = manager.getServiceNode(domain);
      if (serviceWs) {
        serviceWs.sendBinary(
          encodeFrame(frame.circuitId, FrameType.OPEN, frame.payload),
        );
      }
      break;
    }

    case FrameType.DATA: {
      const circuit = manager.getCircuit(frame.circuitId);
      if (!circuit) {
        sendError(clientWs, frame.circuitId, "Unknown circuit");
        return;
      }
      // Forward encrypted payload to the service node with the same circuitId
      circuit.serviceWs.sendBinary(
        encodeFrame(frame.circuitId, FrameType.DATA, frame.payload),
      );
      break;
    }

    case FrameType.CLOSE: {
      const circuit = manager.getCircuit(frame.circuitId);
      if (circuit) {
        // Notify the service node
        circuit.serviceWs.sendBinary(
          encodeFrame(frame.circuitId, FrameType.CLOSE, new Uint8Array(0)),
        );
      }
      manager.closeCircuit(frame.circuitId);
      break;
    }

    default: {
      sendError(clientWs, frame.circuitId, "Unexpected frame type from client");
    }
  }
}

function handleServiceNodeMessage(
  _serviceWs: ServerWebSocket<ServiceNodeData>,
  frame: { circuitId: number; type: FrameType; payload: Uint8Array },
): void {
  const circuit = manager.getCircuit(frame.circuitId);
  if (!circuit) {
    // Circuit may have already been closed by the client
    return;
  }

  switch (frame.type) {
    case FrameType.DATA: {
      // Forward encrypted payload back to the client
      circuit.clientWs.sendBinary(
        encodeFrame(frame.circuitId, FrameType.DATA, frame.payload),
      );
      break;
    }

    case FrameType.CLOSE: {
      // Service node wants to close the circuit
      circuit.clientWs.sendBinary(
        encodeFrame(frame.circuitId, FrameType.CLOSE, new Uint8Array(0)),
      );
      manager.closeCircuit(frame.circuitId);
      break;
    }

    case FrameType.ERROR: {
      // Forward error to client
      circuit.clientWs.sendBinary(
        encodeFrame(frame.circuitId, FrameType.ERROR, frame.payload),
      );
      break;
    }

    default: {
      // Ignore unexpected frame types from service nodes
    }
  }
}

console.log(`[relay] TNP Relay Server listening on ${RELAY_HOST}:${RELAY_PORT}`);

export { server };
