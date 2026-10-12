/**
 * The relay is assumed hostile (transport.md §9). A man-in-the-middle relay
 * wrapper sits between the client and a real relay and attacks the circuit:
 * replay, reordering, reflection, tampering, truncation and impersonation.
 * Each must be DETECTED end to end — the circuit fails with the matching code
 * and no altered byte ever reaches the application.
 *
 * Plus the network-level refusals: unauthenticated and competing service
 * nodes, and malformed input aimed at a service node.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { generateSigningKeyPair, signServiceAuth } from '@tnp/crypto';
import { generateX25519KeyPair } from '@tnp/crypto/primitives';
import { makeTestCredentials } from '@tnp/crypto/testing';
import {
  decodeError,
  decodeFrame,
  encodeCircuitCreate,
  encodeFrame,
  encodeServiceAuth,
  ErrorCode,
  FrameType,
  HANDSHAKE_MESSAGE_SIZE,
  type SessionError,
} from '@tnp/protocol/v1';
import type { SecureCircuit } from './overlay/secure-circuit';
import { ServiceNode } from './service-node';
import {
  freePort,
  type Harness,
  httpGet,
  patternBytes,
  socksFetch,
  splitHttp,
  startHarness,
} from './testing/overlay-harness';
import { TunnelError } from './tunnel';

const harnesses: Harness[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.stop();
  for (const c of cleanups.splice(0)) await c();
});

type Direction = 'to-client' | 'to-relay';

interface Wire {
  toClient(bytes: Uint8Array): void;
  toRelay(bytes: Uint8Array): void;
}

/** Return the frames to actually deliver (in order) for one observed frame. */
type Tamper = (dir: Direction, bytes: Uint8Array, wire: Wire) => Uint8Array[];

/** A WebSocket MITM in front of a real relay's /tunnel. */
async function hostileRelay(upstream: string, tamper: Tamper): Promise<string> {
  const port = await freePort();
  interface Data {
    up?: WebSocket;
    queue: Uint8Array[];
  }
  const server = Bun.serve<Data>({
    hostname: '127.0.0.1',
    port,
    fetch(req, srv) {
      if (srv.upgrade(req, { data: { queue: [] } })) return undefined;
      return new Response('no', { status: 400 });
    },
    websocket: {
      open(ws: ServerWebSocket<Data>) {
        const up = new WebSocket(`${upstream}/tunnel`);
        up.binaryType = 'arraybuffer';
        ws.data.up = up;
        const wire: Wire = {
          toClient: (b) => ws.sendBinary(b),
          toRelay: (b) => up.send(b as Uint8Array<ArrayBuffer>),
        };
        up.addEventListener('open', () => {
          for (const q of ws.data.queue.splice(0))
            for (const b of tamper('to-relay', q, wire)) up.send(b as Uint8Array<ArrayBuffer>);
        });
        up.addEventListener('message', (e) => {
          const bytes = new Uint8Array(e.data as ArrayBuffer);
          for (const b of tamper('to-client', bytes, wire)) ws.sendBinary(b);
        });
        up.addEventListener('close', () => ws.close());
        (ws.data as Data & { wire: Wire }).wire = wire;
      },
      message(ws: ServerWebSocket<Data>, msg) {
        const bytes = new Uint8Array(msg as Buffer);
        const up = ws.data.up;
        if (!up || up.readyState !== WebSocket.OPEN) {
          ws.data.queue.push(bytes.slice());
          return;
        }
        const wire = (ws.data as Data & { wire: Wire }).wire;
        for (const b of tamper('to-relay', bytes, wire)) up.send(b as Uint8Array<ArrayBuffer>);
      },
      close(ws: ServerWebSocket<Data>) {
        ws.data.up?.close();
      },
    },
  });
  cleanups.push(() => server.stop(true));
  return `ws://127.0.0.1:${port}`;
}

function typeOf(bytes: Uint8Array): number {
  return bytes[1];
}

function counterOf(bytes: Uint8Array): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset + 20, 8).getBigUint64(0, false);
}

/** Open a stream through the hostile relay, send a GET, and report how it ended. */
async function attack(
  tamper: Tamper,
): Promise<{ error: SessionError | null; received: Buffer; h: Harness }> {
  let hostile = '';
  const h = await startHarness({
    clientRelay: () => hostile,
    externalRelay: undefined,
  }).then(async (harness) => harness);
  harnesses.push(h);
  hostile = await hostileRelay(h.relayEndpoint, tamper);
  const circuit = await h.tunnels.openStream('example.ox', 80);
  return run(circuit, h);
}

function run(
  circuit: SecureCircuit,
  h: Harness,
): Promise<{ error: SessionError | null; received: Buffer; h: Harness }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    circuit.bind({
      onData: (d) => {
        chunks.push(Buffer.from(d));
        circuit.consumed(d.length);
      },
      onEnd: () => {},
      onWritable: () => {},
      onClose: (error) => resolve({ error, received: Buffer.concat(chunks), h }),
    });
    circuit.write(new TextEncoder().encode(httpGet(400_000)));
    circuit.end();
  });
}

describe('a hostile relay is detected end to end', () => {
  test('control: the unmodified wrapper delivers the exact bytes', async () => {
    const { error, received } = await attack((_d, b) => [b]);
    expect(error).toBeNull();
    expect(splitHttp(received).payload.equals(patternBytes(400_000))).toBe(true);
  });

  test('replaying a record is REPLAY_DETECTED', async () => {
    let first: Uint8Array | null = null;
    let count = 0;
    const { error } = await attack((dir, b) => {
      if (dir !== 'to-client' || typeOf(b) !== FrameType.STREAM_DATA) return [b];
      count++;
      if (count === 1) first = b.slice();
      if (count === 3 && first) return [b, first];
      return [b];
    });
    expect(error?.code).toBe(ErrorCode.REPLAY_DETECTED);
  });

  test('reordering records is refused (counter gap)', async () => {
    let held: Uint8Array | null = null;
    let count = 0;
    const { error, received } = await attack((dir, b) => {
      if (dir !== 'to-client' || typeOf(b) !== FrameType.STREAM_DATA) return [b];
      count++;
      if (count === 2) {
        held = b.slice();
        return [];
      }
      if (count === 3 && held) return [b, held];
      return [b];
    });
    expect(error?.code).toBe(ErrorCode.PROTOCOL_VIOLATION);
    // Nothing past the gap was delivered.
    expect(received.length).toBe(0);
  });

  test("reflecting the client's own record back to it fails authentication", async () => {
    const heldToClient: Uint8Array[] = [];
    let opened = false;
    let reflected = false;
    const { error } = await attack((dir, b, wire) => {
      if (typeOf(b) !== FrameType.STREAM_DATA) return [b];
      if (dir === 'to-client') {
        if (!opened) {
          opened = true;
          return [b];
        }
        if (!reflected) {
          heldToClient.push(b.slice());
          return [];
        }
        return [b];
      }
      // to-relay: the client's record with counter 1 is exactly the counter the
      // client expects next from the service node — only the key differs.
      if (!reflected && counterOf(b) === 1n) {
        reflected = true;
        wire.toClient(b.slice());
        for (const held of heldToClient.splice(0)) wire.toClient(held);
      }
      return [b];
    });
    expect(error?.code).toBe(ErrorCode.DECRYPT_FAILED);
  });

  test('flipping one ciphertext bit is DECRYPT_FAILED', async () => {
    let count = 0;
    const { error } = await attack((dir, b) => {
      if (dir !== 'to-client' || typeOf(b) !== FrameType.STREAM_DATA) return [b];
      count++;
      if (count === 2) {
        const copy = b.slice();
        copy[copy.length - 20] ^= 0x01;
        return [copy];
      }
      return [b];
    });
    expect(error?.code).toBe(ErrorCode.DECRYPT_FAILED);
  });

  test('moving a record to another stream id fails authentication (AD binding)', async () => {
    let count = 0;
    const { error } = await attack((dir, b) => {
      if (dir !== 'to-client' || typeOf(b) !== FrameType.STREAM_DATA) return [b];
      count++;
      if (count === 2) {
        const copy = b.slice();
        new DataView(copy.buffer).setUint32(12, 1, false);
        copy[15] = 2; // stream 2
        return [copy];
      }
      return [b];
    });
    expect(error).not.toBeNull();
  });

  test('cutting the circuit before the service node finished is TRUNCATED', async () => {
    let count = 0;
    let cut = false;
    const { error, received } = await attack((dir, b, wire) => {
      if (dir !== 'to-client') return [b];
      if (cut) return [];
      if (typeOf(b) === FrameType.STREAM_DATA && ++count === 4) {
        cut = true;
        const destroy = encodeFrame({
          type: FrameType.CIRCUIT_DESTROY,
          circuitId: new DataView(b.buffer, b.byteOffset + 4, 8).getBigUint64(0, false),
          payload: new Uint8Array(2),
        });
        wire.toClient(destroy);
        return [];
      }
      return [b];
    });
    expect(error?.code).toBe(ErrorCode.TRUNCATED);
    expect(received.length).toBeLessThan(400_000);
  });

  test('through SOCKS, truncation resets the application socket rather than ending it cleanly', async () => {
    let hostile = '';
    const h = await startHarness({ clientRelay: () => hostile });
    harnesses.push(h);
    let count = 0;
    let cut = false;
    hostile = await hostileRelay(h.relayEndpoint, (dir, b, wire) => {
      if (dir !== 'to-client') return [b];
      if (cut) return [];
      if (typeOf(b) === FrameType.STREAM_DATA && ++count === 4) {
        cut = true;
        wire.toClient(
          encodeFrame({
            type: FrameType.CIRCUIT_DESTROY,
            circuitId: new DataView(b.buffer, b.byteOffset + 4, 8).getBigUint64(0, false),
            payload: new Uint8Array(2),
          }),
        );
        return [];
      }
      return [b];
    });
    const res = await socksFetch(h.socks.port, 'example.ox', 80, httpGet(400_000));
    expect(res.reply).toBe(0);
    expect(res.error).toBe('reset');
  });

  test('a relay that answers the handshake itself fails key confirmation', async () => {
    let hostile = '';
    const h = await startHarness({ clientRelay: () => hostile });
    harnesses.push(h);
    hostile = await hostileRelay(h.relayEndpoint, (dir, b, wire) => {
      if (dir === 'to-relay' && typeOf(b) === FrameType.CIRCUIT_CREATE) {
        const frame = decodeFrame(b);
        wire.toClient(
          encodeFrame({
            type: FrameType.CIRCUIT_CREATED,
            circuitId: frame.circuitId,
            // A well-formed message 2 from the relay's own ephemeral: valid
            // curve point, but the relay cannot produce the tag.
            payload: new Uint8Array([
              ...generateX25519KeyPair().publicKey,
              ...crypto.getRandomValues(new Uint8Array(HANDSHAKE_MESSAGE_SIZE - 32)),
            ]),
          }),
        );
        return [];
      }
      return [b];
    });
    const err = await h.tunnels.openStream('example.ox', 80).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TunnelError);
    expect((err as TunnelError).code).toBe(ErrorCode.AUTH_FAILED);
  });
});

describe('service-node authentication at a real relay', () => {
  test('an unauthenticated /service connection is refused and closed', async () => {
    const h = await startHarness();
    harnesses.push(h);
    const ws = new WebSocket(`${h.relayEndpoint}/service?domain=example.ox`);
    ws.binaryType = 'arraybuffer';
    const frames: number[] = [];
    let errorCode = -1;
    const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve()));
    ws.addEventListener('message', (e) => {
      const f = decodeFrame(new Uint8Array(e.data as ArrayBuffer));
      frames.push(f.type);
      if (f.type === FrameType.HELLO) {
        // Claim the name without proving anything.
        ws.send(
          encodeFrame({
            type: FrameType.CIRCUIT_CREATED,
            circuitId: 1n,
            payload: new Uint8Array(48),
          }),
        );
      }
      if (f.type === FrameType.ERROR) errorCode = decodeError(f.payload).code;
    });
    await closed;
    expect(errorCode).toBe(ErrorCode.AUTH_REQUIRED);
    // The genuine node still serves.
    const res = await socksFetch(h.socks.port, 'example.ox', 80, httpGet(100));
    expect(splitHttp(res.body).payload.equals(patternBytes(100))).toBe(true);
  });

  test('a forged proof for the name (wrong domain key) is refused', async () => {
    const h = await startHarness();
    harnesses.push(h);
    const forged = makeTestCredentials('example.ox'); // its own, unregistered domain key
    const node = new ServiceNode({
      name: 'example.ox',
      target: { host: '127.0.0.1', port: h.target.port },
      relayEndpoint: h.relayEndpoint,
      nodeKey: forged.nodeKey,
      chain: forged.chain,
      log: () => {},
    });
    cleanups.push(() => node.stop());
    await node.start();
    await waitFor(() => node.lastRefusal !== null);
    expect(node.lastRefusal).toBe('AUTH_FAILED');
    expect(h.core.stats().serviceNodes).toBe(1);
  });

  test('a second genuine node with another key does not evict the incumbent', async () => {
    const h = await startHarness();
    harnesses.push(h);
    const second = makeTestCredentials('example.ox', { domainKey: h.creds.domainKey });
    const node2 = new ServiceNode({
      name: 'example.ox',
      target: { host: '127.0.0.1', port: 1 },
      relayEndpoint: h.relayEndpoint,
      nodeKey: second.nodeKey,
      chain: second.chain,
      log: () => {},
    });
    cleanups.push(() => node2.stop());
    await node2.start();
    await waitFor(() => node2.lastRefusal !== null);
    expect(node2.lastRefusal).toBe('ALREADY_REGISTERED');
    expect(h.node.status).toBe('serving');
    const res = await socksFetch(h.socks.port, 'example.ox', 80, httpGet(1000));
    expect(splitHttp(res.body).payload.equals(patternBytes(1000))).toBe(true);
  });
});

describe('malformed input never crashes a service node', () => {
  test('garbage CIRCUIT_CREATEs and stray frames from a (fake) relay are survived', async () => {
    const creds = makeTestCredentials('example.ox');
    const port = await freePort();
    const endpoint = `ws://127.0.0.1:${port}`;
    const replies: number[] = [];
    let send: ((b: Uint8Array) => void) | null = null;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch(req, srv) {
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.sendBinary(encodeFrame({ type: FrameType.HELLO, payload: new Uint8Array(32) }));
        },
        message(ws, msg) {
          const f = decodeFrame(new Uint8Array(msg as Buffer));
          if (f.type === FrameType.AUTH) {
            ws.sendBinary(encodeFrame({ type: FrameType.AUTH_OK }));
            send = (b) => ws.sendBinary(b);
            return;
          }
          replies.push(f.type);
        },
      },
    });
    cleanups.push(() => server.stop(true));
    const node = new ServiceNode({
      name: 'example.ox',
      target: { host: '127.0.0.1', port: 1 },
      relayEndpoint: endpoint,
      nodeKey: creds.nodeKey,
      chain: creds.chain,
      log: () => {},
    });
    cleanups.push(() => node.stop());
    await node.start();
    await node.whenServing();
    const out = send as unknown as (b: Uint8Array) => void;
    const create = (circuitId: bigint, payload: Uint8Array) =>
      out(encodeFrame({ type: FrameType.CIRCUIT_CREATE, circuitId, payload }));
    // The v0 payload that used to crash it: domain\0base64(short key).
    create(1n, new TextEncoder().encode('example.ox\0AAAA'));
    create(2n, new Uint8Array(0));
    create(3n, new Uint8Array(70));
    create(4n, encodeCircuitCreate('example.ox', new Uint8Array(48))); // all-zero ephemeral
    create(5n, encodeCircuitCreate('other.ox', crypto.getRandomValues(new Uint8Array(48))));
    create(6n, encodeCircuitCreate('example.ox', crypto.getRandomValues(new Uint8Array(48))));
    out(
      encodeFrame({
        type: FrameType.STREAM_DATA,
        circuitId: 99n,
        streamId: 1,
        payload: new Uint8Array(30),
      }),
    );
    out(
      encodeFrame({ type: FrameType.CIRCUIT_DESTROY, circuitId: 98n, payload: new Uint8Array(2) }),
    );
    out(new Uint8Array([1, 2, 3])); // not even a frame: the node drops the connection, not the process
    await new Promise((r) => setTimeout(r, 200));
    // Every bad create was answered with a destroy; none produced a session.
    expect(replies.filter((t) => t === FrameType.CIRCUIT_CREATED)).toHaveLength(0);
    expect(replies.filter((t) => t === FrameType.CIRCUIT_DESTROY).length).toBeGreaterThanOrEqual(5);
    expect(node.activeCircuits).toBe(0);
    // Still alive: it reconnects and authenticates again.
    expect(
      node.status === 'serving' || node.status === 'connecting' || node.status === 'authenticating',
    ).toBe(true);
  });
});

describe('a relay never gets an unverified key past the client', () => {
  test('a substituted certificate key (registry MITM) is refused before any connection', async () => {
    const h = await startHarness();
    harnesses.push(h);
    const attacker = makeTestCredentials('example.ox');
    const overlay = { ...h.overlay(), chain: attacker.chain, kaCert: attacker.kaCert };
    const err = await h.tunnels.openStream('example.ox', 80, overlay).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err?.name).toBe('OverlayVerificationError');
    expect(h.core.stats().circuitsOpened).toBe(0);
  });

  test('a pinned name presented with a different domain key and no rotation is refused', async () => {
    const h = await startHarness();
    harnesses.push(h);
    await socksFetch(h.socks.port, 'example.ox', 80, httpGet(10)); // pins
    const attacker = makeTestCredentials('example.ox');
    const overlay = {
      ...h.overlay(),
      domainKey: attacker.domainKeyB64,
      chain: attacker.chain,
      kaCert: attacker.kaCert,
    };
    const err = (await h.tunnels
      .openStream('example.ox', 80, overlay)
      .catch((e: unknown) => e)) as {
      reason?: string;
      message: string;
    };
    expect(err.reason).toBe('pin-mismatch');
    expect(err.message).toContain('tnp pins forget example.ox');
    void generateSigningKeyPair;
    void signServiceAuth;
    void encodeServiceAuth;
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}
