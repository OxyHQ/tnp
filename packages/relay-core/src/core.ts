/**
 * The relay: one implementation, used by the standalone server (`apps/relay`)
 * and the relay embedded in the `tnp` binary (`packages/client`).
 *
 * Normative spec: docs/architecture/relays.md and transport.md §11.
 *
 * It routes frames between anonymous CLIENT connections (`/tunnel`) and
 * authenticated SERVICE-NODE connections (`/service`). It never decrypts
 * anything: after CIRCUIT_CREATE's cleartext routing name, every byte it
 * forwards is a Noise handshake message or a sealed record.
 *
 * The defects this replaces, each now structurally impossible:
 *
 *  - S1: circuit ids were one global, client-chosen map, and a frame on any id
 *    was forwarded with no ownership check. Here every connection has its own
 *    `CircuitTable`; a frame is looked up ONLY in the table of the connection
 *    it arrived on, so a frame naming another connection's circuit finds
 *    nothing and is dropped. Ids are never evicted on collision.
 *  - S2: `/service?domain=x` was unauthenticated and evicted the incumbent.
 *    Here a service node must prove possession of a node key the name's domain
 *    key authorized (challenge–response, `@tnp/crypto` service-auth), and a
 *    second node with a different key is refused: the incumbent stays.
 *  - S5 (relay half): the relay synthesized OPENED before the service node had
 *    seen anything. Here CIRCUIT_CREATED comes only from the service node and
 *    carries its Noise message 2, which a relay cannot forge.
 *  - S6: no limits. Here every table, rate and buffer is bounded (limits.ts).
 *
 * What it keeps is aggregate counters only — never a name, a circuit or an
 * address in a log line (privacy-model.md §4).
 */

import {
  bytesEqual,
  type Grant,
  parsePublicKey,
  toHex,
  verifyChain,
  verifyServiceAuth,
} from '@tnp/crypto';
import { randomBytes } from '@tnp/crypto/primitives';
import {
  CircuitTable,
  DESTROY_NORMAL,
  decodeCircuitCreate,
  decodeFrame,
  decodeServiceAuth,
  encodeDestroy,
  encodeError,
  encodeFrame,
  ErrorCode,
  type ErrorCodeValue,
  ErrorScope,
  type Frame,
  FrameDecodeError,
  FrameType,
  generateCircuitId,
  HANDSHAKE_MESSAGE_SIZE,
  MAX_FRAME_SIZE,
  SERVICE_CHALLENGE_SIZE,
} from '@tnp/protocol/v1';
import { DEFAULT_LIMITS, IpTracker, type RelayLimits } from './limits.js';

/**
 * The transport binding under one connection (transport.md §2). Send result
 * follows Bun's `ServerWebSocket.send`: > 0 sent, -1 queued under
 * backpressure, 0 dropped (the connection is going away).
 */
export interface RelayTransport {
  send(frame: Uint8Array): number;
  bufferedAmount(): number;
  close(code?: number, reason?: string): void;
}

/** Resolves a name to the domain key the registry publishes for it, or null. */
export type DomainKeyLookup = (name: string) => Promise<string | Uint8Array | null>;

export interface RelayCoreOptions {
  /**
   * This relay's public endpoint, normalized. A service node signs the
   * endpoint it dialed; a proof for any other endpoint is refused, so a hostile
   * relay cannot replay a node's proof here.
   */
  endpoint: string;
  lookupDomainKey: DomainKeyLookup;
  limits?: Partial<RelayLimits>;
  /** Milliseconds. Injected for tests. */
  clock?: () => number;
  /** How often timeouts and stale state are swept. */
  sweepIntervalMs?: number;
}

export interface RelayStats {
  connections: number;
  clients: number;
  serviceNodes: number;
  circuits: number;
  circuitsOpened: number;
  circuitsRejected: number;
  framesForwarded: number;
  bytesForwarded: number;
  framesDropped: number;
  protocolViolations: number;
  backpressureDestroys: number;
  authFailures: number;
  idleDestroys: number;
  memoryCloses: number;
}

export interface ConnectionHandle {
  /** One binary WebSocket message. */
  receive(data: Uint8Array): void;
  /** The transport closed. Idempotent. */
  closed(): void;
}

export type Admission = { ok: true } | { ok: false; status: number; reason: string };

/** WebSocket close codes. */
const CLOSE_NORMAL = 1000;
const CLOSE_POLICY = 1008;
const CLOSE_TOO_BIG = 1009;
const CLOSE_TRY_LATER = 1013;

interface Circuit {
  client: Connection;
  clientId: bigint;
  service: Connection;
  serviceId: bigint;
  open: boolean;
  createdAt: number;
  /** Last frame forwarded either way (ms), for the idle timeout. */
  lastActivity: number;
  /** The service's name, for the per-IP-per-service count. */
  name: string;
}

type ServiceState = 'awaiting-auth' | 'verifying' | 'ready';

interface Connection {
  kind: 'client' | 'service';
  transport: RelayTransport;
  ip: string;
  circuits: CircuitTable<Circuit>;
  pending: number;
  /** Client connections: circuits held to each service connection. */
  perService: Map<Connection, number>;
  violations: number;
  closed: boolean;
  openedAt: number;
  // Service connections only.
  state?: ServiceState;
  challenge?: Uint8Array;
  name?: string;
  nodeKeyHex?: string;
  domainKeyHex?: string;
  authNotAfter?: number;
  authCheckedAt?: number;
}

export class RelayCore {
  readonly limits: RelayLimits;
  private readonly endpoint: string;
  private readonly lookupDomainKey: DomainKeyLookup;
  private readonly clock: () => number;
  private readonly ips: IpTracker;
  private readonly connections = new Set<Connection>();
  private readonly services = new Map<string, Connection>();
  private circuitCount = 0;
  /** `ip \0 name` → circuits that address holds to that service. Entries exist only while > 0. */
  private readonly ipService = new Map<string, number>();
  /** In-flight domain-key lookups, coalesced per name. */
  private readonly lookups = new Map<string, Promise<Uint8Array | null>>();
  /** Names recently found to have no domain key (bounded; expiry ms). */
  private readonly noKey = new Map<string, number>();
  private sweepTimer: ReturnType<typeof setInterval> | null;
  private readonly counters = {
    circuitsOpened: 0,
    circuitsRejected: 0,
    framesForwarded: 0,
    bytesForwarded: 0,
    framesDropped: 0,
    protocolViolations: 0,
    backpressureDestroys: 0,
    authFailures: 0,
    idleDestroys: 0,
    memoryCloses: 0,
  };

  constructor(options: RelayCoreOptions) {
    if (!options.endpoint) throw new Error('relay endpoint is required');
    this.endpoint = options.endpoint;
    this.lookupDomainKey = options.lookupDomainKey;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.clock = options.clock ?? Date.now;
    this.ips = new IpTracker(this.limits);
    this.sweepTimer = setInterval(() => this.sweep(), options.sweepIntervalMs ?? 1000);
    this.sweepTimer.unref?.();
  }

  // -------------------------------------------------------------------------
  // Admission and lifecycle
  // -------------------------------------------------------------------------

  /** Called before a WebSocket upgrade. A refused address is never upgraded. */
  admit(ip: string): Admission {
    if (this.connections.size >= this.limits.maxConnections) {
      return { ok: false, status: 503, reason: 'relay at capacity' };
    }
    const verdict = this.ips.admit(ip, this.clock());
    if (verdict === 'ok') return { ok: true };
    return {
      ok: false,
      status: verdict === 'table-full' ? 503 : 429,
      reason: 'too many connections',
    };
  }

  /** Undo an `admit` whose upgrade then failed. */
  releaseAdmission(ip: string): void {
    this.ips.release(ip);
  }

  acceptClient(transport: RelayTransport, ip: string): ConnectionHandle {
    const conn = this.newConnection('client', transport, ip, this.limits.maxCircuitsPerClient);
    return this.handleFor(conn);
  }

  acceptService(transport: RelayTransport, ip: string): ConnectionHandle {
    const conn = this.newConnection('service', transport, ip, this.limits.maxCircuitsPerService);
    conn.state = 'awaiting-auth';
    conn.challenge = randomBytes(SERVICE_CHALLENGE_SIZE);
    transport.send(encodeFrame({ type: FrameType.HELLO, payload: conn.challenge }));
    return this.handleFor(conn);
  }

  stats(): RelayStats {
    let clients = 0;
    for (const c of this.connections) if (c.kind === 'client') clients++;
    return {
      connections: this.connections.size,
      clients,
      serviceNodes: this.services.size,
      circuits: this.circuitCount,
      ...this.counters,
    };
  }

  /** Close every connection and stop timers. */
  shutdown(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const conn of [...this.connections]) this.closeConnection(conn, CLOSE_NORMAL, 'shutdown');
  }

  private newConnection(
    kind: 'client' | 'service',
    transport: RelayTransport,
    ip: string,
    maxCircuits: number,
  ): Connection {
    const conn: Connection = {
      kind,
      transport,
      ip,
      circuits: new CircuitTable<Circuit>(maxCircuits),
      pending: 0,
      perService: new Map(),
      violations: 0,
      closed: false,
      openedAt: this.clock(),
    };
    this.connections.add(conn);
    return conn;
  }

  private handleFor(conn: Connection): ConnectionHandle {
    return {
      receive: (data) => {
        try {
          this.receive(conn, data);
        } catch {
          // Nothing a peer sends may take the relay down. An unexpected throw
          // is treated as that peer's protocol violation.
          this.fail(conn, ErrorCode.PROTOCOL_VIOLATION);
        }
      },
      closed: () => this.onTransportClosed(conn),
    };
  }

  private onTransportClosed(conn: Connection): void {
    if (conn.closed) return;
    conn.closed = true;
    this.connections.delete(conn);
    this.ips.release(conn.ip);
    if (conn.kind === 'service' && conn.name && this.services.get(conn.name) === conn) {
      this.services.delete(conn.name);
    }
    for (const circuit of conn.circuits.drain()) {
      // Tell the far side; it loses only this circuit.
      this.removeCircuit(
        circuit,
        conn === circuit.client ? 'service' : 'client',
        ErrorCode.CIRCUIT_UNKNOWN,
      );
    }
  }

  private closeConnection(conn: Connection, code: number, reason: string): void {
    if (conn.closed) return;
    try {
      conn.transport.close(code, reason);
    } catch {
      // already gone
    }
    this.onTransportClosed(conn);
  }

  /** Send a connection-scope ERROR and close. */
  private fail(conn: Connection, code: ErrorCodeValue, closeCode = CLOSE_POLICY): void {
    if (conn.closed) return;
    if (code === ErrorCode.PROTOCOL_VIOLATION) this.counters.protocolViolations++;
    try {
      conn.transport.send(encodeError({ code, scope: ErrorScope.CONNECTION, detail: '' }));
    } catch {
      // best effort
    }
    this.closeConnection(conn, closeCode, 'protocol error');
  }

  /**
   * A data or destroy frame for a circuit this connection does not own:
   * dropped, never forwarded, never looked up anywhere else. Not penalized —
   * frames in flight when the other side tears a circuit down arrive like this
   * on every honest long-lived connection, and dropping costs nothing.
   */
  private unowned(): void {
    this.counters.framesDropped++;
  }

  /** A frame a peer may not send: dropped; enough of them close the connection. */
  private violation(conn: Connection): void {
    this.counters.framesDropped++;
    conn.violations++;
    if (conn.violations > this.limits.maxViolations) this.fail(conn, ErrorCode.PROTOCOL_VIOLATION);
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private receive(conn: Connection, data: Uint8Array): void {
    if (conn.closed) return;
    if (data.byteLength > MAX_FRAME_SIZE) {
      this.fail(conn, ErrorCode.PROTOCOL_VIOLATION, CLOSE_TOO_BIG);
      return;
    }
    let frame: Frame;
    try {
      frame = decodeFrame(data);
    } catch (err) {
      this.fail(conn, err instanceof FrameDecodeError ? err.code : ErrorCode.PROTOCOL_VIOLATION);
      return;
    }

    if (frame.type === FrameType.PING && frame.circuitId === 0n) {
      conn.transport.send(
        encodeFrame({ type: FrameType.PONG, payload: frame.payload.slice(0, 32) }),
      );
      return;
    }
    if (frame.type === FrameType.PONG) return;

    if (conn.kind === 'service' && conn.state !== 'ready') {
      this.receiveUnauthenticated(conn, frame);
      return;
    }
    if (conn.kind === 'client') this.receiveFromClient(conn, frame, data);
    else this.receiveFromService(conn, frame, data);
  }

  private receiveFromClient(conn: Connection, frame: Frame, raw: Uint8Array): void {
    switch (frame.type) {
      case FrameType.CIRCUIT_CREATE:
        this.createCircuit(conn, frame);
        return;
      case FrameType.STREAM_DATA: {
        const circuit = conn.circuits.get(frame.circuitId);
        if (!circuit) {
          this.unowned();
          return;
        }
        if (!circuit.open) {
          // Data before the service node answered: a client that does this is
          // not running the handshake. The circuit goes, the connection stays.
          this.counters.protocolViolations++;
          this.removeCircuit(circuit, 'both', ErrorCode.PROTOCOL_VIOLATION);
          return;
        }
        this.forward(circuit, 'service', raw);
        return;
      }
      case FrameType.CIRCUIT_DESTROY: {
        const circuit = conn.circuits.get(frame.circuitId);
        if (!circuit) {
          this.unowned();
          return;
        }
        this.removeCircuit(circuit, 'service', DESTROY_NORMAL);
        return;
      }
      default:
        this.violation(conn);
    }
  }

  private receiveFromService(conn: Connection, frame: Frame, raw: Uint8Array): void {
    switch (frame.type) {
      case FrameType.CIRCUIT_CREATED: {
        const circuit = conn.circuits.get(frame.circuitId);
        if (!circuit || circuit.open) {
          this.violation(conn);
          return;
        }
        if (frame.payload.length !== HANDSHAKE_MESSAGE_SIZE || frame.streamId !== 0) {
          this.counters.protocolViolations++;
          this.removeCircuit(circuit, 'both', ErrorCode.PROTOCOL_VIOLATION);
          return;
        }
        circuit.open = true;
        circuit.client.pending--;
        this.counters.circuitsOpened++;
        this.forward(circuit, 'client', raw);
        return;
      }
      case FrameType.STREAM_DATA: {
        const circuit = conn.circuits.get(frame.circuitId);
        if (!circuit) {
          this.unowned();
          return;
        }
        if (!circuit.open) {
          this.violation(conn);
          return;
        }
        this.forward(circuit, 'client', raw);
        return;
      }
      case FrameType.CIRCUIT_DESTROY: {
        const circuit = conn.circuits.get(frame.circuitId);
        if (!circuit) {
          this.unowned();
          return;
        }
        this.removeCircuit(circuit, 'client', DESTROY_NORMAL);
        return;
      }
      default:
        this.violation(conn);
    }
  }

  private createCircuit(conn: Connection, frame: Frame): void {
    const id = frame.circuitId;
    if (id === 0n || frame.streamId !== 0) {
      this.violation(conn);
      return;
    }
    // An id this connection already uses is NOT replaced — replacing is how
    // the old relay let one peer displace another's circuit.
    if (conn.circuits.has(id)) {
      this.violation(conn);
      return;
    }

    const reject = (code: ErrorCodeValue) => {
      this.counters.circuitsRejected++;
      this.sendTo(conn, FrameType.CIRCUIT_DESTROY, id, encodeDestroy(code));
    };

    if (!this.ips.allowCreate(conn.ip, this.clock())) {
      reject(ErrorCode.RATE_LIMIT);
      return;
    }
    if (
      conn.circuits.atCapacity ||
      conn.pending >= this.limits.maxPendingPerClient ||
      this.circuitCount >= this.limits.maxCircuits
    ) {
      reject(ErrorCode.CIRCUIT_LIMIT);
      return;
    }

    let name: string;
    try {
      name = decodeCircuitCreate(frame.payload).name;
    } catch {
      this.counters.protocolViolations++;
      reject(ErrorCode.PROTOCOL_VIOLATION);
      return;
    }

    const service = this.services.get(name);
    if (!service || service.closed) {
      reject(ErrorCode.CIRCUIT_REJECTED);
      return;
    }
    // Fairness: one connection, and one address, may hold only a small share
    // of a service's circuits — so nobody can take all of them.
    const ipKey = `${conn.ip}\0${name}`;
    if (
      (conn.perService.get(service) ?? 0) >= this.limits.maxCircuitsPerClientPerService ||
      (this.ipService.get(ipKey) ?? 0) >= this.limits.maxCircuitsPerIpPerService
    ) {
      reject(ErrorCode.CIRCUIT_LIMIT);
      return;
    }
    if (service.circuits.atCapacity) {
      reject(ErrorCode.RESOURCE_EXHAUSTED);
      return;
    }

    let serviceId = generateCircuitId();
    while (service.circuits.has(serviceId)) serviceId = generateCircuitId();

    const circuit: Circuit = {
      client: conn,
      clientId: id,
      service,
      serviceId,
      open: false,
      createdAt: this.clock(),
      lastActivity: this.clock(),
      name,
    };
    conn.circuits.add(id, circuit);
    service.circuits.add(serviceId, circuit);
    conn.pending++;
    conn.perService.set(service, (conn.perService.get(service) ?? 0) + 1);
    this.ipService.set(ipKey, (this.ipService.get(ipKey) ?? 0) + 1);
    this.circuitCount++;

    // The payload goes to the service node unchanged: it needs the name (to
    // bind the handshake prologue) and message 1. Only the circuit id differs.
    this.sendTo(service, FrameType.CIRCUIT_CREATE, serviceId, frame.payload);
  }

  // -------------------------------------------------------------------------
  // Forwarding
  // -------------------------------------------------------------------------

  /** Forward `raw` to one side of `circuit`, rewriting only the circuit id. */
  private forward(circuit: Circuit, to: 'client' | 'service', raw: Uint8Array): void {
    const dest = to === 'client' ? circuit.client : circuit.service;
    const destId = to === 'client' ? circuit.clientId : circuit.serviceId;
    const limit = to === 'client' ? this.limits.clientBufferLimit : this.limits.serviceBufferLimit;
    if (dest.closed) return;
    if (dest.transport.bufferedAmount() + raw.byteLength > limit) {
      // Only a sender ignoring its end-to-end window gets here (limits.ts).
      // It loses this circuit; the destination and its other circuits do not.
      this.counters.backpressureDestroys++;
      this.removeCircuit(circuit, 'both', ErrorCode.RESOURCE_EXHAUSTED);
      return;
    }
    const out = raw.slice();
    new DataView(out.buffer).setBigUint64(4, destId, false);
    const result = dest.transport.send(out);
    if (result === 0) return; // destination is closing; its close handler cleans up
    circuit.lastActivity = this.clock();
    this.counters.framesForwarded++;
    this.counters.bytesForwarded += out.byteLength;
  }

  private sendTo(
    conn: Connection,
    type: (typeof FrameType)[keyof typeof FrameType],
    circuitId: bigint,
    payload: Uint8Array,
  ): void {
    if (conn.closed) return;
    conn.transport.send(encodeFrame({ type, circuitId, payload }));
  }

  /**
   * Remove a circuit from both connections' tables and tell `notify` with a
   * CIRCUIT_DESTROY. The ends send DESTROY_NORMAL; the relay names its own
   * reasons (limits, violations), which reveal nothing the relay did not
   * already decide.
   */
  private removeCircuit(
    circuit: Circuit,
    notify: 'client' | 'service' | 'both',
    reason: number,
  ): void {
    const ownedByClient = circuit.client.circuits.get(circuit.clientId) === circuit;
    const ownedByService = circuit.service.circuits.get(circuit.serviceId) === circuit;
    if (!ownedByClient && !ownedByService) return;
    if (ownedByClient) circuit.client.circuits.delete(circuit.clientId);
    if (ownedByService) circuit.service.circuits.delete(circuit.serviceId);
    if (!circuit.open) circuit.client.pending--;
    this.circuitCount--;
    const perService = (circuit.client.perService.get(circuit.service) ?? 1) - 1;
    if (perService > 0) circuit.client.perService.set(circuit.service, perService);
    else circuit.client.perService.delete(circuit.service);
    const ipKey = `${circuit.client.ip}\0${circuit.name}`;
    const perIp = (this.ipService.get(ipKey) ?? 1) - 1;
    if (perIp > 0) this.ipService.set(ipKey, perIp);
    else this.ipService.delete(ipKey);
    const payload = encodeDestroy(reason);
    if (notify !== 'service') {
      this.sendTo(circuit.client, FrameType.CIRCUIT_DESTROY, circuit.clientId, payload);
    }
    if (notify !== 'client') {
      this.sendTo(circuit.service, FrameType.CIRCUIT_DESTROY, circuit.serviceId, payload);
    }
  }

  // -------------------------------------------------------------------------
  // Service-node authentication (relays.md §2)
  // -------------------------------------------------------------------------

  private receiveUnauthenticated(conn: Connection, frame: Frame): void {
    if (conn.state !== 'awaiting-auth' || frame.type !== FrameType.AUTH || frame.circuitId !== 0n) {
      // Nothing but AUTH is processed before AUTH_OK (transport.md §6).
      this.counters.authFailures++;
      this.fail(conn, ErrorCode.AUTH_REQUIRED);
      return;
    }
    let auth: ReturnType<typeof decodeServiceAuth>;
    try {
      auth = decodeServiceAuth(frame.payload);
    } catch {
      this.counters.authFailures++;
      this.fail(conn, ErrorCode.PROTOCOL_VIOLATION);
      return;
    }
    // Each AUTH costs a registry lookup: rate-limited per address.
    if (!this.ips.allowAuth(conn.ip, this.clock())) {
      this.authFailed(conn, ErrorCode.RATE_LIMIT);
      return;
    }
    conn.state = 'verifying';
    void this.verifyService(conn, auth.name, auth.chain as Grant[], auth.signature);
  }

  private async verifyService(
    conn: Connection,
    name: string,
    chain: Grant[],
    signature: string,
  ): Promise<void> {
    let domainKey: Uint8Array | null = null;
    try {
      domainKey = await this.domainKeyFor(name);
    } catch {
      domainKey = null;
    }
    if (conn.closed) return;
    // No registered domain key, or the registry is unreachable: fail closed.
    if (!domainKey) return this.authFailed(conn, ErrorCode.AUTH_FAILED);

    const now = Math.floor(this.clock() / 1000);
    const verified = verifyChain(chain, {
      trustedRoots: [domainKey],
      now,
      requirePurpose: 'service-node',
      requireScope: name,
    });
    if (!verified.ok) {
      const code =
        verified.reason === 'expired'
          ? ErrorCode.AUTH_EXPIRED
          : verified.reason === 'revoked'
            ? ErrorCode.REVOKED
            : ErrorCode.AUTH_FAILED;
      return this.authFailed(conn, code);
    }
    const challenge = conn.challenge;
    if (
      !challenge ||
      !verifyServiceAuth(
        { name, endpoint: this.endpoint, challenge, nodeKey: verified.subject },
        signature,
      )
    ) {
      return this.authFailed(conn, ErrorCode.AUTH_FAILED);
    }

    const nodeKeyHex = toHex(verified.subject);
    const incumbent = this.services.get(name);
    if (incumbent && !incumbent.closed) {
      if (incumbent.nodeKeyHex !== nodeKeyHex) {
        // A different authenticated node: the incumbent is NOT evicted.
        return this.authFailed(conn, ErrorCode.ALREADY_REGISTERED);
      }
      // The same node key reconnecting (its old connection may be half-open).
      // Only the holder of that key can do this, so it is not a takeover.
      this.closeConnection(incumbent, CLOSE_NORMAL, 'replaced by the same node');
    }
    if (this.services.size >= this.limits.maxServiceNodes) {
      return this.authFailed(conn, ErrorCode.RESOURCE_EXHAUSTED);
    }

    conn.state = 'ready';
    conn.name = name;
    conn.nodeKeyHex = nodeKeyHex;
    conn.domainKeyHex = toHex(domainKey);
    conn.authNotAfter = verified.notAfter;
    conn.authCheckedAt = this.clock();
    conn.challenge = undefined;
    this.services.set(name, conn);
    conn.transport.send(encodeFrame({ type: FrameType.AUTH_OK }));
  }

  /**
   * The registered domain key for `name`, with identical lookups in flight
   * coalesced into one, and names without a key remembered briefly (bounded)
   * so random names cannot spend the relay's registry budget. A registry
   * error is not cached: it throws and the caller fails closed.
   */
  private domainKeyFor(name: string): Promise<Uint8Array | null> {
    const now = this.clock();
    const negative = this.noKey.get(name);
    if (negative !== undefined) {
      if (negative > now) return Promise.resolve(null);
      this.noKey.delete(name);
    }
    const inFlight = this.lookups.get(name);
    if (inFlight) return inFlight;
    const lookup = (async () => {
      const looked = await this.lookupDomainKey(name);
      const key = looked === null ? null : parsePublicKey(looked);
      if (key === null) {
        if (this.noKey.size >= this.limits.lookupCacheMax) {
          this.noKey.delete(this.noKey.keys().next().value as string);
        }
        this.noKey.set(name, this.clock() + this.limits.lookupNegativeTtlMs);
      }
      return key;
    })().finally(() => this.lookups.delete(name));
    this.lookups.set(name, lookup);
    return lookup;
  }

  private authFailed(conn: Connection, code: ErrorCodeValue): void {
    this.counters.authFailures++;
    this.fail(conn, code, code === ErrorCode.RESOURCE_EXHAUSTED ? CLOSE_TRY_LATER : CLOSE_POLICY);
  }

  // -------------------------------------------------------------------------
  // Sweep: timeouts, expiry, re-authentication, IP table
  // -------------------------------------------------------------------------

  private sweep(): void {
    const nowMs = this.clock();
    const nowS = Math.floor(nowMs / 1000);
    for (const conn of [...this.connections]) {
      if (conn.closed) continue;
      if (conn.kind === 'service') {
        if (conn.state !== 'ready') {
          if (nowMs - conn.openedAt > this.limits.handshakeTimeoutMs) {
            this.authFailed(conn, ErrorCode.AUTH_REQUIRED);
          }
          continue;
        }
        if (conn.authNotAfter !== undefined && nowS >= conn.authNotAfter) {
          this.fail(conn, ErrorCode.AUTH_EXPIRED);
          continue;
        }
        if (
          conn.authCheckedAt !== undefined &&
          nowMs - conn.authCheckedAt > this.limits.reauthIntervalMs
        ) {
          conn.authCheckedAt = nowMs;
          void this.recheckDomainKey(conn);
        }
        for (const [, circuit] of conn.circuits.entries()) {
          if (!circuit.open && nowMs - circuit.createdAt > this.limits.createTimeoutMs) {
            this.removeCircuit(circuit, 'both', ErrorCode.TARGET_UNREACHABLE);
          } else if (circuit.open && nowMs - circuit.lastActivity > this.limits.circuitIdleMs) {
            this.counters.idleDestroys++;
            this.removeCircuit(circuit, 'both', ErrorCode.RESOURCE_EXHAUSTED);
          }
        }
      }
    }
    this.enforceGlobalBuffer();
    this.ips.sweep(nowMs);
    for (const [name, expiry] of this.noKey) if (expiry <= nowMs) this.noKey.delete(name);
  }

  /** Close the connections holding the most buffered bytes until the total fits the budget. */
  private enforceGlobalBuffer(): void {
    let total = 0;
    const sized: Array<[Connection, number]> = [];
    for (const conn of this.connections) {
      if (conn.closed) continue;
      const buffered = conn.transport.bufferedAmount();
      total += buffered;
      if (buffered > 0) sized.push([conn, buffered]);
    }
    if (total <= this.limits.globalBufferLimit) return;
    sized.sort((a, b) => b[1] - a[1]);
    for (const [conn, buffered] of sized) {
      if (total <= this.limits.globalBufferLimit) break;
      this.counters.memoryCloses++;
      this.fail(conn, ErrorCode.RESOURCE_EXHAUSTED, CLOSE_TRY_LATER);
      total -= buffered;
    }
  }

  /**
   * Drop a service node whose name's domain key has changed since it
   * authenticated: rotating the domain key is how an owner retires every node
   * chained under the old one.
   */
  private async recheckDomainKey(conn: Connection): Promise<void> {
    const name = conn.name;
    if (!name) return;
    let current: Uint8Array | null = null;
    try {
      current = await this.domainKeyFor(name);
    } catch {
      return; // registry unreachable: keep the node; it authenticated against a key we had
    }
    if (conn.closed) return;
    if (!current || !conn.domainKeyHex || !bytesEqual(current, hexToBytes(conn.domainKeyHex))) {
      this.fail(conn, ErrorCode.REVOKED);
    }
  }
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
