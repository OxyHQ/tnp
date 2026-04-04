/**
 * WebSocket tunnel manager.
 *
 * Manages WebSocket connections to relay nodes and multiplexes circuits.
 * Each relay connection can carry multiple circuits identified by circuitId.
 * Data is encrypted end-to-end between the client and the service node using
 * NaCl X25519 key exchange + XSalsa20-Poly1305 symmetric encryption.
 *
 * Uses Bun's built-in global WebSocket (no ws dependency needed).
 */

import {
  generateEphemeralKeypair,
  computeSharedKey,
  encrypt,
  decrypt,
  fromBase64,
  toBase64,
} from "./crypto";
import { encodeFrame, decodeFrame, FrameType } from "./frames";

const OPEN_TIMEOUT_MS = 10_000;
const RELAY_CONNECT_TIMEOUT_MS = 8_000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// TunnelCircuit
// ---------------------------------------------------------------------------

export class TunnelCircuit {
  readonly circuitId: number;
  private relayWs: WebSocket;
  private sharedKey: Uint8Array;
  private dataHandler: ((data: Uint8Array) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private closed = false;

  constructor(circuitId: number, relayWs: WebSocket, sharedKey: Uint8Array) {
    this.circuitId = circuitId;
    this.relayWs = relayWs;
    this.sharedKey = sharedKey;
  }

  /**
   * Send data through the tunnel (encrypts with shared key, wraps in frame).
   */
  send(data: Uint8Array): void {
    if (this.closed) return;
    const encrypted = encrypt(data, this.sharedKey);
    const frame = encodeFrame(this.circuitId, FrameType.DATA, encrypted);
    this.relayWs.send(frame);
  }

  /**
   * Set handler for incoming data (decrypted).
   */
  onData(handler: (data: Uint8Array) => void): void {
    this.dataHandler = handler;
  }

  /**
   * Set handler for circuit close.
   */
  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  /**
   * Close this circuit. Sends a CLOSE frame to the relay.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      const frame = encodeFrame(this.circuitId, FrameType.CLOSE, new Uint8Array(0));
      this.relayWs.send(frame);
    } catch {
      // WebSocket may already be closed; that is fine
    }
    this.closeHandler?.();
  }

  /** @internal -- called by TunnelManager when a DATA frame arrives */
  _deliverData(encrypted: Uint8Array): void {
    if (this.closed) return;
    try {
      const plain = decrypt(encrypted, this.sharedKey);
      this.dataHandler?.(plain);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[tunnel] circuit ${this.circuitId} decryption error: ${msg}`);
    }
  }

  /** @internal -- called by TunnelManager on remote close */
  _deliverClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeHandler?.();
  }
}

// ---------------------------------------------------------------------------
// Pending open callback
// ---------------------------------------------------------------------------

interface PendingOpen {
  resolve: (circuit: TunnelCircuit) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// TunnelManager
// ---------------------------------------------------------------------------

export class TunnelManager {
  /** relay endpoint -> WebSocket */
  private relayConnections = new Map<string, WebSocket>();

  /** circuitId -> TunnelCircuit */
  private circuits = new Map<number, TunnelCircuit>();

  /** circuitId -> pending open callback (waiting for OPENED/ERROR) */
  private pendingOpens = new Map<number, PendingOpen>();

  private nextCircuitId = 1;

  /**
   * Open a new tunnel to a domain through a relay.
   *
   * Flow:
   * 1. Get or create a WebSocket connection to the relay (/tunnel)
   * 2. Generate an ephemeral X25519 keypair
   * 3. Compute shared key with the service node's public key
   * 4. Send an OPEN frame: payload = domain + \0 + base64(ephemeralPubKey)
   * 5. Wait for OPENED or ERROR response
   * 6. Return a TunnelCircuit
   */
  async openTunnel(
    relayEndpoint: string,
    domain: string,
    serviceNodePubKeyBase64: string,
  ): Promise<TunnelCircuit> {
    const ws = await this.getOrCreateRelay(relayEndpoint);
    const circuitId = this.nextCircuitId++;

    // Key exchange: ephemeral X25519 keypair
    const ephemeral = generateEphemeralKeypair();
    const serviceNodePubKey = fromBase64(serviceNodePubKeyBase64);
    const sharedKey = computeSharedKey(ephemeral.secretKey, serviceNodePubKey);

    // Build OPEN payload: domain\0base64(ephemeralPublicKey)
    const openPayload = textEncoder.encode(
      `${domain}\0${toBase64(ephemeral.publicKey)}`,
    );

    const circuit = new TunnelCircuit(circuitId, ws, sharedKey);
    this.circuits.set(circuitId, circuit);

    // Send OPEN frame and wait for OPENED or ERROR
    return new Promise<TunnelCircuit>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingOpens.delete(circuitId);
        this.circuits.delete(circuitId);
        reject(new Error(`Tunnel open timed out for ${domain} (circuit ${circuitId})`));
      }, OPEN_TIMEOUT_MS);

      this.pendingOpens.set(circuitId, { resolve, reject, timer });
      ws.send(encodeFrame(circuitId, FrameType.OPEN, openPayload));
    });
  }

  /**
   * Close a specific tunnel by circuitId.
   */
  closeTunnel(circuitId: number): void {
    const circuit = this.circuits.get(circuitId);
    if (circuit) {
      circuit.close();
      this.circuits.delete(circuitId);
    }
  }

  /**
   * Close all tunnels and relay connections.
   */
  shutdown(): void {
    for (const [id, circuit] of this.circuits) {
      circuit.close();
      this.circuits.delete(id);
    }
    for (const pending of this.pendingOpens.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("TunnelManager shutting down"));
    }
    this.pendingOpens.clear();
    for (const [endpoint, ws] of this.relayConnections) {
      ws.close();
      this.relayConnections.delete(endpoint);
    }
  }

  // ---- Internal helpers ----

  private getOrCreateRelay(endpoint: string): Promise<WebSocket> {
    const existing = this.relayConnections.get(endpoint);
    if (existing && existing.readyState === WebSocket.OPEN) {
      return Promise.resolve(existing);
    }

    // Clean up stale connection if any
    if (existing) {
      existing.close();
      this.relayConnections.delete(endpoint);
    }

    const tunnelUrl = endpoint.replace(/\/$/, "") + "/tunnel";
    const ws = new WebSocket(tunnelUrl);
    ws.binaryType = "arraybuffer";

    return new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        this.relayConnections.delete(endpoint);
        reject(new Error(`Relay connection timed out: ${endpoint}`));
      }, RELAY_CONNECT_TIMEOUT_MS);

      ws.addEventListener("open", () => {
        clearTimeout(timer);
        this.relayConnections.set(endpoint, ws);

        // Install global message handler for circuit dispatch
        ws.addEventListener("message", (event: MessageEvent) => {
          this.dispatchFrame(event.data);
        });

        ws.addEventListener("close", () => {
          this.relayConnections.delete(endpoint);
          // Close all circuits on this relay
          for (const [id, circuit] of this.circuits) {
            if (circuit["relayWs"] === ws) {
              circuit._deliverClose();
              this.circuits.delete(id);
            }
          }
        });

        resolve(ws);
      });

      ws.addEventListener("error", () => {
        clearTimeout(timer);
        this.relayConnections.delete(endpoint);
        reject(new Error(`Failed to connect to relay ${endpoint}`));
      });
    });
  }

  private dispatchFrame(data: unknown): void {
    const bytes = toUint8Array(data);
    if (bytes.byteLength === 0) return;

    let frame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      return;
    }

    // Check if this is a response to a pending open
    const pending = this.pendingOpens.get(frame.circuitId);
    if (pending) {
      if (frame.type === FrameType.OPENED) {
        clearTimeout(pending.timer);
        this.pendingOpens.delete(frame.circuitId);
        const circuit = this.circuits.get(frame.circuitId);
        if (circuit) {
          pending.resolve(circuit);
        }
        return;
      }
      if (frame.type === FrameType.ERROR) {
        clearTimeout(pending.timer);
        this.pendingOpens.delete(frame.circuitId);
        this.circuits.delete(frame.circuitId);
        const errMsg = textDecoder.decode(bytes.subarray(5));
        pending.reject(new Error(`Relay error for circuit ${frame.circuitId}: ${errMsg}`));
        return;
      }
    }

    // Dispatch to existing circuit
    const circuit = this.circuits.get(frame.circuitId);
    if (!circuit) return;

    switch (frame.type) {
      case FrameType.DATA:
        circuit._deliverData(frame.payload);
        break;
      case FrameType.CLOSE:
        circuit._deliverClose();
        this.circuits.delete(frame.circuitId);
        break;
      case FrameType.ERROR: {
        const msg = textDecoder.decode(frame.payload);
        console.error(`[tunnel] circuit ${frame.circuitId} error: ${msg}`);
        circuit._deliverClose();
        this.circuits.delete(frame.circuitId);
        break;
      }
      default:
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toUint8Array(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  if (Buffer.isBuffer(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array(0);
}
