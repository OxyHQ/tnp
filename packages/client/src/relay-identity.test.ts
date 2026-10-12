/**
 * Relays prove their directory key to clients and service nodes
 * (transport.md §6.2; relays.md §8, blocker 6). Over loopback, against the
 * real relay core:
 *
 * - a relay that is not in the directory is never dialed;
 * - a forged proof (another key), a replayed proof (another connection's
 *   nonce) and a proof for another endpoint (a relay passing off a genuine
 *   relay's proof) are all refused before any circuit or AUTH is sent;
 * - a service node fails over to the next candidate when a relay is
 *   unreachable or cannot prove its key.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { generateSigningKeyPair, signRelayIdentity, verifyRelayIdentity } from '@tnp/crypto';
import {
  decodeFrame,
  decodeRelayHello,
  decodeRelayHelloAck,
  encodeFrame,
  encodeRelayHelloAck,
  ErrorCode,
  FrameType,
} from '@tnp/protocol/v1';
import { RelayCore, serveRelay } from '@tnp/relay-core';
import { probeRelay } from './overlay/relay-identity';
import { ServiceNode } from './service-node';
import { freePort, type Harness, startHarness } from './testing/overlay-harness';
import { TunnelError } from './tunnel';

const harnesses: Harness[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.stop();
  for (const c of cleanups.splice(0)) await c();
});

async function harness(): Promise<Harness> {
  const h = await startHarness();
  harnesses.push(h);
  return h;
}

/**
 * A fake relay at its own URL that answers HELLO with `answer(nonce, url)`
 * (or not at all) and records every frame type it receives.
 */
async function fakeRelay(
  answer: ((nonce: Uint8Array, url: string) => Uint8Array | null) | null,
  options: { challenge?: boolean } = {},
): Promise<{ url: string; received: number[]; connections: () => number }> {
  const port = await freePort();
  const url = `ws://127.0.0.1:${port}`;
  const received: number[] = [];
  let connections = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    fetch(req, srv) {
      return srv.upgrade(req, { data: undefined })
        ? undefined
        : new Response('no', { status: 400 });
    },
    websocket: {
      open(ws: ServerWebSocket<unknown>) {
        connections++;
        // Like a real relay's /service: a challenge on connect.
        if (options.challenge) {
          ws.sendBinary(encodeFrame({ type: FrameType.HELLO, payload: new Uint8Array(32) }));
        }
      },
      message(ws: ServerWebSocket<unknown>, msg) {
        const frame = decodeFrame(new Uint8Array(msg as Buffer));
        received.push(frame.type);
        if (frame.type === FrameType.HELLO && answer) {
          const ack = answer(decodeRelayHello(frame.payload), url);
          if (ack) ws.sendBinary(encodeFrame({ type: FrameType.HELLO_ACK, payload: ack }));
        }
      },
    },
  });
  cleanups.push(() => server.stop(true));
  return { url, received, connections: () => connections };
}

function selfSigned(key = generateSigningKeyPair()) {
  return (nonce: Uint8Array, url: string) =>
    encodeRelayHelloAck(
      key.publicKey,
      signRelayIdentity({ endpoint: url, nonce, relayKey: key.publicKey }, key.secretKey),
    );
}

async function refusal(h: Harness): Promise<TunnelError> {
  const err = await h.tunnels.openStream('example.ox', 80).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(TunnelError);
  return err as TunnelError;
}

describe('the client refuses a relay that is not in the signed directory', () => {
  test('it is never dialed', async () => {
    const h = await harness();
    h.relayKeys.clear();
    const before = h.core.stats().connections;
    const err = await refusal(h);
    expect(err.message).toContain('not in the signed relay directory');
    expect(err.code).toBe(ErrorCode.AUTH_FAILED);
    expect(h.core.stats().connections).toBe(before);
  });

  test('a lookup failure (no verified directory) refuses too, never falls back', async () => {
    const h = await harness();
    const { TunnelManager } = await import('./tunnel');
    const tunnels = new TunnelManager({
      pins: h.pins,
      resolveOverlay: async () => h.overlay(),
      relayKeys: async () => {
        throw new Error('no verified relay directory: expired');
      },
    });
    cleanups.push(() => tunnels.shutdown());
    const err = await tunnels.openStream('example.ox', 80).then(
      () => null,
      (e: unknown) => e as TunnelError,
    );
    expect(err?.message).toContain('no verified relay directory');
  });
});

describe('relay identity proof to clients', () => {
  test('a forged proof — the relay holds a different key than the directory lists — is refused', async () => {
    const h = await harness();
    const impostor = await fakeRelay(selfSigned());
    h.relayKeys.set(impostor.url, h.relayIdentity.publicKey); // directory: the genuine key
    const overlay = h.overlay();
    const tunnels = new (await import('./tunnel')).TunnelManager({
      pins: h.pins,
      resolveOverlay: async () => ({ ...overlay, relay: impostor.url }),
      relayKeys: async (e) => h.relayKeys.get(e) ?? null,
    });
    cleanups.push(() => tunnels.shutdown());
    const err = await tunnels.openStream('example.ox', 80).then(
      () => null,
      (e: unknown) => e as TunnelError,
    );
    expect(err?.code).toBe(ErrorCode.AUTH_FAILED);
    expect(err?.message).toContain('not the key the signed directory lists');
    // Nothing but the HELLO reached the impostor: no circuit, no name.
    expect(impostor.received).toEqual([FrameType.HELLO]);
  });

  test('a replayed proof (recorded on another connection) is refused', async () => {
    // A genuine relay configured for the impostor's URL signs one proof; the
    // impostor (who does not hold the key) replays it to every later client.
    const port = await freePort();
    const relayUrl = `ws://127.0.0.1:${port}`;
    const genuine = generateSigningKeyPair();
    let recorded: Uint8Array | null = null;
    const impostor = await fakeRelay(() => recorded);
    const core = new RelayCore({
      endpoint: impostor.url,
      identity: genuine,
      lookupDomainKey: async () => null,
    });
    const server = serveRelay({ core, hostname: '127.0.0.1', port });
    cleanups.push(() => server.stop());
    const firstNonce = crypto.getRandomValues(new Uint8Array(32));
    recorded = await new Promise<Uint8Array>((resolve, reject) => {
      const ws = new WebSocket(`${relayUrl}/tunnel`);
      ws.binaryType = 'arraybuffer';
      ws.addEventListener('open', () =>
        ws.send(encodeFrame({ type: FrameType.HELLO, payload: firstNonce })),
      );
      ws.addEventListener('message', (e) => {
        const f = decodeFrame(new Uint8Array(e.data as ArrayBuffer));
        if (f.type === FrameType.HELLO_ACK) {
          ws.close();
          resolve(f.payload);
        }
      });
      ws.addEventListener('error', () => reject(new Error('relay unreachable')));
    });
    // The recorded proof is genuine: right key, right endpoint — for the first nonce.
    const ack = decodeRelayHelloAck(recorded);
    expect(
      verifyRelayIdentity(
        { endpoint: impostor.url, nonce: firstNonce, relayKey: genuine.publicKey },
        ack.signature,
      ),
    ).toBe(true);
    // Replayed to a new connection, with a new nonce, it is refused.
    expect(await probeRelay(impostor.url, genuine.publicKey, 2000)).toBeNull();
  });

  test('a proof made for another endpoint (a relay relaying a genuine relay) is refused', async () => {
    const h = await harness();
    // A wrapper at its own URL that forwards everything, HELLO included, to
    // the genuine relay: the genuine relay signs ITS endpoint, not the
    // wrapper's, so the client — which dialed the wrapper — refuses it.
    const port = await freePort();
    const wrapperUrl = `ws://127.0.0.1:${port}`;
    const server = Bun.serve<{ up?: WebSocket; q: Uint8Array[] }>({
      hostname: '127.0.0.1',
      port,
      fetch(req, srv) {
        return srv.upgrade(req, { data: { q: [] } })
          ? undefined
          : new Response('no', { status: 400 });
      },
      websocket: {
        open(ws) {
          const up = new WebSocket(`${h.relayEndpoint}/tunnel`);
          up.binaryType = 'arraybuffer';
          ws.data.up = up;
          up.addEventListener('open', () => {
            for (const b of ws.data.q.splice(0)) up.send(b as Uint8Array<ArrayBuffer>);
          });
          up.addEventListener('message', (e) =>
            ws.sendBinary(new Uint8Array(e.data as ArrayBuffer)),
          );
        },
        message(ws, msg) {
          const bytes = new Uint8Array(msg as Buffer).slice();
          if (ws.data.up?.readyState === WebSocket.OPEN) ws.data.up.send(bytes);
          else ws.data.q.push(bytes);
        },
        close(ws) {
          ws.data.up?.close();
        },
      },
    });
    cleanups.push(() => server.stop(true));
    h.relayKeys.set(wrapperUrl, h.relayIdentity.publicKey);
    const overlay = h.overlay();
    const tunnels = new (await import('./tunnel')).TunnelManager({
      pins: h.pins,
      resolveOverlay: async () => ({ ...overlay, relay: wrapperUrl }),
      relayKeys: async (e) => h.relayKeys.get(e) ?? null,
    });
    cleanups.push(() => tunnels.shutdown());
    const err = await tunnels.openStream('example.ox', 80).then(
      () => null,
      (e: unknown) => e as TunnelError,
    );
    expect(err?.code).toBe(ErrorCode.AUTH_FAILED);
    expect(err?.message).toContain('did not prove possession');
    expect(h.core.stats().circuitsOpened).toBe(0);
  });

  test('probeRelay times a genuine relay and rejects a wrong key or silence', async () => {
    const h = await harness();
    expect(
      await probeRelay(h.relayEndpoint, h.relayIdentity.publicKey, 2000),
    ).toBeGreaterThanOrEqual(0);
    expect(await probeRelay(h.relayEndpoint, generateSigningKeyPair().publicKey, 2000)).toBeNull();
    const silent = await fakeRelay(null);
    expect(await probeRelay(silent.url, h.relayIdentity.publicKey, 300)).toBeNull();
    expect(
      await probeRelay(`ws://127.0.0.1:${await freePort()}`, h.relayIdentity.publicKey, 1000),
    ).toBeNull();
  });
});

describe('service node relay authentication and fail-over', () => {
  test('a relay that cannot prove its key gets no AUTH, and the node fails over', async () => {
    const h = await harness();
    const impostor = await fakeRelay(selfSigned(), { challenge: true });
    const node = new ServiceNode({
      name: 'example.ox',
      target: { host: '127.0.0.1', port: h.target.port },
      relays: [
        // Listed with the genuine key, but answered by an impostor.
        { endpoint: impostor.url, relayKey: h.relayIdentity.publicKey },
        { endpoint: h.relayEndpoint, relayKey: h.relayIdentity.publicKey },
      ],
      nodeKey: h.creds.nodeKey,
      chain: h.creds.chain,
      log: () => {},
    });
    cleanups.push(() => node.stop());
    // The harness node already serves the name with the same key; this one
    // replaces it on the genuine relay (same node key may replace itself).
    await node.start();
    await node.whenServing();
    expect(node.relayEndpoint).toBe(h.relayEndpoint);
    expect(impostor.received).not.toContain(FrameType.AUTH);
    expect(impostor.received).toContain(FrameType.HELLO);
  }, 20_000);

  test('an unreachable relay is failed over to the next candidate', async () => {
    const h = await harness();
    const dead = `ws://127.0.0.1:${await freePort()}`;
    const node = new ServiceNode({
      name: 'example.ox',
      target: { host: '127.0.0.1', port: h.target.port },
      relays: [
        { endpoint: dead, relayKey: generateSigningKeyPair().publicKey },
        { endpoint: h.relayEndpoint, relayKey: h.relayIdentity.publicKey },
      ],
      nodeKey: h.creds.nodeKey,
      chain: h.creds.chain,
      log: () => {},
    });
    cleanups.push(() => node.stop());
    await node.start();
    await node.whenServing();
    expect(node.relayEndpoint).toBe(h.relayEndpoint);
  }, 20_000);
});
