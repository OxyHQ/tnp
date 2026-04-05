/**
 * Service node mode for the TNP overlay network.
 *
 * When a user runs `tnp serve`, their machine becomes a service node that:
 * 1. Registers with the TNP API (publicKey for key exchange)
 * 2. Connects to a relay via WebSocket (/service?domain=...)
 * 3. Receives circuit OPEN frames with client ephemeral public keys
 * 4. Decrypts incoming DATA, forwards to a local TCP target
 * 5. Encrypts responses and sends back through the relay
 * 6. Sends heartbeats every 30 seconds
 */

import net from "net";
import {
  loadOrCreateIdentity,
  generateEphemeralKeypair,
  computeSharedKey,
  encrypt,
  decrypt,
  toBase64,
  fromBase64,
} from "./crypto";
import { encodeFrame, decodeFrame, FrameType } from "./frames";
import type { TnpApiClient } from "./api";

const HEARTBEAT_INTERVAL_MS = 30_000;
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ServiceNodeConfig {
  domain: string;
  localTarget: string;
  apiBaseUrl: string;
  relayEndpoint: string;
  identityKeyPath: string;
  authToken: string;
}

interface CircuitState {
  circuitId: number;
  sharedKey: Uint8Array;
  localSocket: net.Socket | null;
}

// ---------------------------------------------------------------------------
// startServiceNode
// ---------------------------------------------------------------------------

export async function startServiceNode(
  config: ServiceNodeConfig,
  apiClient: TnpApiClient,
): Promise<void> {
  // 1. Load or create identity (Ed25519 for signing)
  const identity = loadOrCreateIdentity(config.identityKeyPath);
  console.log(`[service-node] identity public key: ${toBase64(identity.publicKey)}`);

  // 2. Generate a persistent X25519 keypair for key exchange
  //    (We derive it from the identity for determinism, or generate fresh)
  const x25519Keypair = generateEphemeralKeypair();
  const x25519PubKeyBase64 = toBase64(x25519Keypair.publicKey);
  console.log(`[service-node] X25519 public key (for clients): ${x25519PubKeyBase64}`);

  // 3. Register with the API
  const domainId = await registerWithApi(config, apiClient, x25519PubKeyBase64);
  console.log(`[service-node] registered for domain: ${config.domain} (id: ${domainId})`);

  // 4. Parse local target (use lastIndexOf to handle IPv6 addresses like [::1]:8080)
  const lastColon = config.localTarget.lastIndexOf(":");
  let targetHost: string;
  let targetPort: number;
  if (lastColon > 0) {
    targetHost = config.localTarget.substring(0, lastColon);
    targetPort = parseInt(config.localTarget.substring(lastColon + 1), 10);
  } else {
    targetHost = config.localTarget;
    targetPort = 80;
  }
  if (isNaN(targetPort) || targetPort < 1 || targetPort > 65535) {
    targetPort = 80;
  }
  console.log(`[service-node] forwarding to ${targetHost}:${targetPort}`);

  // 5. Connect to relay
  const circuits = new Map<number, CircuitState>();
  let reconnectDelay = RECONNECT_DELAY_MS;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function connectToRelay(): void {
    const serviceUrl =
      config.relayEndpoint.replace(/\/$/, "") +
      `/service?domain=${encodeURIComponent(config.domain)}`;

    console.log(`[service-node] connecting to relay: ${serviceUrl}`);
    const ws = new WebSocket(serviceUrl);
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      console.log("[service-node] connected to relay");
      reconnectDelay = RECONNECT_DELAY_MS;

      // Start heartbeats
      heartbeatTimer = setInterval(() => {
        apiClient
          .sendHeartbeat(domainId, config.relayEndpoint, config.authToken)
          .catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[service-node] heartbeat failed: ${msg}`);
          });
      }, HEARTBEAT_INTERVAL_MS);

      // Send first heartbeat immediately
      apiClient
        .sendHeartbeat(domainId, config.relayEndpoint, config.authToken)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[service-node] initial heartbeat failed: ${msg}`);
        });
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      const raw = event.data;
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(0);
      if (bytes.byteLength === 0) return;

      let frame;
      try {
        frame = decodeFrame(bytes);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[service-node] malformed frame: ${msg}`);
        return;
      }

      handleFrame(ws, frame, circuits, x25519Keypair, targetHost, targetPort);
    });

    ws.addEventListener("close", () => {
      console.log("[service-node] disconnected from relay");
      cleanupCircuits(circuits);

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      // Reconnect with exponential backoff
      console.log(`[service-node] reconnecting in ${reconnectDelay / 1000}s...`);
      setTimeout(connectToRelay, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    });

    ws.addEventListener("error", () => {
      // The close event will fire after this, triggering reconnect
    });
  }

  connectToRelay();

  // Keep the process alive
  process.on("SIGINT", () => {
    console.log("\n[service-node] shutting down...");
    cleanupCircuits(circuits);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    console.log("[service-node] shutting down...");
    cleanupCircuits(circuits);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    process.exit(0);
  });
}

// ---------------------------------------------------------------------------
// Frame handling
// ---------------------------------------------------------------------------

function handleFrame(
  ws: WebSocket,
  frame: { circuitId: number; type: FrameType; payload: Uint8Array },
  circuits: Map<number, CircuitState>,
  x25519Keypair: { publicKey: Uint8Array; secretKey: Uint8Array },
  targetHost: string,
  targetPort: number,
): void {
  switch (frame.type) {
    case FrameType.OPEN: {
      handleOpen(ws, frame.circuitId, frame.payload, circuits, x25519Keypair, targetHost, targetPort);
      break;
    }
    case FrameType.DATA: {
      handleData(ws, frame.circuitId, frame.payload, circuits);
      break;
    }
    case FrameType.CLOSE: {
      handleClose(frame.circuitId, circuits);
      break;
    }
    default:
      break;
  }
}

/**
 * Handle OPEN frame: extract client's ephemeral public key, compute shared key,
 * and open a TCP connection to the local target.
 */
function handleOpen(
  ws: WebSocket,
  circuitId: number,
  payload: Uint8Array,
  circuits: Map<number, CircuitState>,
  x25519Keypair: { publicKey: Uint8Array; secretKey: Uint8Array },
  targetHost: string,
  targetPort: number,
): void {
  // Parse payload: domain\0base64(clientEphemeralPubKey)
  const payloadStr = textDecoder.decode(payload);
  const nullIdx = payloadStr.indexOf("\0");

  if (nullIdx === -1) {
    console.error(`[service-node] OPEN frame for circuit ${circuitId}: missing key in payload`);
    const errPayload = textEncoder.encode("Missing ephemeral key in OPEN");
    ws.send(encodeFrame(circuitId, FrameType.ERROR, errPayload));
    return;
  }

  const domain = payloadStr.substring(0, nullIdx);
  const clientPubKeyBase64 = payloadStr.substring(nullIdx + 1);

  let clientPubKey: Uint8Array;
  try {
    clientPubKey = fromBase64(clientPubKeyBase64);
  } catch {
    console.error(`[service-node] OPEN frame for circuit ${circuitId}: invalid key encoding`);
    const errPayload = textEncoder.encode("Invalid ephemeral key encoding");
    ws.send(encodeFrame(circuitId, FrameType.ERROR, errPayload));
    return;
  }

  // Compute shared key
  const sharedKey = computeSharedKey(x25519Keypair.secretKey, clientPubKey);

  console.log(`[service-node] circuit ${circuitId} opened for ${domain}`);

  // Open TCP connection to local target
  const localSocket = net.createConnection({ host: targetHost, port: targetPort }, () => {
    console.log(`[service-node] circuit ${circuitId} -> ${targetHost}:${targetPort} connected`);
  });

  const state: CircuitState = { circuitId, sharedKey, localSocket };
  circuits.set(circuitId, state);

  // Local target -> encrypted -> relay
  localSocket.on("data", (chunk: Buffer) => {
    const encrypted = encrypt(
      new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      sharedKey,
    );
    ws.send(encodeFrame(circuitId, FrameType.DATA, encrypted));
  });

  localSocket.on("close", () => {
    circuits.delete(circuitId);
    ws.send(encodeFrame(circuitId, FrameType.CLOSE, new Uint8Array(0)));
  });

  localSocket.on("error", (err: Error) => {
    console.error(`[service-node] circuit ${circuitId} local error: ${err.message}`);
    circuits.delete(circuitId);
    const errPayload = textEncoder.encode(`Local connection error: ${err.message}`);
    ws.send(encodeFrame(circuitId, FrameType.ERROR, errPayload));
  });
}

/**
 * Handle DATA frame: decrypt and forward to local TCP target.
 */
function handleData(
  ws: WebSocket,
  circuitId: number,
  payload: Uint8Array,
  circuits: Map<number, CircuitState>,
): void {
  const state = circuits.get(circuitId);
  if (!state) return;

  try {
    const plaintext = decrypt(payload, state.sharedKey);
    state.localSocket?.write(Buffer.from(plaintext));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[service-node] circuit ${circuitId} decrypt error: ${msg}`);
    const errPayload = textEncoder.encode("Decryption failed");
    ws.send(encodeFrame(circuitId, FrameType.ERROR, errPayload));
  }
}

/**
 * Handle CLOSE frame: close the local TCP connection.
 */
function handleClose(
  circuitId: number,
  circuits: Map<number, CircuitState>,
): void {
  const state = circuits.get(circuitId);
  if (!state) return;

  console.log(`[service-node] circuit ${circuitId} closed by remote`);
  state.localSocket?.destroy();
  circuits.delete(circuitId);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanupCircuits(circuits: Map<number, CircuitState>): void {
  for (const [id, state] of circuits) {
    state.localSocket?.destroy();
    circuits.delete(id);
  }
}

/**
 * Register the service node with the TNP API.
 *
 * First looks up the domain to get its ID, then calls POST /nodes/register.
 * Returns the domain ID for use in heartbeats.
 */
async function registerWithApi(
  config: ServiceNodeConfig,
  apiClient: TnpApiClient,
  publicKey: string,
): Promise<string> {
  // Look up the domain to get its ID (the register endpoint requires domainId)
  const lookupUrl = `${config.apiBaseUrl}/domains/lookup/${encodeURIComponent(config.domain)}`;
  const lookupRes = await fetch(lookupUrl, {
    signal: AbortSignal.timeout(5000),
    headers: {
      Authorization: `Bearer ${config.authToken}`,
    },
  });

  if (!lookupRes.ok) {
    throw new Error(
      `Failed to look up domain ${config.domain}: ${lookupRes.status} ${lookupRes.statusText}`,
    );
  }

  const domainData = (await lookupRes.json()) as { _id: string };
  const domainId = domainData._id;

  // Register the service node
  await apiClient.registerServiceNode(domainId, publicKey, config.authToken);

  return domainId;
}
