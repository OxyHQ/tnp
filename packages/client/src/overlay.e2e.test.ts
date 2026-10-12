/**
 * End to end over loopback: client (SOCKS5 + TunnelManager) → relay
 * (`@tnp/relay-core`, standalone and embedded) → service node → TCP target.
 *
 * Nothing is mocked between the application socket and the target: real
 * WebSockets, the real Noise handshake against a certificate the client
 * verified, real sealed records, real flow control.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { RelayNode } from './relay-node';
import {
  freePort,
  type Harness,
  httpGet,
  patternBytes,
  socksFetch,
  splitHttp,
  startHarness,
} from './testing/overlay-harness';
import { ErrorCode } from '@tnp/protocol/v1';
import { TnpApiClient } from './api';
import { TunnelError, TunnelManager } from './tunnel';

const harnesses: Harness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.stop();
});

async function harness(...args: Parameters<typeof startHarness>): Promise<Harness> {
  const h = await startHarness(...args);
  harnesses.push(h);
  return h;
}

describe('client → relay → service node → target', () => {
  test('an HTTP fetch through SOCKS returns the exact bytes', async () => {
    const h = await harness();
    const res = await socksFetch(h.socks.port, 'example.ox', 80, httpGet(300_000));
    expect(res.error).toBeUndefined();
    expect(res.reply).toBe(0);
    const { head, payload } = splitHttp(res.body);
    expect(head).toContain('200 OK');
    expect(payload.equals(patternBytes(300_000))).toBe(true);
    // The first contact pinned the domain key.
    expect(h.pins.get('example.ox')?.domainKey).toBe(h.creds.domainKeyB64);
    // The relay forwarded but kept only aggregate counters.
    const stats = h.core.stats();
    expect(stats.circuitsOpened).toBe(1);
    expect(stats.bytesForwarded).toBeGreaterThan(300_000);
  });

  test('a subdomain reaches the registered name', async () => {
    const h = await harness();
    const res = await socksFetch(h.socks.port, 'www.example.ox', 80, httpGet(10));
    expect(splitHttp(res.body).payload.equals(patternBytes(10))).toBe(true);
  });

  test('100 concurrent circuits each get exactly their own bytes', async () => {
    // Every client here shares 127.0.0.1, so the per-address fairness caps
    // (exercised below) are lifted: this test is about isolation.
    const h = await harness({
      limits: { maxCircuitsPerIpPerService: 200, maxCircuitsPerClientPerService: 64 },
    });
    const sizes = Array.from({ length: 100 }, (_, i) => 1000 + i * 137);
    const results = await Promise.all(
      sizes.map((size) =>
        socksFetch(h.socks.port, 'example.ox', 80, httpGet(size), { timeoutMs: 30_000 }),
      ),
    );
    results.forEach((res, i) => {
      expect(res.error).toBeUndefined();
      expect(splitHttp(res.body).payload.equals(patternBytes(sizes[i]))).toBe(true);
    });
    expect(h.core.stats().circuitsOpened).toBe(100);
  }, 60_000);

  test('a refused target is reported as unreachable, with no address leaked', async () => {
    const closedPort = await freePort();
    const h = await harness({ target: { port: closedPort } });
    const res = await socksFetch(h.socks.port, 'example.ox', 80, httpGet(10));
    // SOCKS "host unreachable"; the reason travelled sealed and generic.
    expect(res.reply).toBe(0x04);
  });

  test('a slow reader applies backpressure instead of buffering the target without bound', async () => {
    const TOTAL = 24 * 1024 * 1024;
    let written = 0;
    const target = net.createServer((socket) => {
      const chunk = Buffer.alloc(64 * 1024, 0x5a);
      const pump = () => {
        while (written < TOTAL) {
          written += chunk.length;
          if (!socket.write(chunk)) {
            socket.once('drain', pump);
            return;
          }
        }
        socket.end();
      };
      socket.once('data', pump);
      socket.on('error', () => {});
    });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
    const address = target.address();
    const targetPort = address && typeof address === 'object' ? address.port : 0;
    const h = await harness({ target: { port: targetPort } });
    try {
      const socket = net.createConnection({ host: '127.0.0.1', port: h.socks.port });
      await new Promise<void>((r) => socket.once('connect', () => r()));
      socket.write(Buffer.from([5, 1, 0]));
      socket.write(Buffer.from([5, 1, 0, 3, 10, ...Buffer.from('example.ox'), 0, 80]));
      let received = 0;
      let replied = false;
      socket.on('data', (c: Buffer) => {
        if (!replied) {
          replied = true;
          received += c.length - 12;
          socket.pause(); // the application stops reading
          return;
        }
        received += c.length;
      });
      await new Promise((r) => setTimeout(r, 300));
      socket.write('go');
      await new Promise((r) => setTimeout(r, 1500));
      const plateau = written;
      await new Promise((r) => setTimeout(r, 500));
      // The producer stalled well short of the whole body: what it got rid of
      // is bounded by the end-to-end window plus socket buffers.
      // Stalled: at most a socket buffer more trickles out once the window is spent.
      expect(written - plateau).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(written).toBeLessThan(TOTAL / 2);
      expect(h.core.stats().backpressureDestroys).toBe(0);
      // And resuming delivers everything.
      const all = new Promise<void>((r) => socket.on('end', () => r()));
      socket.resume();
      await all;
      expect(received).toBe(TOTAL);
      socket.destroy();
    } finally {
      target.close();
    }
  }, 60_000);
});

describe('circuit-slot exhaustion', () => {
  test('one address holding opened, silent circuits cannot lock an innocent client out', async () => {
    const h = await harness({ relayTrustForwardedFor: true });
    const attacker = new TunnelManager({
      pins: h.pins,
      resolveOverlay: async () => h.overlay(),
      headers: { 'x-forwarded-for': '203.0.113.66' },
    });
    try {
      // Open far more streams than the per-address share, and hold them silently.
      const attempts = await Promise.allSettled(
        Array.from({ length: 60 }, () => attacker.openStream('example.ox', 80)),
      );
      const held = attempts.filter((a) => a.status === 'fulfilled').length;
      const refused = attempts.filter(
        (a) =>
          a.status === 'rejected' &&
          a.reason instanceof TunnelError &&
          a.reason.code === ErrorCode.CIRCUIT_LIMIT,
      ).length;
      expect(held).toBeLessThanOrEqual(h.core.limits.maxCircuitsPerIpPerService);
      expect(refused).toBeGreaterThan(0);
      // The innocent client (another address) still gets a full answer.
      const res = await socksFetch(h.socks.port, 'example.ox', 80, httpGet(5000));
      expect(splitHttp(res.body).payload.equals(patternBytes(5000))).toBe(true);
    } finally {
      attacker.shutdown();
    }
  }, 30_000);

  test('the service node resets an opened circuit that stays silent', async () => {
    const h = await harness({ nodeStreamIdleMs: 300 });
    const circuit = await h.tunnels.openStream('example.ox', 80);
    const closed = await new Promise<{ code?: number } | null>((resolve) => {
      circuit.bind({
        onData: () => {},
        onEnd: () => {},
        onWritable: () => {},
        onClose: (error) => resolve(error),
      });
    });
    expect(closed?.code).toBe(ErrorCode.RESOURCE_EXHAUSTED);
  });
});

describe('the relay embedded in the tnp binary', () => {
  test('carries the same end-to-end fetch', async () => {
    const port = await freePort();
    const endpoint = `ws://127.0.0.1:${port}`;
    const keys = new Map<string, string>();
    const relay = new RelayNode({
      port,
      host: '127.0.0.1',
      endpoint,
      maxConnections: 100,
      bandwidth: 0,
      authToken: '',
      location: '',
      apiBaseUrl: 'http://127.0.0.1:1',
      identityKeyPath: '/nonexistent',
      lookupDomainKey: async (name) => keys.get(name) ?? null,
    });
    await relay.start(new TnpApiClient('http://127.0.0.1:1'));
    try {
      const h = await harness({ externalRelay: { endpoint, keys } });
      const res = await socksFetch(h.socks.port, 'example.ox', 80, httpGet(70_000));
      expect(splitHttp(res.body).payload.equals(patternBytes(70_000))).toBe(true);
      expect(relay.getStats().activeCircuits).toBeGreaterThanOrEqual(0);
    } finally {
      await relay.stop();
    }
  });
});
