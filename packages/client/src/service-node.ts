/**
 * Service node: publish a local TCP service under a TNP name through a relay,
 * using outbound connections only.
 *
 * Normative spec: docs/architecture/service-nodes.md and transport.md §11.
 *
 *   1. credentials: node key + grant chain rooted at the DOMAIN KEY
 *      (overlay/identity.ts); an X25519 key certified by the node key
 *   2. publish chain + certificate to the registry (`POST /nodes/register`),
 *      which verifies them; clients verify them again themselves
 *   3. connect to the relay's `/service`; make the relay prove it holds the
 *      key the SIGNED directory lists for that endpoint (transport.md §6.2)
 *      before anything else is sent; then answer its challenge with a
 *      signature by the node key (the relay checks the chain against the
 *      domain key: audit S2). A relay that cannot be reached or cannot prove
 *      its key is failed over to the next candidate.
 *   4. per CIRCUIT_CREATE: Noise NK responder → CIRCUIT_CREATED carrying
 *      message 2 (the relay can no longer fake it: S5)
 *   5. sealed OPEN(port) → connect to the target → sealed OPENED, or a sealed
 *      RESET with a generic code. The relay never sees the port, and nobody
 *      sees a LAN address or an error string.
 *
 * Every input from the relay is length-checked by the codecs and handled
 * inside a try/catch: a malformed frame costs that circuit, never the process.
 * The old node computed a shared key from an unchecked base64 string inside the
 * WebSocket listener, so one malformed OPEN crashed it.
 */

import net from 'node:net';
import {
  CircuitTable,
  DESTROY_NORMAL,
  decodeCircuitCreate,
  decodeError,
  decodeServiceHello,
  encodeDestroy,
  encodeFrame,
  encodeServiceAuth,
  ERROR_CODE_NAMES,
  ErrorCode,
  type Frame,
  FrameType,
  ServerHandshake,
  type SessionCipher,
} from '@tnp/protocol/v1';
import {
  encodeBase64,
  type Grant,
  type KeyAgreementCertificate,
  signServiceAuth,
} from '@tnp/crypto';
import { normalizeRelayEndpoint, type RegisterDomainKeyRequest } from '@tnp/shared-types';
import type { TnpApiClient } from './api';
import { FrameSocket } from './overlay/frame-socket';
import {
  chainValidUntil,
  createDomainKey,
  issueNodeGrant,
  KeyAgreementKeys,
  loadKeyPair,
  loadOrCreateNodeKey,
  loadStoredChain,
  RENEW_GRANT_BEFORE,
  saveChain,
  type SigningKeyPair,
} from './overlay/identity';
import { pipeSocket } from './overlay/pipe';
import { RelayIdentityCheck } from './overlay/relay-identity';
import { SecureCircuit } from './overlay/secure-circuit';
import { OverlayStore } from './overlay/store';
import { parseLocalTarget } from './parse-input';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAINTENANCE_INTERVAL_MS = 60_000;
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** A relay that refuses us because another node serves the name is retried slowly. */
const RECONNECT_CONFLICT_MS = 5 * 60_000;
const RELAY_CONNECT_TIMEOUT_MS = 10_000;
const TARGET_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CIRCUITS = 256;
/** A circuit with no traffic for this long is reset (relay-core's circuit idle timeout is longer). */
const DEFAULT_STREAM_IDLE_MS = 10 * 60_000;
/** A circuit whose client has not sent OPEN by then is reset. */
const OPEN_TIMEOUT_MS = 10_000;

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------------------
// The node itself, independent of the registry and the CLI (tests drive it)
// ---------------------------------------------------------------------------

/**
 * A relay a service node may attach to. `relayKey` is the key the signed
 * directory lists for the endpoint; the relay must prove it before the node
 * authenticates. `null` only for an operator's explicit `--relay` override of
 * a relay that is not in the directory, which `tnp serve` warns about loudly.
 */
export interface RelayCandidate {
  endpoint: string;
  relayKey: Uint8Array | null;
}

export interface ServiceNodeOptions {
  name: string;
  target: { host: string; port: number };
  /** In order of preference. Failed over on connect or identity failure. */
  relays: RelayCandidate[];
  nodeKey: SigningKeyPair;
  chain: Grant[];
  /** Publish the current chain and certificate (the registry). Called at start and on every rotation. */
  publish?: (chain: Grant[], kaCert: KeyAgreementCertificate) => Promise<void>;
  /** Liveness to the registry while attached to a relay; receives that relay's endpoint. */
  heartbeat?: (relayEndpoint: string) => Promise<void>;
  /** Called when the chain nears expiry; return a renewed chain, or null when it cannot be renewed here. */
  renewChain?: () => Grant[] | null;
  now?: () => number;
  maxCircuits?: number;
  /**
   * A circuit with no record in either direction for this long is reset, so
   * opened-but-silent circuits cannot hold this node's slots. Default 10 min.
   */
  streamIdleMs?: number;
  log?: (message: string) => void;
}

export type ServiceNodeState = 'connecting' | 'authenticating' | 'serving' | 'stopped';

export class ServiceNode {
  private socket: FrameSocket | null = null;
  private state: ServiceNodeState = 'connecting';
  private readonly circuits: CircuitTable<SecureCircuit>;
  private readonly keys: KeyAgreementKeys;
  private readonly relays: RelayCandidate[];
  private relayIndex = 0;
  private identity: RelayIdentityCheck | null = null;
  private relayVerified = false;
  private challenge: Uint8Array | null = null;
  private authSent = false;
  /** This connection reached AUTH_OK (a later drop retries the same relay first). */
  private servedOnConnection = false;
  /** The relay said another node serves the name; failing over would split it. */
  private conflict = false;
  private chain: Grant[];
  private stopped = false;
  private reconnectDelay = RECONNECT_MIN_MS;
  private nextDelayOverride: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private servingWaiters: Array<() => void> = [];
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  /** Last refusal from the relay, for status output. */
  lastRefusal: string | null = null;

  constructor(private readonly options: ServiceNodeOptions) {
    if (options.relays.length === 0) throw new Error('at least one relay is required');
    this.relays = options.relays.map((relay) => {
      const endpoint = normalizeRelayEndpoint(relay.endpoint);
      if (!endpoint) throw new Error('relay endpoint must be a ws:// or wss:// URL');
      return { endpoint, relayKey: relay.relayKey };
    });
    this.now = options.now ?? nowSeconds;
    this.log = options.log ?? ((m) => console.log(`[service-node] ${m}`));
    this.chain = options.chain;
    const chainEnd = chainValidUntil(
      options.chain,
      options.chain[options.chain.length - 1].issuer,
      options.nodeKey.publicKey,
      options.name,
      this.now(),
    );
    if (chainEnd === null)
      throw new Error(`the grant chain does not authorize this node key for ${options.name}`);
    this.keys = new KeyAgreementKeys(options.name, options.nodeKey, chainEnd);
    this.circuits = new CircuitTable<SecureCircuit>(options.maxCircuits ?? DEFAULT_MAX_CIRCUITS);
  }

  get status(): ServiceNodeState {
    return this.state;
  }

  /** The relay this node is attached to (or trying). */
  get relayEndpoint(): string {
    return this.relays[this.relayIndex].endpoint;
  }

  private get endpoint(): string {
    return this.relayEndpoint;
  }

  get activeCircuits(): number {
    return this.circuits.size;
  }

  /** The certificate clients currently verify. */
  get kaCert(): KeyAgreementCertificate | undefined {
    return this.keys.current?.cert;
  }

  async start(): Promise<void> {
    this.keys.rotateIfNeeded(this.now());
    await this.publish();
    this.maintenanceTimer = setInterval(() => void this.maintain(), MAINTENANCE_INTERVAL_MS);
    this.maintenanceTimer.unref?.();
    const idleMs = this.options.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS;
    this.idleTimer = setInterval(
      () => {
        const cutoff = Date.now() - idleMs;
        for (const [, circuit] of this.circuits.entries()) {
          if (circuit.lastActivity < cutoff) circuit.reset(ErrorCode.RESOURCE_EXHAUSTED);
        }
      },
      Math.max(50, Math.min(30_000, Math.floor(idleMs / 2))),
    );
    this.idleTimer.unref?.();
    this.connect();
  }

  /** Resolves once the relay has accepted this node. */
  whenServing(): Promise<void> {
    if (this.state === 'serving') return Promise.resolve();
    return new Promise((resolve) => this.servingWaiters.push(resolve));
  }

  stop(): void {
    this.stopped = true;
    this.state = 'stopped';
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
    for (const circuit of this.circuits.drain()) circuit.abort();
    this.socket?.close();
  }

  private async publish(): Promise<void> {
    const cert = this.keys.current?.cert;
    if (!cert || !this.options.publish) return;
    await this.options.publish(this.chain, cert);
  }

  private async maintain(): Promise<void> {
    try {
      const now = this.now();
      const chainEnd = this.chain[0].notAfter;
      if (chainEnd - now < RENEW_GRANT_BEFORE && this.options.renewChain) {
        const renewed = this.options.renewChain();
        if (renewed) {
          this.chain = renewed;
          this.keys.setChainNotAfter(renewed[0].notAfter);
        }
      }
      if (this.keys.rotateIfNeeded(now)) await this.publish();
    } catch (err) {
      this.log(`credential maintenance failed: ${err instanceof Error ? err.message : 'error'}`);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.state = 'connecting';
    const relay = this.relays[this.relayIndex];
    this.identity = relay.relayKey ? new RelayIdentityCheck(relay.endpoint, relay.relayKey) : null;
    this.relayVerified = relay.relayKey === null;
    this.challenge = null;
    this.authSent = false;
    this.servedOnConnection = false;
    this.conflict = false;
    let opened: { socket: FrameSocket; ready: Promise<void> };
    try {
      opened = FrameSocket.open(
        `${this.endpoint}/service`,
        {
          onFrame: (frame) => this.onFrame(frame),
          onClose: () => this.onRelayClosed(opened.socket),
          onDrain: () => {
            for (const [, circuit] of this.circuits.entries()) circuit.poke();
          },
        },
        RELAY_CONNECT_TIMEOUT_MS,
      );
    } catch {
      this.scheduleReconnect();
      return;
    }
    // Set before the first frame can arrive: the relay's HELLO must be answerable.
    this.socket = opened.socket;
    this.state = 'authenticating';
    const socket = opened.socket;
    const identity = this.identity;
    opened.ready.then(
      () => {
        if (this.socket !== socket) return;
        if (identity) socket.send(identity.helloFrame());
        // A relay that neither proves itself nor accepts us is not waited on
        // forever: it is closed, and failed over.
        const timer = setTimeout(() => {
          if (this.socket === socket && !this.servedOnConnection) {
            this.log(`relay ${this.endpoint} did not complete the handshake in time`);
            socket.close(1008, 'handshake timeout');
          }
        }, 2 * RELAY_CONNECT_TIMEOUT_MS);
        timer.unref?.();
      },
      () => {
        // onClose schedules the reconnect.
      },
    );
  }

  private onRelayClosed(socket: FrameSocket | undefined): void {
    if (socket && this.socket !== socket) return; // an older connection
    this.socket = null;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    for (const circuit of this.circuits.drain()) circuit.remoteDestroyed();
    // A relay that never accepted us on this connection (unreachable, failed
    // its identity proof, refused us) is failed over to the next candidate. A
    // relay that served us and dropped is retried first: it is probably a
    // restart. A name conflict is not failed over — that would split the name.
    if (!this.servedOnConnection && !this.conflict && this.relays.length > 1) {
      this.relayIndex = (this.relayIndex + 1) % this.relays.length;
      this.log(`failing over to relay ${this.relayEndpoint}`);
      if (this.relayIndex !== 0) this.nextDelayOverride ??= RECONNECT_MIN_MS / 4;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.state = 'connecting';
    const base = this.nextDelayOverride ?? this.reconnectDelay;
    this.nextDelayOverride = null;
    // Jitter, so a relay restart is not followed by every node at once.
    const delay = Math.round(base * (0.5 + Math.random()));
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private send(frame: Uint8Array): boolean {
    return this.socket?.send(frame) ?? false;
  }

  private onFrame(frame: Frame): void {
    if (frame.type === FrameType.PING && frame.circuitId === 0n) {
      this.send(encodeFrame({ type: FrameType.PONG, payload: frame.payload }));
      return;
    }
    if (frame.type === FrameType.ERROR) {
      let code = 0;
      try {
        code = decodeError(frame.payload).code;
      } catch {
        // unreadable: treat as generic
      }
      this.lastRefusal = ERROR_CODE_NAMES[code] ?? 'ERROR';
      if (code === ErrorCode.ALREADY_REGISTERED) {
        this.log(
          `the relay is already serving ${this.options.name} from a DIFFERENT node key; ` +
            'it will not replace that node. Stop the other node, or use another relay.',
        );
        this.nextDelayOverride = RECONNECT_CONFLICT_MS;
        this.conflict = true;
      } else {
        this.log(`the relay refused this node (${this.lastRefusal})`);
      }
      return;
    }
    if (this.state === 'authenticating') {
      this.onAuthFrame(frame);
      return;
    }
    if (this.state !== 'serving') return;
    switch (frame.type) {
      case FrameType.CIRCUIT_CREATE:
        this.onCircuitCreate(frame);
        return;
      case FrameType.STREAM_DATA:
      case FrameType.CIRCUIT_DESTROY:
        this.circuits.get(frame.circuitId)?.receive(frame);
        return;
      default:
        return;
    }
  }

  private onAuthFrame(frame: Frame): void {
    if (frame.type === FrameType.HELLO) {
      if (this.challenge) return;
      this.challenge = decodeServiceHello(frame.payload);
      this.maybeAuthenticate();
      return;
    }
    if (frame.type === FrameType.HELLO_ACK && this.identity && !this.relayVerified) {
      try {
        this.identity.verify(frame);
      } catch (err) {
        this.lastRefusal = 'RELAY_IDENTITY';
        this.log(
          `REFUSING relay ${this.endpoint}: ${err instanceof Error ? err.message : 'identity not proven'}. ` +
            'It is not the relay the signed directory lists; this node did not authenticate to it.',
        );
        this.socket?.close(1008, 'relay identity not proven');
        return;
      }
      this.relayVerified = true;
      this.maybeAuthenticate();
      return;
    }
    if (frame.type === FrameType.AUTH_OK) {
      if (!this.authSent) return;
      this.state = 'serving';
      this.servedOnConnection = true;
      this.lastRefusal = null;
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.log(`serving ${this.options.name} via ${this.endpoint}`);
      for (const resolve of this.servingWaiters.splice(0)) resolve();
      if (this.options.heartbeat) {
        const endpoint = this.endpoint;
        const beat = () =>
          this.options.heartbeat?.(endpoint).catch((err: unknown) => {
            this.log(`heartbeat failed: ${err instanceof Error ? err.message : 'error'}`);
          });
        void beat();
        this.heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
      }
    }
  }

  /**
   * Send AUTH once both have happened: the relay's challenge arrived, and the
   * relay proved the directory's key. A node never hands its grant chain and
   * a signature to a relay that has not proved who it is.
   */
  private maybeAuthenticate(): void {
    const challenge = this.challenge;
    if (!challenge || !this.relayVerified || this.authSent) return;
    this.authSent = true;
    const signature = signServiceAuth(
      {
        name: this.options.name,
        endpoint: this.endpoint,
        challenge,
        nodeKey: this.options.nodeKey.publicKey,
      },
      this.options.nodeKey.secretKey,
    );
    this.send(
      encodeFrame({
        type: FrameType.AUTH,
        payload: encodeServiceAuth({ name: this.options.name, chain: this.chain, signature }),
      }),
    );
  }

  private destroy(id: bigint, reason: number = DESTROY_NORMAL): void {
    this.send(
      encodeFrame({
        type: FrameType.CIRCUIT_DESTROY,
        circuitId: id,
        payload: encodeDestroy(reason),
      }),
    );
  }

  private onCircuitCreate(frame: Frame): void {
    const id = frame.circuitId;
    if (id === 0n || this.circuits.has(id)) return;
    if (this.circuits.atCapacity) {
      this.destroy(id, ErrorCode.RESOURCE_EXHAUSTED);
      return;
    }

    let message1: Uint8Array;
    try {
      const create = decodeCircuitCreate(frame.payload);
      if (create.name !== this.options.name) {
        this.destroy(id, ErrorCode.CIRCUIT_REJECTED);
        return;
      }
      message1 = create.message1;
    } catch {
      this.destroy(id, ErrorCode.PROTOCOL_VIOLATION);
      return;
    }

    // NK cannot say which static key the client used, so try each one still
    // certified, newest first (at most two during a rotation).
    let response: { message: Uint8Array; session: SessionCipher } | null = null;
    for (const key of this.keys.active(this.now())) {
      try {
        response = new ServerHandshake({ staticKey: key.keyPair, name: this.options.name }).respond(
          message1,
        );
        break;
      } catch {
        // not this key (or a replayed / malformed message 1)
      }
    }
    if (!response) {
      this.destroy(id);
      return;
    }

    const socket = this.socket;
    if (!socket) return;
    // A client that completes the handshake and then says nothing must not
    // hold one of this node's circuit slots indefinitely.
    const openTimer = setTimeout(
      () => circuit.reset(ErrorCode.PROTOCOL_VIOLATION),
      OPEN_TIMEOUT_MS,
    );
    openTimer.unref?.();
    const circuit = new SecureCircuit(
      id,
      response.session,
      { send: (f) => socket.send(f), congested: () => socket.congested() },
      'service',
      {
        onOpen: (port) => {
          clearTimeout(openTimer);
          this.connectTarget(circuit, port);
        },
        onDone: () => {
          clearTimeout(openTimer);
          if (this.circuits.get(id) === circuit) this.circuits.delete(id);
        },
      },
    );
    this.circuits.add(id, circuit);
    this.send(
      encodeFrame({ type: FrameType.CIRCUIT_CREATED, circuitId: id, payload: response.message }),
    );
  }

  private connectTarget(circuit: SecureCircuit, _port: number): void {
    // One target per node: every requested port reaches it (service-nodes.md §2).
    const { host, port } = this.options.target;
    let connected = false;
    const target = net.connect({ host, port, allowHalfOpen: true });
    const timer = setTimeout(() => {
      if (!connected) target.destroy(new Error('timeout'));
    }, TARGET_CONNECT_TIMEOUT_MS);
    target.once('connect', () => {
      connected = true;
      clearTimeout(timer);
      if (circuit.closed) {
        target.destroy();
        return;
      }
      circuit.accept();
      pipeSocket(target, circuit, { abortCode: ErrorCode.TARGET_UNREACHABLE });
    });
    target.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (connected) return; // the pipe handles errors after connect
      // Sealed, generic: the client learns "refused" or "unreachable", never
      // the address or the error text (which used to include the LAN address).
      circuit.reset(
        err.code === 'ECONNREFUSED' ? ErrorCode.TARGET_REFUSED : ErrorCode.TARGET_UNREACHABLE,
      );
      this.log(`target connection failed (${err.code ?? 'error'})`);
    });
  }
}

// ---------------------------------------------------------------------------
// Credentials and the registry (`tnp serve`)
// ---------------------------------------------------------------------------

export interface ServiceNodeConfig {
  domain: string;
  localTarget: string;
  apiBaseUrl: string;
  /** In order of preference (relay-select.ts). */
  relays: RelayCandidate[];
  authToken: string;
  /** Overlay key directory; defaults to <data dir>/overlay. */
  storeRoot?: string;
}

export interface PreparedCredentials {
  nodeKey: SigningKeyPair;
  chain: Grant[];
  domainKey: string;
  /** Present when the domain key lives on this device: renews the grant. */
  renewChain: (() => Grant[] | null) | null;
}

/**
 * Load or create everything `tnp serve` needs, registering the domain key with
 * the registry on first use. Fails with an explanation when this device has
 * neither the domain key nor a grant from it.
 */
export async function prepareNodeCredentials(
  name: string,
  store: OverlayStore,
  api: Pick<TnpApiClient, 'getDomainKey' | 'registerDomainKey'>,
  authToken: string,
  now = nowSeconds(),
): Promise<PreparedCredentials> {
  const nodeKey = loadOrCreateNodeKey(store, name);
  let domainKey = loadKeyPair(store, 'domain-keys', name);
  const registered = await api.getDomainKey(name);

  if (!domainKey && !registered) {
    domainKey = createDomainKey(store, name);
    console.log(
      `[tnp] generated the domain key for ${name}: ${store.pathFor('domain-keys', name)}`,
    );
    console.log(
      '[tnp] BACK IT UP OFFLINE. It is the root of trust for this name: clients pin it, and without it you cannot rotate.',
    );
    console.log(
      '[tnp] It is now on the host that serves the name, the machine most exposed to the internet. ' +
        'Anyone who takes this host takes the name, and can sign rotations clients will follow. ' +
        'Safer: keep the domain key on an offline device and authorize this node from there ' +
        `(\`tnp domain grant ${name} --node-key <this node's key>\`), then delete ` +
        `${store.pathFor('domain-keys', name)} here.`,
    );
  }

  if (domainKey) {
    const pub = encodeBase64(domainKey.publicKey);
    if (!registered) {
      const request: RegisterDomainKeyRequest = { name, domainKey: pub };
      await api.registerDomainKey(request, authToken);
      console.log(`[tnp] registered the domain key for ${name} with the registry`);
    } else if (registered.domainKey !== pub) {
      throw new Error(
        `the registry holds a different domain key for ${name} than ${store.pathFor('domain-keys', name)}. ` +
          'If you rotated it on another device, issue a grant there (tnp domain grant) and save it as ' +
          `${store.pathFor('grants', name)}. If you did not rotate it, someone else may have.`,
      );
    }
    const owned = domainKey;
    const renew = (): Grant[] => {
      const chain = [issueNodeGrant(owned, nodeKey.publicKey, name, nowSeconds())];
      saveChain(store, name, chain);
      return chain;
    };
    const stored = loadStoredChain(store, name);
    const until = stored ? chainValidUntil(stored, pub, nodeKey.publicKey, name, now) : null;
    const chain = stored && until !== null && until - now > RENEW_GRANT_BEFORE ? stored : renew();
    return { nodeKey, chain, domainKey: pub, renewChain: renew };
  }

  // The domain key is on another device: this node needs a grant from it.
  const registeredKey = (registered as { domainKey: string }).domainKey;
  const stored = loadStoredChain(store, name);
  const until = stored
    ? chainValidUntil(stored, registeredKey, nodeKey.publicKey, name, now)
    : null;
  if (!stored || until === null) {
    throw new Error(
      `this device does not hold the domain key for ${name}, and has no valid grant from it.\n` +
        `  On the device that holds the domain key, run:\n` +
        `    tnp domain grant ${name} --node-key ${encodeBase64(nodeKey.publicKey)} --out grant.json\n` +
        `  then copy grant.json here as ${store.pathFor('grants', name)} (mode 0600).`,
    );
  }
  if (until - now < RENEW_GRANT_BEFORE) {
    console.warn(
      `[tnp] the grant for this node expires in ${Math.floor((until - now) / 86_400)} day(s); issue a new one`,
    );
  }
  return { nodeKey, chain: stored, domainKey: registeredKey, renewChain: null };
}

/** `tnp serve`: prepare credentials, publish, attach to the relay, run until signalled. */
export async function startServiceNode(
  config: ServiceNodeConfig,
  apiClient: TnpApiClient,
): Promise<ServiceNode> {
  const target = parseLocalTarget(config.localTarget);
  const store = new OverlayStore(config.storeRoot);
  const credentials = await prepareNodeCredentials(
    config.domain,
    store,
    apiClient,
    config.authToken,
  );
  console.log(`[service-node] node key: ${encodeBase64(credentials.nodeKey.publicKey)}`);
  console.log(`[service-node] domain key: ${credentials.domainKey}`);

  const domainId = await apiClient.lookupOwnedDomainId(config.domain, config.authToken);
  const node = new ServiceNode({
    name: config.domain,
    target,
    relays: config.relays,
    nodeKey: credentials.nodeKey,
    chain: credentials.chain,
    renewChain: credentials.renewChain ?? undefined,
    publish: (chain, kaCert) =>
      apiClient.registerServiceNode(domainId, chain, kaCert, config.authToken),
    heartbeat: (relayEndpoint) =>
      apiClient.sendHeartbeat(domainId, relayEndpoint, config.authToken),
  });
  await node.start();
  console.log(`[service-node] forwarding to ${target.host}:${target.port}`);

  const shutdown = () => {
    console.log('\n[service-node] shutting down...');
    node.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return node;
}
