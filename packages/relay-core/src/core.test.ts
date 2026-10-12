import { afterEach, describe, expect, test } from 'bun:test';
import {
  encodeBase64,
  generateSigningKeyPair,
  signServiceAuth,
  verifyRelayIdentity,
} from '@tnp/crypto';
import { makeTestCredentials, type TestServiceCredentials } from '@tnp/crypto/testing';
import {
  decodeDestroy,
  decodeError,
  decodeFrame,
  decodeRelayHelloAck,
  encodeCircuitCreate,
  encodeDestroy,
  encodeFrame,
  encodeServiceAuth,
  ErrorCode,
  type Frame,
  FrameType,
  HANDSHAKE_MESSAGE_SIZE,
  MAX_FRAME_PAYLOAD,
} from '@tnp/protocol/v1';
import { type ConnectionHandle, RelayCore, type RelayCoreOptions } from './core';

const ENDPOINT = 'wss://relay.example.test';
const NAME = 'example.ox';
const RELAY_KEY = generateSigningKeyPair();

class FakeTransport {
  frames: Frame[] = [];
  closedWith: number | null = null;
  buffered = 0;
  send(frame: Uint8Array): number {
    if (this.closedWith !== null) return 0;
    this.frames.push(decodeFrame(frame.slice()));
    return frame.length;
  }
  bufferedAmount(): number {
    return this.buffered;
  }
  close(code?: number): void {
    this.closedWith = code ?? 1000;
  }
  take(): Frame[] {
    const out = this.frames;
    this.frames = [];
    return out;
  }
  last(): Frame {
    const f = this.frames.at(-1);
    if (!f) throw new Error('no frame sent');
    return f;
  }
}

const cores: RelayCore[] = [];
afterEach(() => {
  for (const c of cores.splice(0)) c.shutdown();
});

function makeCore(keys: Record<string, string>, options: Partial<RelayCoreOptions> = {}) {
  const core = new RelayCore({
    endpoint: ENDPOINT,
    identity: RELAY_KEY,
    lookupDomainKey: async (name) => keys[name] ?? null,
    sweepIntervalMs: 60_000,
    ...options,
  });
  cores.push(core);
  return core;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

interface Peer {
  t: FakeTransport;
  h: ConnectionHandle;
}

function client(core: RelayCore, ip = '10.0.0.1'): Peer {
  expect(core.admit(ip).ok).toBe(true);
  const t = new FakeTransport();
  return { t, h: core.acceptClient(t, ip) };
}

async function service(
  core: RelayCore,
  creds: TestServiceCredentials,
  opts: { endpoint?: string; name?: string } = {},
): Promise<Peer> {
  expect(core.admit('10.9.9.9').ok).toBe(true);
  const t = new FakeTransport();
  const h = core.acceptService(t, '10.9.9.9');
  const hello = t.take()[0];
  expect(hello.type).toBe(FrameType.HELLO);
  const name = opts.name ?? creds.name;
  const signature = signServiceAuth(
    {
      name,
      endpoint: opts.endpoint ?? ENDPOINT,
      challenge: hello.payload,
      nodeKey: creds.nodeKey.publicKey,
    },
    creds.nodeKey.secretKey,
  );
  h.receive(
    encodeFrame({
      type: FrameType.AUTH,
      payload: encodeServiceAuth({ name, chain: creds.chain, signature }),
    }),
  );
  await flush();
  return { t, h };
}

function errorCode(frame: Frame): number {
  expect(frame.type).toBe(FrameType.ERROR);
  return decodeError(frame.payload).code;
}

const msg1 = new Uint8Array(HANDSHAKE_MESSAGE_SIZE).fill(1);
const msg2 = new Uint8Array(HANDSHAKE_MESSAGE_SIZE).fill(2);

function create(peer: Peer, id: bigint, name = NAME) {
  peer.h.receive(
    encodeFrame({
      type: FrameType.CIRCUIT_CREATE,
      circuitId: id,
      payload: encodeCircuitCreate(name, msg1),
    }),
  );
}

function data(peer: Peer, id: bigint, bytes: Uint8Array) {
  peer.h.receive(
    encodeFrame({ type: FrameType.STREAM_DATA, circuitId: id, streamId: 1, payload: bytes }),
  );
}

/** Open a circuit end to end; returns the service-side id. */
function openCircuit(c: Peer, s: Peer, id: bigint): bigint {
  create(c, id);
  const fwd = s.t.take().at(-1);
  if (!fwd || fwd.type !== FrameType.CIRCUIT_CREATE) throw new Error('create not forwarded');
  s.h.receive(
    encodeFrame({ type: FrameType.CIRCUIT_CREATED, circuitId: fwd.circuitId, payload: msg2 }),
  );
  const created = c.t.take().at(-1);
  expect(created?.type).toBe(FrameType.CIRCUIT_CREATED);
  expect(created?.circuitId).toBe(id);
  return fwd.circuitId;
}

describe('domain-key lookups', () => {
  test('identical lookups are coalesced and missing names are cached, bounded', async () => {
    let calls = 0;
    const creds = makeTestCredentials(NAME);
    const core = makeCore(
      {},
      {
        lookupDomainKey: async (name) => {
          calls++;
          await new Promise((r) => setTimeout(r, 20));
          return name === NAME ? creds.domainKeyB64 : null;
        },
        limits: { authBurstPerIp: 100 },
      },
    );
    // Several nodes authenticate for the same name at once: one lookup.
    await Promise.all([service(core, creds), service(core, creds), service(core, creds)]);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(1);
    // Random names: each looked up once, then answered from the negative cache.
    const random = makeTestCredentials('nobody.ox');
    await service(core, random);
    await new Promise((r) => setTimeout(r, 40));
    await service(core, random);
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(2);
  });

  test('AUTH attempts are rate-limited per address', async () => {
    const core = makeCore({}, { limits: { authBurstPerIp: 2, authRefillPerSecondPerIp: 0 } });
    const creds = makeTestCredentials('nobody.ox');
    await service(core, creds);
    await service(core, creds);
    const third = await service(core, creds);
    expect(errorCode(third.t.last())).toBe(ErrorCode.RATE_LIMIT);
  });
});

describe('service-node authentication (S2)', () => {
  test('a valid proof is accepted with AUTH_OK', async () => {
    const creds = makeTestCredentials(NAME);
    const core = makeCore({ [NAME]: creds.domainKeyB64 });
    const s = await service(core, creds);
    expect(s.t.last().type).toBe(FrameType.AUTH_OK);
    expect(core.stats().serviceNodes).toBe(1);
  });

  test('anything before AUTH is refused and the socket closed', async () => {
    const creds = makeTestCredentials(NAME);
    const core = makeCore({ [NAME]: creds.domainKeyB64 });
    core.admit('10.9.9.9');
    const t = new FakeTransport();
    const h = core.acceptService(t, '10.9.9.9');
    t.take();
    h.receive(encodeFrame({ type: FrameType.CIRCUIT_CREATED, circuitId: 5n, payload: msg2 }));
    expect(errorCode(t.last())).toBe(ErrorCode.AUTH_REQUIRED);
    expect(t.closedWith).not.toBeNull();
    expect(core.stats().serviceNodes).toBe(0);
  });

  test('a chain rooted anywhere but the registered domain key is refused', async () => {
    const creds = makeTestCredentials(NAME);
    const core = makeCore({ [NAME]: encodeBase64(generateSigningKeyPair().publicKey) });
    const s = await service(core, creds);
    expect(errorCode(s.t.last())).toBe(ErrorCode.AUTH_FAILED);
    expect(s.t.closedWith).not.toBeNull();
  });

  test('a name with no registered domain key is refused', async () => {
    const core = makeCore({});
    const s = await service(core, makeTestCredentials(NAME));
    expect(errorCode(s.t.last())).toBe(ErrorCode.AUTH_FAILED);
  });

  test('a registry failure fails closed', async () => {
    const creds = makeTestCredentials(NAME);
    const core = makeCore(
      {},
      {
        lookupDomainKey: async () => {
          throw new Error('down');
        },
      },
    );
    const s = await service(core, creds);
    expect(errorCode(s.t.last())).toBe(ErrorCode.AUTH_FAILED);
  });

  test('a proof signed for another relay endpoint is refused', async () => {
    const creds = makeTestCredentials(NAME);
    const core = makeCore({ [NAME]: creds.domainKeyB64 });
    const s = await service(core, creds, { endpoint: 'wss://other-relay.test' });
    expect(errorCode(s.t.last())).toBe(ErrorCode.AUTH_FAILED);
  });

  test('a grant for one name cannot serve another', async () => {
    const creds = makeTestCredentials(NAME);
    const core = makeCore({ [NAME]: creds.domainKeyB64, 'victim.ox': creds.domainKeyB64 });
    const s = await service(core, creds, { name: 'victim.ox' });
    expect(errorCode(s.t.last())).toBe(ErrorCode.AUTH_FAILED);
  });

  test('a second node with a different key does not evict the incumbent', async () => {
    const domainKey = generateSigningKeyPair();
    const first = makeTestCredentials(NAME, { domainKey });
    const second = makeTestCredentials(NAME, { domainKey });
    const core = makeCore({ [NAME]: first.domainKeyB64 });
    const s1 = await service(core, first);
    expect(s1.t.take().at(-1)?.type).toBe(FrameType.AUTH_OK);
    const s2 = await service(core, second);
    expect(errorCode(s2.t.last())).toBe(ErrorCode.ALREADY_REGISTERED);
    expect(s1.t.closedWith).toBeNull();
    // Circuits still reach the incumbent.
    const c = client(core);
    create(c, 77n);
    expect(s1.t.last().type).toBe(FrameType.CIRCUIT_CREATE);
    expect(s2.t.frames.filter((f) => f.type === FrameType.CIRCUIT_CREATE)).toHaveLength(0);
  });

  test('the same node key reconnecting replaces its own stale connection', async () => {
    const first = makeTestCredentials(NAME);
    const core = makeCore({ [NAME]: first.domainKeyB64 });
    const s1 = await service(core, first);
    const s2 = await service(core, first);
    expect(s2.t.last().type).toBe(FrameType.AUTH_OK);
    expect(s1.t.closedWith).not.toBeNull();
  });

  test('a node whose domain key was rotated is dropped on re-check', async () => {
    const creds = makeTestCredentials(NAME);
    const keys: Record<string, string> = { [NAME]: creds.domainKeyB64 };
    let now = Date.now();
    const core = makeCore(keys, { clock: () => now, sweepIntervalMs: 5 });
    const s = await service(core, creds);
    expect(s.t.last().type).toBe(FrameType.AUTH_OK);
    keys[NAME] = encodeBase64(generateSigningKeyPair().publicKey);
    now += core.limits.reauthIntervalMs + 1;
    await new Promise((r) => setTimeout(r, 30));
    expect(errorCode(s.t.last())).toBe(ErrorCode.REVOKED);
    expect(core.stats().serviceNodes).toBe(0);
  });

  test('a service node that never authenticates is dropped after the handshake timeout', async () => {
    let now = Date.now();
    const core = makeCore({}, { clock: () => now, sweepIntervalMs: 5 });
    core.admit('10.9.9.9');
    const t = new FakeTransport();
    core.acceptService(t, '10.9.9.9');
    now += core.limits.handshakeTimeoutMs + 1;
    await new Promise((r) => setTimeout(r, 30));
    expect(t.closedWith).not.toBeNull();
  });
});

describe('circuits (S1)', () => {
  async function setup() {
    const creds = makeTestCredentials(NAME);
    const core = makeCore({ [NAME]: creds.domainKeyB64 });
    const s = await service(core, creds);
    s.t.take();
    return { core, s };
  }

  test('frames are forwarded with only the circuit id rewritten', async () => {
    const { core, s } = await setup();
    const c = client(core);
    const serviceId = openCircuit(c, s, 42n);
    expect(serviceId).not.toBe(42n);
    const payload = new Uint8Array([9, 8, 7]);
    data(c, 42n, payload);
    const fwd = s.t.take()[0];
    expect(fwd).toMatchObject({ type: FrameType.STREAM_DATA, circuitId: serviceId, streamId: 1 });
    expect(fwd.payload).toEqual(payload);
    s.h.receive(
      encodeFrame({ type: FrameType.STREAM_DATA, circuitId: serviceId, streamId: 1, payload }),
    );
    expect(c.t.take()[0]).toMatchObject({ type: FrameType.STREAM_DATA, circuitId: 42n });
  });

  test("another connection's circuit id reaches nothing", async () => {
    const { core, s } = await setup();
    const victim = client(core, '10.0.0.1');
    const attacker = client(core, '10.0.0.2');
    openCircuit(victim, s, 1000n);
    data(attacker, 1000n, new Uint8Array([1]));
    attacker.h.receive(
      encodeFrame({ type: FrameType.CIRCUIT_DESTROY, circuitId: 1000n, payload: encodeDestroy(0) }),
    );
    expect(s.t.take()).toHaveLength(0);
    expect(victim.t.take()).toHaveLength(0);
    // The victim's circuit still works.
    data(victim, 1000n, new Uint8Array([2]));
    expect(s.t.take()[0]?.type).toBe(FrameType.STREAM_DATA);
    expect(core.stats().framesDropped).toBe(2);
  });

  test('two connections may use the same id without interacting', async () => {
    const { core, s } = await setup();
    const a = client(core, '10.0.0.1');
    const b = client(core, '10.0.0.2');
    const sa = openCircuit(a, s, 1n);
    const sb = openCircuit(b, s, 1n);
    expect(sa).not.toBe(sb);
    data(b, 1n, new Uint8Array([0xbb]));
    expect(s.t.take()[0].circuitId).toBe(sb);
    b.h.receive(
      encodeFrame({ type: FrameType.CIRCUIT_DESTROY, circuitId: 1n, payload: encodeDestroy(0) }),
    );
    data(a, 1n, new Uint8Array([0xaa]));
    const frames = s.t.take();
    expect(frames.at(-1)?.circuitId).toBe(sa);
  });

  test('a duplicate CREATE never replaces the existing circuit', async () => {
    const { core, s } = await setup();
    const c = client(core);
    const serviceId = openCircuit(c, s, 5n);
    create(c, 5n);
    expect(s.t.take()).toHaveLength(0);
    data(c, 5n, new Uint8Array([1]));
    expect(s.t.take()[0].circuitId).toBe(serviceId);
  });

  test('the service node cannot answer a circuit that is not pending on its connection', async () => {
    const { core, s } = await setup();
    const c = client(core);
    s.h.receive(encodeFrame({ type: FrameType.CIRCUIT_CREATED, circuitId: 99n, payload: msg2 }));
    expect(c.t.take()).toHaveLength(0);
  });

  test('CIRCUIT_CREATED only ever comes from the service node, never the relay', async () => {
    const { core, s } = await setup();
    const c = client(core);
    create(c, 8n);
    // Nothing goes back to the client until the service node answers.
    expect(c.t.take()).toHaveLength(0);
    expect(s.t.take()[0].type).toBe(FrameType.CIRCUIT_CREATE);
  });

  test('data before CIRCUIT_CREATED destroys the circuit', async () => {
    const { core, s } = await setup();
    const c = client(core);
    create(c, 3n);
    s.t.take();
    data(c, 3n, new Uint8Array([1]));
    expect(c.t.last().type).toBe(FrameType.CIRCUIT_DESTROY);
    expect(s.t.last().type).toBe(FrameType.CIRCUIT_DESTROY);
    expect(core.stats().circuits).toBe(0);
  });

  test('an unknown name is rejected with a destroy, not an error string', async () => {
    const { core } = await setup();
    const c = client(core);
    create(c, 4n, 'nobody.ox');
    const f = c.t.last();
    expect(f.type).toBe(FrameType.CIRCUIT_DESTROY);
    expect(decodeDestroy(f.payload)).toBe(ErrorCode.CIRCUIT_REJECTED);
  });

  test('the v0 OPEN payload is a protocol violation for that circuit only', async () => {
    const { core } = await setup();
    const c = client(core);
    c.h.receive(
      encodeFrame({
        type: FrameType.CIRCUIT_CREATE,
        circuitId: 6n,
        payload: new TextEncoder().encode('example.ox\0AAAA'),
      }),
    );
    expect(decodeDestroy(c.t.last().payload)).toBe(ErrorCode.PROTOCOL_VIOLATION);
    expect(c.t.closedWith).toBeNull();
  });

  test('closing the service node destroys its circuits at the clients', async () => {
    const { core, s } = await setup();
    const c = client(core);
    openCircuit(c, s, 11n);
    s.h.closed();
    expect(c.t.last()).toMatchObject({ type: FrameType.CIRCUIT_DESTROY, circuitId: 11n });
    expect(core.stats().serviceNodes).toBe(0);
    expect(core.stats().circuits).toBe(0);
  });

  test('100 concurrent circuits across clients stay isolated', async () => {
    const { core, s } = await setup();
    const clients = Array.from({ length: 8 }, (_, i) => client(core, `10.0.1.${i}`));
    const map = new Map<bigint, { peer: Peer; id: bigint }>();
    for (let i = 0; i < 100; i++) {
      const peer = clients[i % 8];
      const id = BigInt(Math.floor(i / 8)) + 1n; // ids collide across connections on purpose
      map.set(openCircuit(peer, s, id), { peer, id });
    }
    expect(core.stats().circuits).toBe(100);
    for (const [serviceId, { peer, id }] of map) {
      s.h.receive(
        encodeFrame({
          type: FrameType.STREAM_DATA,
          circuitId: serviceId,
          streamId: 1,
          payload: new Uint8Array([Number(id)]),
        }),
      );
      const got = peer.t.take();
      expect(got).toHaveLength(1);
      expect(got[0].circuitId).toBe(id);
      for (const other of clients) if (other !== peer) expect(other.t.frames).toHaveLength(0);
    }
  });
});

describe('bounds (S6)', () => {
  async function setup(options: Partial<RelayCoreOptions> = {}) {
    const creds = makeTestCredentials(NAME);
    const core = makeCore({ [NAME]: creds.domainKeyB64 }, options);
    const s = await service(core, creds);
    s.t.take();
    return { core, s };
  }

  test('a client cannot hold more than 64 circuits', async () => {
    const { core, s } = await setup({
      limits: {
        createBurstPerIp: 1000,
        maxCircuitsPerClientPerService: 1000,
        maxCircuitsPerIpPerService: 1000,
      },
    });
    const c = client(core);
    for (let i = 1; i <= 64; i++) openCircuit(c, s, BigInt(i));
    create(c, 65n);
    expect(decodeDestroy(c.t.last().payload)).toBe(ErrorCode.CIRCUIT_LIMIT);
  });

  test('one address cannot take every circuit slot of a service; an innocent client still gets in', async () => {
    // Handshake rate limits are generous here so the per-service cap is what refuses.
    const { core, s } = await setup({ limits: { createBurstPerIp: 10_000 } });
    // The attacker opens as many circuits as it can, over many connections
    // from one address, and holds them.
    const attackerConns = Array.from({ length: 8 }, () => client(core, '10.6.6.6'));
    let held = 0;
    let refused = 0;
    for (const conn of attackerConns) {
      for (let i = 1; i <= 40; i++) {
        create(conn, BigInt(i));
        const fwd = s.t.take().at(-1);
        if (fwd?.type === FrameType.CIRCUIT_CREATE) {
          s.h.receive(
            encodeFrame({
              type: FrameType.CIRCUIT_CREATED,
              circuitId: fwd.circuitId,
              payload: msg2,
            }),
          );
          held++;
        }
        const last = conn.t.take().at(-1);
        if (last?.type === FrameType.CIRCUIT_DESTROY) {
          expect(decodeDestroy(last.payload)).toBe(ErrorCode.CIRCUIT_LIMIT);
          refused++;
        }
      }
    }
    expect(held).toBe(core.limits.maxCircuitsPerIpPerService);
    expect(held).toBeLessThan(core.limits.maxCircuitsPerService);
    expect(refused).toBeGreaterThan(0);
    // An innocent client from another address opens a circuit normally.
    const innocent = client(core, '10.1.2.3');
    openCircuit(innocent, s, 1n);
  });

  test('one connection is capped per service even below the address cap', async () => {
    const { core, s } = await setup({ limits: { maxCircuitsPerIpPerService: 1000 } });
    const c = client(core);
    for (let i = 1; i <= core.limits.maxCircuitsPerClientPerService; i++)
      openCircuit(c, s, BigInt(i));
    create(c, 999n);
    expect(decodeDestroy(c.t.last().payload)).toBe(ErrorCode.CIRCUIT_LIMIT);
    // Closing one frees a slot.
    c.h.receive(
      encodeFrame({ type: FrameType.CIRCUIT_DESTROY, circuitId: 1n, payload: encodeDestroy(0) }),
    );
    openCircuit(c, s, 1000n);
  });

  test('an open circuit with no traffic is destroyed after the idle timeout', async () => {
    let now = Date.now();
    const { core, s } = await setup({ clock: () => now, sweepIntervalMs: 5 });
    const c = client(core);
    openCircuit(c, s, 1n);
    now += core.limits.circuitIdleMs + 1;
    await new Promise((r) => setTimeout(r, 30));
    expect(c.t.last().type).toBe(FrameType.CIRCUIT_DESTROY);
    expect(core.stats().circuits).toBe(0);
    expect(core.stats().idleDestroys).toBe(1);
  });

  test('the global buffer budget closes the largest offenders first', async () => {
    const { core } = await setup({ sweepIntervalMs: 5, limits: { globalBufferLimit: 1000 } });
    const small = client(core, '10.0.0.1');
    const big = client(core, '10.0.0.2');
    const medium = client(core, '10.0.0.3');
    small.t.buffered = 100;
    big.t.buffered = 900;
    medium.t.buffered = 500;
    await new Promise((r) => setTimeout(r, 30));
    expect(big.t.closedWith).toBe(1013);
    expect(medium.t.closedWith).toBeNull();
    expect(small.t.closedWith).toBeNull();
    expect(core.stats().memoryCloses).toBe(1);
  });

  test('pending opens are bounded', async () => {
    const { core } = await setup();
    const c = client(core);
    for (let i = 1; i <= 32; i++) create(c, BigInt(i));
    c.t.take();
    create(c, 33n);
    expect(decodeDestroy(c.t.last().payload)).toBe(ErrorCode.CIRCUIT_LIMIT);
  });

  test('handshakes are rate limited per address before reaching the service node', async () => {
    const { core, s } = await setup({
      limits: { createBurstPerIp: 3, createRefillPerSecondPerIp: 0 },
    });
    const c = client(core);
    for (let i = 1; i <= 3; i++) create(c, BigInt(i));
    expect(s.t.take()).toHaveLength(3);
    create(c, 4n);
    expect(decodeDestroy(c.t.last().payload)).toBe(ErrorCode.RATE_LIMIT);
    expect(s.t.take()).toHaveLength(0);
  });

  test('an unanswered circuit is destroyed after the create timeout', async () => {
    let now = Date.now();
    const { core } = await setup({ clock: () => now, sweepIntervalMs: 5 });
    const c = client(core);
    create(c, 1n);
    now += core.limits.createTimeoutMs + 1;
    await new Promise((r) => setTimeout(r, 30));
    expect(decodeDestroy(c.t.last().payload)).toBe(ErrorCode.TARGET_UNREACHABLE);
    expect(core.stats().circuits).toBe(0);
  });

  test('an oversized or malformed frame closes the connection', async () => {
    const { core } = await setup();
    const big = client(core, '10.0.0.3');
    big.h.receive(new Uint8Array(20 + MAX_FRAME_PAYLOAD + 1));
    expect(big.t.closedWith).toBe(1009);
    const junk = client(core, '10.0.0.4');
    junk.h.receive(new Uint8Array([1, 2, 3]));
    expect(errorCode(junk.t.last())).toBe(ErrorCode.PROTOCOL_VIOLATION);
    expect(junk.t.closedWith).not.toBeNull();
    const v0 = client(core, '10.0.0.5');
    v0.h.receive(new Uint8Array([0, 0, 0, 1, 2, 0x65]));
    expect(v0.t.closedWith).not.toBeNull();
  });

  test('a sender filling a slow destination loses its circuit, not the destination', async () => {
    const { core, s } = await setup();
    const fast = client(core, '10.0.0.1');
    const other = client(core, '10.0.0.2');
    openCircuit(fast, s, 1n);
    openCircuit(other, s, 1n);
    s.t.buffered = core.limits.serviceBufferLimit; // the service node has stopped reading
    data(fast, 1n, new Uint8Array(1000));
    expect(decodeDestroy(fast.t.last().payload)).toBe(ErrorCode.RESOURCE_EXHAUSTED);
    expect(s.t.closedWith).toBeNull();
    expect(core.stats().backpressureDestroys).toBe(1);
    // Memory did not grow: nothing was queued for the stalled destination.
    expect(s.t.frames.filter((f) => f.type === FrameType.STREAM_DATA)).toHaveLength(0);
    s.t.buffered = 0;
    data(other, 1n, new Uint8Array(10));
    expect(s.t.frames.at(-1)?.type).toBe(FrameType.STREAM_DATA);
  });

  test('frames for unowned circuits are dropped without closing an honest connection', async () => {
    const { core } = await setup();
    const c = client(core);
    for (let i = 0; i <= core.limits.maxViolations * 2; i++) data(c, 12345n, new Uint8Array([1]));
    expect(c.t.closedWith).toBeNull();
    expect(core.stats().framesDropped).toBe(core.limits.maxViolations * 2 + 1);
  });

  test('a stream of frames a client may not send closes the connection', async () => {
    const { core } = await setup();
    const c = client(core);
    for (let i = 0; i <= core.limits.maxViolations; i++) {
      c.h.receive(encodeFrame({ type: FrameType.CIRCUIT_CREATED, circuitId: 5n, payload: msg2 }));
    }
    expect(c.t.closedWith).not.toBeNull();
  });

  test('per-address connection limits apply before the upgrade', () => {
    const core = makeCore({}, { limits: { maxConnectionsPerIp: 2 } });
    expect(core.admit('1.2.3.4').ok).toBe(true);
    expect(core.admit('1.2.3.4').ok).toBe(true);
    expect(core.admit('1.2.3.4')).toEqual({
      ok: false,
      status: 429,
      reason: 'too many connections',
    });
    expect(core.admit('1.2.3.5').ok).toBe(true);
  });

  test('a throw inside dispatch cannot take the relay down', async () => {
    const { core } = await setup();
    const c = client(core);
    // Not a Uint8Array at all.
    c.h.receive(null as unknown as Uint8Array);
    expect(c.t.closedWith).not.toBeNull();
    expect(core.stats().connections).toBeGreaterThan(0);
  });
});

describe('relay identity proof (transport.md §6.2)', () => {
  const hello = (nonce: Uint8Array) => encodeFrame({ type: FrameType.HELLO, payload: nonce });

  test('a client HELLO is answered with a proof over the endpoint, its nonce and the relay key', () => {
    const core = makeCore({});
    const c = client(core);
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    c.h.receive(hello(nonce));
    const ack = c.t.last();
    expect(ack.type).toBe(FrameType.HELLO_ACK);
    const { relayKey, signature } = decodeRelayHelloAck(ack.payload);
    expect(relayKey).toEqual(RELAY_KEY.publicKey);
    expect(verifyRelayIdentity({ endpoint: ENDPOINT, nonce, relayKey }, signature)).toBe(true);
    // Bound to this nonce and this endpoint.
    const other = crypto.getRandomValues(new Uint8Array(32));
    expect(verifyRelayIdentity({ endpoint: ENDPOINT, nonce: other, relayKey }, signature)).toBe(
      false,
    );
    expect(
      verifyRelayIdentity({ endpoint: 'wss://elsewhere.example', nonce, relayKey }, signature),
    ).toBe(false);
  });

  test('one proof per connection; a malformed HELLO closes it', () => {
    const core = makeCore({});
    const c = client(core);
    c.h.receive(hello(new Uint8Array(32)));
    c.t.take();
    c.h.receive(hello(new Uint8Array(32)));
    expect(c.t.frames).toHaveLength(0);
    expect(core.stats().framesDropped).toBe(1);

    const d = client(core, '10.0.0.2');
    d.h.receive(hello(new Uint8Array(31)));
    expect(errorCode(d.t.last())).toBe(ErrorCode.PROTOCOL_VIOLATION);
    expect(d.t.closedWith).not.toBeNull();
  });

  test('a service node may verify the relay before it authenticates', async () => {
    const creds = makeTestCredentials(NAME);
    const core = makeCore({ [NAME]: creds.domainKeyB64 });
    expect(core.admit('10.9.9.9').ok).toBe(true);
    const t = new FakeTransport();
    const h = core.acceptService(t, '10.9.9.9');
    const challenge = t.take()[0];
    expect(challenge.type).toBe(FrameType.HELLO);
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    h.receive(hello(nonce));
    const ack = t.take()[0];
    expect(ack.type).toBe(FrameType.HELLO_ACK);
    const { relayKey, signature } = decodeRelayHelloAck(ack.payload);
    expect(verifyRelayIdentity({ endpoint: ENDPOINT, nonce, relayKey }, signature)).toBe(true);
    // And the connection is still awaiting AUTH, which then succeeds.
    const sig = signServiceAuth(
      {
        name: NAME,
        endpoint: ENDPOINT,
        challenge: challenge.payload,
        nodeKey: creds.nodeKey.publicKey,
      },
      creds.nodeKey.secretKey,
    );
    h.receive(
      encodeFrame({
        type: FrameType.AUTH,
        payload: encodeServiceAuth({ name: NAME, chain: creds.chain, signature: sig }),
      }),
    );
    await flush();
    expect(t.last().type).toBe(FrameType.AUTH_OK);
  });

  test('a relay refuses to start with a key pair whose halves disagree', () => {
    const other = generateSigningKeyPair();
    expect(() =>
      makeCore({}, { identity: { publicKey: other.publicKey, secretKey: RELAY_KEY.secretKey } }),
    ).toThrow();
  });
});
