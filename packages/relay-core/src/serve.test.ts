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

function start(limits = {}): RelayServer {
  const core = new RelayCore({
    endpoint: 'ws://127.0.0.1',
    identity: generateSigningKeyPair(),
    lookupDomainKey: async () => null,
    limits,
  });
  const server = serveRelay({ core, hostname: '127.0.0.1', port: 0 });
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
