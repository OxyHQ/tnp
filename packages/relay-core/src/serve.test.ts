import { afterEach, describe, expect, test } from 'bun:test';
import {
  decodeError,
  decodeFrame,
  encodeFrame,
  ErrorCode,
  FrameType,
  MAX_FRAME_SIZE,
} from '@tnp/protocol/v1';
import { generateSigningKeyPair } from '@tnp/crypto';
import { RelayCore } from './core';
import { type RelayServer, serveRelay } from './serve';

const servers: RelayServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

function start(
  limits = {},
  serve: { pingIntervalMs?: number; idleTimeoutSeconds?: number } = {},
): RelayServer {
  const core = new RelayCore({
    endpoint: 'ws://127.0.0.1',
    identity: generateSigningKeyPair(),
    lookupDomainKey: async () => null,
    limits,
  });
  const server = serveRelay({ core, hostname: '127.0.0.1', port: 0, ...serve });
  servers.push(server);
  return server;
}

function open(server: RelayServer, path: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`);
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('connect failed')), { once: true });
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) =>
    ws.addEventListener('close', (e) => resolve(e.code), { once: true }),
  );
}

describe('the Bun binding', () => {
  test('a message larger than one frame closes the connection before it is buffered', async () => {
    const server = start();
    const ws = await open(server, '/tunnel');
    const done = closed(ws);
    ws.send(new Uint8Array(MAX_FRAME_SIZE + 1));
    // Bun drops the socket (1009, or 1006 as the client sees an abrupt close).
    expect([1006, 1009]).toContain(await done);
  });

  test('text frames are not part of the protocol', async () => {
    const server = start();
    const ws = await open(server, '/tunnel');
    const done = closed(ws);
    ws.send('hello');
    expect(await done).toBe(1003);
  });

  test('/service sends a challenge and refuses anything but AUTH', async () => {
    const server = start();
    const ws = await open(server, '/service?domain=victim.ox');
    const frames: number[] = [];
    let code = -1;
    ws.addEventListener('message', (e) => {
      const f = decodeFrame(new Uint8Array(e.data as ArrayBuffer));
      frames.push(f.type);
      if (f.type === FrameType.HELLO) {
        ws.send(encodeFrame({ type: FrameType.STREAM_DATA, circuitId: 1n, streamId: 1 }));
      }
      if (f.type === FrameType.ERROR) code = decodeError(f.payload).code;
    });
    await closed(ws);
    expect(frames[0]).toBe(FrameType.HELLO);
    expect(code).toBe(ErrorCode.AUTH_REQUIRED);
  });

  test('per-address connection limits refuse the upgrade itself', async () => {
    const server = start({ maxConnectionsPerIp: 1 });
    await open(server, '/tunnel');
    const res = await fetch(`http://127.0.0.1:${server.port}/tunnel`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    expect(res.status).toBe(429);
  });

  test('/stats is aggregate counters only', async () => {
    const server = start();
    const stats = (await (await fetch(`http://127.0.0.1:${server.port}/stats`)).json()) as Record<
      string,
      unknown
    >;
    for (const value of Object.values(stats)) expect(typeof value).toBe('number');
  });
});

/**
 * A TCP proxy that behaves like a load balancer's idle timeout: it drops both
 * sides after `idleMs` without a byte in either direction.
 */
function idleDroppingProxy(upstreamPort: number, idleMs: number) {
  const net = require('node:net') as typeof import('node:net');
  const server = net.createServer((client) => {
    const upstream = net.connect(upstreamPort, '127.0.0.1');
    let timer: ReturnType<typeof setTimeout>;
    const touch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        client.destroy();
        upstream.destroy();
      }, idleMs);
    };
    touch();
    client.on('data', (d) => {
      touch();
      upstream.write(d);
    });
    upstream.on('data', (d) => {
      touch();
      client.write(d);
    });
    const end = () => {
      clearTimeout(timer);
      client.destroy();
      upstream.destroy();
    };
    client.on('close', end);
    upstream.on('close', end);
    client.on('error', end);
    upstream.on('error', end);
  });
  return new Promise<{ port: number; close(): void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        close: () => server.close(),
      });
    }),
  );
}

describe('keepalive (a 60 s ALB idle timeout is not raised for the relay)', () => {
  async function idleThroughProxy(pingIntervalMs: number): Promise<boolean> {
    const server = start({}, { pingIntervalMs });
    const proxy = await idleDroppingProxy(server.port, 600);
    try {
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const w = new WebSocket(`ws://127.0.0.1:${proxy.port}/tunnel`);
        w.binaryType = 'arraybuffer';
        w.addEventListener('open', () => resolve(w), { once: true });
        w.addEventListener('error', () => reject(new Error('connect failed')), { once: true });
      });
      let isClosed = false;
      ws.addEventListener('close', () => {
        isClosed = true;
      });
      // Idle — no application traffic — for well past the proxy's timeout.
      await Bun.sleep(2000);
      if (isClosed) return false;
      // And still usable: the relay answers an identity HELLO through it.
      const answered = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1000);
        ws.addEventListener('message', () => {
          clearTimeout(timer);
          resolve(true);
        });
        ws.send(encodeFrame({ type: FrameType.HELLO, payload: new Uint8Array(32) }));
      });
      ws.close();
      return answered;
    } finally {
      proxy.close();
    }
  }

  test('relay pings keep an idle link open through an idle-dropping balancer', async () => {
    expect(await idleThroughProxy(200)).toBe(true);
  });

  test('without them the same link is dropped (the test can fail)', async () => {
    expect(await idleThroughProxy(0)).toBe(false);
  });

  test("pings also outlast the relay's own idle timeout", async () => {
    // Bun closes a WebSocket idle for `idleTimeout` seconds; the pong each
    // ping draws is traffic, so a quiet but live peer is kept.
    const server = start({}, { pingIntervalMs: 500, idleTimeoutSeconds: 2 });
    const ws = await open(server, '/tunnel');
    let code: number | null = null;
    ws.addEventListener('close', (e) => {
      code = e.code;
    });
    await Bun.sleep(4500);
    expect(code).toBeNull();
    ws.close();
  }, 10_000);
});
