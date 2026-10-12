/**
 * The client side of the overlay: verified end-to-end circuits to service
 * nodes, through relays.
 *
 * Normative spec: docs/architecture/transport.md §11.
 *
 *   openStream("www.example.ox", 443)
 *     1. derive the service name ("example.ox") locally
 *     2. get the overlay block (DNS cache hint or `/dns/resolve`)
 *     3. verify it: pin → rotation → grant chain → key-agreement certificate
 *        (overlay/verify.ts). A failure refuses the connection.
 *     4. CIRCUIT_CREATE {name, Noise msg1} on a relay connection, with a
 *        circuit id from the CSPRNG, connection-scoped
 *     5. CIRCUIT_CREATED {Noise msg2} from the SERVICE NODE → session; a
 *        relay answering on its own fails key confirmation here
 *     6. sealed OPEN(port) → sealed OPENED → a `SecureCircuit` to pipe
 *
 * Replaces a manager that numbered circuits from 1 in every process (audit
 * S1), derived one shared key for both directions from whatever key the API
 * returned (S3, S5), and never looked at its send buffer (S6).
 */

import type { VerifiedKeyAgreementKey } from '@tnp/crypto';
import {
  CircuitTable,
  ClientHandshake,
  decodeCircuitCreated,
  decodeDestroy,
  encodeCircuitCreate,
  encodeDestroy,
  encodeFrame,
  ERROR_CODE_NAMES,
  ErrorCode,
  type Frame,
  FrameType,
  generateCircuitId,
  HANDSHAKE_TIMEOUT_MS,
  MAX_CIRCUITS_PER_CONNECTION,
  MAX_PENDING_OPENS,
  SessionError,
} from '@tnp/protocol/v1';
import { normalizeRelayEndpoint } from '@tnp/shared-types';
import { FrameSocket } from './overlay/frame-socket';
import type { PinStore } from './overlay/pins';
import { SecureCircuit, type SecureCircuitHooks } from './overlay/secure-circuit';
import { OverlayVerificationError, serviceNameFor, verifyOverlay } from './overlay/verify';

const RELAY_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_LINKS_PER_RELAY = 8;
const LINK_IDLE_MS = 60_000;

/** A circuit could not be opened. `code` is a protocol error code where one applies. */
export class TunnelError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'TunnelError';
  }
}

export interface TunnelManagerOptions {
  pins: PinStore;
  /** Fetch the `/dns/resolve` overlay block for a destination; null when there is none. */
  resolveOverlay: (destination: string) => Promise<unknown | null>;
  /** Unix seconds. */
  now?: () => number;
  openTimeoutMs?: number;
  maxLinksPerRelay?: number;
  /**
   * Allow `ws://` relay endpoints that are not loopback. Off by default: the
   * session is end-to-end encrypted either way, but plaintext WebSocket shows
   * every network observer which name each circuit is for.
   */
  allowPlaintextRelay?: boolean;
}

type Entry =
  | {
      state: 'creating';
      handshake: ClientHandshake;
      hooks: SecureCircuitHooks;
      resolve: (circuit: SecureCircuit) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  | { state: 'open'; circuit: SecureCircuit };

/** One WebSocket to one relay, carrying up to MAX_CIRCUITS_PER_CONNECTION circuits. */
class RelayLink {
  readonly circuits = new CircuitTable<Entry>(MAX_CIRCUITS_PER_CONNECTION);
  private pending = 0;
  private socket: FrameSocket | null = null;
  closed = false;

  constructor(
    readonly endpoint: string,
    private readonly onGone: (link: RelayLink) => void,
  ) {}

  async connect(): Promise<void> {
    const { socket, ready } = FrameSocket.open(
      `${this.endpoint}/tunnel`,
      {
        onFrame: (frame) => this.dispatch(frame),
        onClose: () => this.teardown(),
        onDrain: () => {
          for (const [, entry] of this.circuits.entries()) {
            if (entry.state === 'open') entry.circuit.poke();
          }
        },
      },
      RELAY_CONNECT_TIMEOUT_MS,
    );
    this.socket = socket;
    await ready;
  }

  get hasCapacity(): boolean {
    return !this.closed && !this.circuits.atCapacity && this.pending < MAX_PENDING_OPENS;
  }

  openCircuit(
    name: string,
    key: VerifiedKeyAgreementKey,
    now: number,
    hooks: SecureCircuitHooks,
  ): Promise<SecureCircuit> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new TunnelError('relay link not connected'));
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const handshake = new ClientHandshake({ serverKey: key, name, now });
    let id = generateCircuitId();
    while (this.circuits.has(id)) id = generateCircuitId();

    return new Promise<SecureCircuit>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.forget(id);
        socket.send(
          encodeFrame({
            type: FrameType.CIRCUIT_DESTROY,
            circuitId: id,
            payload: encodeDestroy(0),
          }),
        );
        reject(
          new TunnelError('the service node did not answer in time', ErrorCode.TARGET_UNREACHABLE),
        );
      }, HANDSHAKE_TIMEOUT_MS);
      if (!this.circuits.add(id, { state: 'creating', handshake, hooks, resolve, reject, timer })) {
        clearTimeout(timer);
        reject(new TunnelError('relay connection is full', ErrorCode.CIRCUIT_LIMIT));
        return;
      }
      this.pending++;
      const sent = socket.send(
        encodeFrame({
          type: FrameType.CIRCUIT_CREATE,
          circuitId: id,
          payload: encodeCircuitCreate(name, handshake.start()),
        }),
      );
      if (!sent) {
        this.forget(id);
        clearTimeout(timer);
        reject(new TunnelError('relay connection lost'));
      }
    });
  }

  private forget(id: bigint): void {
    const entry = this.circuits.delete(id);
    if (entry?.state === 'creating') this.pending--;
    this.idleCheck();
  }

  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * A connection with no circuits is closed after a while: an idle connection
   * to a relay is still a visible fact about this client, and holds a slot.
   */
  private idleCheck(): void {
    if (this.closed || this.circuits.size > 0 || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.circuits.size === 0) this.close();
    }, LINK_IDLE_MS);
    this.idleTimer.unref?.();
  }

  private dispatch(frame: Frame): void {
    if (frame.circuitId === 0n) {
      // Connection-level: PING from the relay is answered; anything else from
      // an anonymous client's point of view is ignored.
      if (frame.type === FrameType.PING) {
        this.socket?.send(encodeFrame({ type: FrameType.PONG, payload: frame.payload }));
      }
      return;
    }
    const entry = this.circuits.get(frame.circuitId);
    if (!entry) return; // not ours (or already gone): dropped
    if (entry.state === 'open') {
      entry.circuit.receive(frame);
      return;
    }
    // Creating.
    if (frame.type === FrameType.CIRCUIT_DESTROY) {
      clearTimeout(entry.timer);
      this.forget(frame.circuitId);
      let code = 0;
      try {
        code = decodeDestroy(frame.payload);
      } catch {
        // malformed reason: treat as unspecified
      }
      entry.reject(new TunnelError(describeRefusal(code), code || undefined));
      return;
    }
    if (frame.type !== FrameType.CIRCUIT_CREATED) return;
    clearTimeout(entry.timer);
    this.pending--;
    let circuit: SecureCircuit;
    try {
      const session = entry.handshake.finish(decodeCircuitCreated(frame.payload));
      const socket = this.socket as FrameSocket;
      circuit = new SecureCircuit(
        frame.circuitId,
        session,
        { send: (f) => socket.send(f), congested: () => socket.congested() },
        'client',
        {
          ...entry.hooks,
          onDone: (error) => {
            this.circuits.delete(frame.circuitId);
            this.idleCheck();
            entry.hooks.onDone?.(error);
          },
        },
      );
    } catch (err) {
      this.circuits.delete(frame.circuitId);
      this.socket?.send(
        encodeFrame({
          type: FrameType.CIRCUIT_DESTROY,
          circuitId: frame.circuitId,
          payload: encodeDestroy(0),
        }),
      );
      const code = err instanceof SessionError ? err.code : ErrorCode.AUTH_FAILED;
      entry.reject(
        new TunnelError(
          'the service node failed key confirmation — whoever answered does not hold the certified key',
          code,
        ),
      );
      return;
    }
    this.circuits.delete(frame.circuitId);
    this.circuits.add(frame.circuitId, { state: 'open', circuit });
    entry.resolve(circuit);
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.circuits.drain()) {
      if (entry.state === 'creating') {
        clearTimeout(entry.timer);
        entry.reject(new TunnelError('relay connection lost'));
      } else {
        entry.circuit.remoteDestroyed();
      }
    }
    this.onGone(this);
  }

  close(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const [, entry] of this.circuits.entries()) {
      if (entry.state === 'open') entry.circuit.abort();
    }
    this.socket?.close();
    this.teardown();
  }
}

function describeRefusal(code: number): string {
  switch (code) {
    case ErrorCode.CIRCUIT_REJECTED:
      return 'the relay has no service node for this name';
    case ErrorCode.RATE_LIMIT:
      return 'the relay is rate limiting new circuits';
    case ErrorCode.CIRCUIT_LIMIT:
    case ErrorCode.RESOURCE_EXHAUSTED:
      return 'the relay is at capacity';
    case ErrorCode.TARGET_UNREACHABLE:
      return 'the service node did not answer';
    default:
      return `the circuit was refused (${ERROR_CODE_NAMES[code] ?? code})`;
  }
}

export class TunnelManager {
  private readonly links = new Map<string, RelayLink[]>();
  private readonly connecting = new Map<string, Promise<RelayLink>>();
  private readonly now: () => number;
  private readonly openTimeoutMs: number;
  private readonly maxLinks: number;

  constructor(private readonly options: TunnelManagerOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.openTimeoutMs = options.openTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.maxLinks = options.maxLinksPerRelay ?? DEFAULT_MAX_LINKS_PER_RELAY;
  }

  /**
   * Open a verified, end-to-end encrypted stream to `destination:port`.
   * Resolves once the service node has connected to its target. Throws
   * `OverlayVerificationError` when the key material does not verify — the
   * connection is never attempted — and `TunnelError` otherwise.
   */
  async openStream(
    destination: string,
    port: number,
    overlayHint?: unknown,
  ): Promise<SecureCircuit> {
    const name = serviceNameFor(destination);
    const overlay = overlayHint ?? (await this.options.resolveOverlay(destination));
    if (!overlay)
      throw new OverlayVerificationError('no-overlay', `${name} has no service node online`);
    const verified = verifyOverlay(name, overlay, this.options.pins, this.now());

    const endpoint = this.checkEndpoint(verified.relay);
    // Capacity is re-checked after every await and the circuit claimed in the
    // same synchronous step, so concurrent opens cannot overfill one link.
    let link = await this.linkFor(endpoint);
    for (let tries = 0; !link.hasCapacity; tries++) {
      if (tries > this.maxLinks)
        throw new TunnelError('relay connections are full', ErrorCode.CIRCUIT_LIMIT);
      link = await this.linkFor(endpoint);
    }
    let markOpened: () => void = () => {};
    let markFailed: (err: Error) => void = () => {};
    const opened = new Promise<void>((resolve, reject) => {
      markOpened = resolve;
      markFailed = reject;
    });
    const circuit = await link.openCircuit(name, verified.key, this.now(), {
      onOpened: () => markOpened(),
      onDone: (error) =>
        markFailed(
          new TunnelError(
            error
              ? `the service node refused the stream (${ERROR_CODE_NAMES[error.code] ?? error.code})`
              : 'the stream closed before it opened',
            error?.code,
          ),
        ),
    });
    const timer = setTimeout(() => {
      markFailed(new TunnelError('the service node did not open the stream in time'));
      circuit.abort();
    }, this.openTimeoutMs);
    try {
      circuit.open(port);
      await opened;
    } finally {
      clearTimeout(timer);
    }
    return circuit;
  }

  shutdown(): void {
    for (const links of this.links.values()) for (const link of links) link.close();
    this.links.clear();
  }

  private checkEndpoint(relay: string): string {
    const endpoint = normalizeRelayEndpoint(relay);
    if (!endpoint)
      throw new TunnelError('the registry named a relay that is not a ws:// or wss:// URL');
    if (endpoint.startsWith('ws://') && !this.options.allowPlaintextRelay) {
      const host = new URL(endpoint).hostname;
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
        throw new TunnelError(
          'refusing a plaintext ws:// relay: it would show the network which name you reach',
        );
      }
    }
    return endpoint;
  }

  private async linkFor(endpoint: string): Promise<RelayLink> {
    for (;;) {
      const links = this.links.get(endpoint) ?? [];
      const ready = links.find((l) => l.hasCapacity);
      if (ready) return ready;
      const inFlight = this.connecting.get(endpoint);
      if (inFlight) {
        await inFlight.catch(() => undefined);
        continue;
      }
      if (links.length >= this.maxLinks) {
        throw new TunnelError(
          'too many concurrent circuits to this relay',
          ErrorCode.CIRCUIT_LIMIT,
        );
      }
      const link = new RelayLink(endpoint, (gone) => {
        const list = this.links.get(endpoint);
        if (!list) return;
        const rest = list.filter((l) => l !== gone);
        if (rest.length) this.links.set(endpoint, rest);
        else this.links.delete(endpoint);
      });
      const promise = link.connect().then(() => {
        this.links.set(endpoint, [...(this.links.get(endpoint) ?? []), link]);
        return link;
      });
      this.connecting.set(endpoint, promise);
      try {
        return await promise;
      } finally {
        this.connecting.delete(endpoint);
      }
    }
  }
}
