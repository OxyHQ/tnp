/**
 * SOCKS5 proxy over a real loopback socket.
 *
 * The property this suite exists for: a CONNECT to anything that is not a
 * TNP-native name is refused locally, and the TNP API is never asked about it.
 * The proxy used to call `GET /nodes/<host>` for every destination, public
 * sites and IP literals included, which reported the user's browsing to the
 * registry.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import type { SecureCircuit, SecureCircuitEvents } from './overlay/secure-circuit';
import { OverlayVerificationError } from './overlay/verify';
import { parseRequest, SocksProxy } from './socks';
import type { TunnelManager } from './tunnel';

/** Enough of a SecureCircuit for pipeSocket: records what the socket wrote. */
class FakeCircuit {
  sent: Buffer[] = [];
  closed = false;
  events: SecureCircuitEvents | null = null;
  bind(events: SecureCircuitEvents) {
    this.events = events;
    events.onWritable();
  }
  write(data: Uint8Array) {
    this.sent.push(Buffer.from(data));
    return data.length;
  }
  end() {}
  consumed() {}
  reset() {
    this.closed = true;
  }
  abort() {
    this.closed = true;
  }
}

/**
 * `available` names have a service node; every openStream call is recorded,
 * because that is the only path by which the proxy can reach the registry.
 */
function fakes(available: string[] = []) {
  const lookups: string[] = [];
  const tunnels: Array<{ domain: string; port: number; hint: unknown; circuit: FakeCircuit }> = [];
  const tunnelManager = {
    async openStream(domain: string, port: number, hint?: unknown) {
      if (hint === undefined) lookups.push(domain);
      if (hint === undefined && !available.includes(domain)) {
        throw new OverlayVerificationError('no-overlay', 'no service node');
      }
      const circuit = new FakeCircuit();
      tunnels.push({ domain, port, hint, circuit });
      return circuit as unknown as SecureCircuit;
    },
  } as unknown as TunnelManager;
  return { tunnelManager, lookups, tunnels };
}

const proxies: SocksProxy[] = [];
afterEach(() => {
  while (proxies.length > 0) proxies.pop()?.stop();
});

async function startSocks(f: ReturnType<typeof fakes>, extra: { overlay?: boolean } = {}) {
  const proxy = new SocksProxy({
    port: 0,
    tunnelManager: f.tunnelManager,
    getOverlayInfo: extra.overlay
      ? (domain) => (domain === 'cached.ox' ? { relay: 'wss://relay' } : undefined)
      : undefined,
  });
  proxies.push(proxy);
  await proxy.ready;
  return proxy;
}

/** Connect, write `bytes`, and collect everything until the server closes (or timeout). */
async function exchange(port: number, bytes: Buffer, waitMs = 1000): Promise<Buffer> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let received = Buffer.alloc(0);
    const done = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(received);
    };
    const timer = setTimeout(done, waitMs);
    socket.on('connect', () => socket.write(bytes));
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
    });
    socket.on('close', done);
    socket.on('error', done);
  });
}

const GREETING = Buffer.from([0x05, 0x01, 0x00]);

function connectDomain(domain: string, port = 443): Buffer {
  const name = Buffer.from(domain, 'latin1');
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  return Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, name.length]), name, portBuf]);
}

function connectIPv4(a: number, b: number, c: number, d: number, port = 443): Buffer {
  return Buffer.from([0x05, 0x01, 0x00, 0x01, a, b, c, d, port >> 8, port & 0xff]);
}

describe('SOCKS5 proxy', () => {
  test('a public name is refused (not allowed) and never looked up', async () => {
    const f = fakes();
    const proxy = await startSocks(f);
    for (const host of ['example.com', 'twitter.com', 'printer.lan', 'evil.ox.com']) {
      const reply = await exchange(proxy.port, Buffer.concat([GREETING, connectDomain(host)]));
      expect([...reply.subarray(0, 2)]).toEqual([0x05, 0x00]);
      expect(reply[3]).toBe(0x02);
    }
    expect(f.lookups).toEqual([]);
  });

  test('an IPv4 or IPv6 literal is refused without a lookup', async () => {
    const f = fakes();
    const proxy = await startSocks(f);
    const v4 = await exchange(proxy.port, Buffer.concat([GREETING, connectIPv4(93, 184, 216, 34)]));
    expect(v4[3]).toBe(0x02);
    const v6 = await exchange(
      proxy.port,
      Buffer.concat([GREETING, Buffer.from([0x05, 0x01, 0x00, 0x04]), Buffer.alloc(18)]),
    );
    expect(v6[3]).toBe(0x02);
    expect(f.lookups).toEqual([]);
  });

  test('a native name is looked up, and unreachable without a service node', async () => {
    const f = fakes();
    const proxy = await startSocks(f);
    const reply = await exchange(proxy.port, Buffer.concat([GREETING, connectDomain('hello.ox')]));
    expect(reply[3]).toBe(0x04);
    expect(f.lookups).toEqual(['hello.ox']);
  });

  test('a CONNECT pipelined with the greeting is served, and early data reaches the tunnel', async () => {
    const f = fakes(['hello.ox']);
    const proxy = await startSocks(f);
    const early = Buffer.from('GET / HTTP/1.1\r\n\r\n');
    const reply = await exchange(
      proxy.port,
      Buffer.concat([GREETING, connectDomain('hello.ox', 80), early]),
      400,
    );
    expect([...reply.subarray(0, 4)]).toEqual([0x05, 0x00, 0x05, 0x00]);
    expect(f.tunnels).toHaveLength(1);
    expect(f.tunnels[0]).toMatchObject({ domain: 'hello.ox', port: 80 });
    expect(Buffer.concat(f.tunnels[0].circuit.sent).toString()).toBe(early.toString());
  });

  test('a CONNECT followed by more than 1 KB of early data in one write still connects', async () => {
    const f = fakes();
    const proxy = await startSocks(f, { overlay: true });
    const early = Buffer.alloc(4000, 0x41);
    const reply = await exchange(
      proxy.port,
      Buffer.concat([GREETING, connectDomain('cached.ox'), early]),
      400,
    );
    expect([...reply.subarray(0, 4)]).toEqual([0x05, 0x00, 0x05, 0x00]);
    expect(Buffer.concat(f.tunnels[0].circuit.sent).byteLength).toBe(4000);
  });

  test('the overlay cache is used before the API', async () => {
    const f = fakes();
    const proxy = await startSocks(f, { overlay: true });
    const reply = await exchange(
      proxy.port,
      Buffer.concat([GREETING, connectDomain('cached.ox')]),
      400,
    );
    expect(reply[3]).toBe(0x00);
    expect(f.lookups).toEqual([]);
  });

  test('a client that does not offer "no auth" gets 0xFF and is closed', async () => {
    const f = fakes();
    const proxy = await startSocks(f);
    const reply = await exchange(proxy.port, Buffer.from([0x05, 0x01, 0x02])); // user/pass only
    expect([...reply]).toEqual([0x05, 0xff]);
  });

  test('unsupported commands and address types get their reply code and a close', async () => {
    const f = fakes();
    const proxy = await startSocks(f);
    const bind = await exchange(
      proxy.port,
      Buffer.concat([GREETING, Buffer.from([0x05, 0x02, 0x00, 0x03, 0x01, 0x61, 0, 80])]),
    );
    expect(bind[3]).toBe(0x07);
    const weird = await exchange(proxy.port, Buffer.concat([GREETING, Buffer.from([5, 1, 0, 9])]));
    expect(weird[3]).toBe(0x08);
    expect(f.lookups).toEqual([]);
  });

  test('a client streaming garbage after the greeting is cut off, not buffered forever', async () => {
    const f = fakes();
    const proxy = await startSocks(f);
    // A domain request whose length byte promises more than ever arrives, then
    // a flood: the old parser returned "need more data" forever.
    const flood = Buffer.concat([GREETING, Buffer.from([5, 1, 0, 3, 255]), Buffer.alloc(4096)]);
    const started = Date.now();
    await exchange(proxy.port, flood, 2000);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('listens on loopback by default', async () => {
    const f = fakes();
    const proxy = await startSocks(f);
    const address = (proxy as unknown as { server: net.Server }).server.address();
    expect(address && typeof address === 'object' ? address.address : '').toBe('127.0.0.1');
  });
});

describe('parseRequest', () => {
  test('waits for a complete domain request', () => {
    const full = connectDomain('hello.ox');
    expect(parseRequest(full.subarray(0, 6)).kind).toBe('incomplete');
    expect(parseRequest(full)).toEqual({
      kind: 'connect',
      domain: 'hello.ox',
      port: 443,
      consumed: full.length,
    });
  });
});
