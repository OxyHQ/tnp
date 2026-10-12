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
 *     4. look the relay it names up in the SIGNED relay directory; a relay
 *        that is not listed is refused (relays.md §8, blocker 6). On connect
 *        the relay must prove it holds the listed key for this endpoint and
 *        this connection (overlay/relay-identity.ts) before any circuit.
 *     5. CIRCUIT_CREATE {name, Noise msg1} on a relay connection, with a
 *        circuit id from the CSPRNG, connection-scoped
 *     6. CIRCUIT_CREATED {Noise msg2} from the SERVICE NODE → session; a
 *        relay answering on its own fails key confirmation here
 *     7. sealed OPEN(port) → sealed OPENED → a `SecureCircuit` to pipe
 *
 * Replaces a manager that numbered circuits from 1 in every process (audit
 * S1), derived one shared key for both directions from whatever key the API
 * returned (S3, S5), and never looked at its send buffer (S6).
 */

import { toHex, type VerifiedKeyAgreementKey } from '@tnp/crypto';
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
import { RelayIdentityCheck, RelayIdentityError } from './overlay/relay-identity';
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

/**
 * The relay key the signed directory lists for an endpoint, or null when the
 * endpoint is not listed. Throws when there is no verified directory.
 */
export type RelayKeyLookup = (endpoint: string) => Promise<Uint8Array | null>;

export interface TunnelManagerOptions {
  pins: PinStore;
  /** Fetch the `/dns/resolve` overlay block for a destination; null when there is none. */
  resolveOverlay: (destination: string) => Promise<unknown | null>;
  /**
   * The signed relay directory (relay-directory.ts `relayKeyFor`). A relay
   * the resolve record names is used only if it is listed, and only after it
   * proves the listed key.
   */
  relayKeys: RelayKeyLookup;
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
  /** Extra HTTP headers on relay connections (for a proxy in front; tests). */
  headers?: Record<string, string>;
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
  private readonly identity: RelayIdentityCheck;
  private verified = false;
  private onVerified: ((err: Error | null) => void) | null = null;
  closed = false;

  constructor(
    readonly endpoint: string,
    relayKey: Uint8Array,
    private readonly onGone: (link: RelayLink) => void,
    private readonly headers?: Record<string, string>,
  ) {
    this.identity = new RelayIdentityCheck(endpoint, relayKey);
  }

  /** Connect, then make the relay prove its directory key. Nothing else is sent before that. */
  async connect(): Promise<void> {
    const proven = new Promise<void>((resolve, reject) => {
      this.onVerified = (err) => (err ? reject(err) : resolve());
    });
    // Rejections are consumed below; a failure before the await must not be unhandled.
    proven.catch(() => {});
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
      this.headers,
    );
    this.socket = socket;
    await ready;
    socket.send(this.identity.helloFrame());
    const timer = setTimeout(
      () =>
        this.identityFailed(new RelayIdentityError('the relay did not prove its identity in time')),
      RELAY_CONNECT_TIMEOUT_MS,
    );
    try {
      await proven;
    } finally {
      clearTimeout(timer);
    }
  }

  private identityFailed(err: Error): void {
    const notify = this.onVerified;
    this.onVerified = null;
    notify?.(err);
    this.socket?.close(1008, 'relay identity not proven');
  }

  get hasCapacity(): boolean {
    return (
      this.verified && !this.closed && !this.circuits.atCapacity && this.pending < MAX_PENDING_OPENS
    );
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
    if (!this.verified) {
      // Before the proof, the only frames that mean anything are PING and the
      // HELLO_ACK. Anything else — including circuit frames — ends the link.
      if (frame.type === FrameType.PING && frame.circuitId === 0n) {
        this.socket?.send(encodeFrame({ type: FrameType.PONG, payload: frame.payload }));
        return;
      }
      try {
        this.identity.verify(frame);
      } catch (err) {
        this.identityFailed(
          err instanceof Error ? err : new RelayIdentityError('relay identity not proven'),
        );
        return;
      }
      this.verified = true;
      const notify = this.onVerified;
      this.onVerified = null;
      notify?.(null);
      return;
    }
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
    const notify = this.onVerified;
    this.onVerified = null;
    notify?.(new TunnelError('relay connection lost before it proved its identity'));
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
    const relayKey = await this.directoryKey(endpoint);
    // Capacity is re-checked after every await and the circuit claimed in the
    // same synchronous step, so concurrent opens cannot overfill one link.
    let link = await this.linkFor(endpoint, relayKey);
    for (let tries = 0; !link.hasCapacity; tries++) {
      if (tries > this.maxLinks)
        throw new TunnelError('relay connections are full', ErrorCode.CIRCUIT_LIMIT);
      link = await this.linkFor(endpoint, relayKey);
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

  /**
   * The signed directory's key for `endpoint`. A relay that is not listed is
   * never used: the resolve record that named it is registry data, and a
   * relay is selectable only through the signed directory.
   */
  private async directoryKey(endpoint: string): Promise<Uint8Array> {
    let key: Uint8Array | null;
    try {
      key = await this.options.relayKeys(endpoint);
    } catch (err) {
      throw new TunnelError(
        `refusing the relay: ${err instanceof Error ? err.message : 'no verified relay directory'}`,
        ErrorCode.AUTH_FAILED,
      );
    }
    if (!key) {
      throw new TunnelError(
        `refusing relay ${endpoint}: it is not in the signed relay directory`,
        ErrorCode.AUTH_FAILED,
      );
    }
    return key;
  }

  private async linkFor(endpoint: string, relayKey: Uint8Array): Promise<RelayLink> {
    // Keyed by endpoint AND key: a link proven against one key is never used
    // for a directory that lists another.
    const slot = `${endpoint} ${toHex(relayKey)}`;
    for (;;) {
      const links = this.links.get(slot) ?? [];
      const ready = links.find((l) => l.hasCapacity);
      if (ready) return ready;
      const inFlight = this.connecting.get(slot);
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
      const link = new RelayLink(
        endpoint,
        relayKey,
        (gone) => {
          const list = this.links.get(slot);
          if (!list) return;
          const rest = list.filter((l) => l !== gone);
          if (rest.length) this.links.set(slot, rest);
          else this.links.delete(slot);
        },
        this.options.headers,
      );
      const promise = link.connect().then(
        () => {
          this.links.set(slot, [...(this.links.get(slot) ?? []), link]);
          return link;
        },
        (err: unknown) => {
          link.close();
          if (err instanceof RelayIdentityError) {
            throw new TunnelError(err.message, ErrorCode.AUTH_FAILED);
          }
          throw err instanceof TunnelError
            ? err
            : new TunnelError(
                err instanceof Error ? err.message : 'could not connect to the relay',
              );
        },
      );
      this.connecting.set(slot, promise);
      try {
        return await promise;
      } finally {
        this.connecting.delete(slot);
      }
    }
  }
}
