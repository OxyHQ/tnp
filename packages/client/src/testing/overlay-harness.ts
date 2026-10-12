/**
 * Test harness: a real relay (`@tnp/relay-core`), a real service node, a real
 * client (TunnelManager + SOCKS5) and a local TCP target, all over loopback.
 * Used by the end-to-end and adversarial suites; never imported by the CLI.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestCredentials, type TestServiceCredentials } from '@tnp/crypto/testing';
import { RelayCore, type RelayLimits, serveRelay, type RelayServer } from '@tnp/relay-core';
import type { DnsResolveOverlay } from '@tnp/shared-types';
import { PinStore } from '../overlay/pins';
import { OverlayStore } from '../overlay/store';
import { ServiceNode } from '../service-node';
import { SocksProxy } from '../socks';
import { TunnelManager } from '../tunnel';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** A TCP target: answers `GET /<n>` with n deterministic bytes, then closes. */
export async function startTarget(): Promise<{ port: number; server: net.Server; stop(): void }> {
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      const match = /^GET \/(\d+)/.exec(buf);
      const size = match ? Number(match[1]) : 0;
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${size}\r\nConnection: close\r\n\r\n`);
      socket.end(patternBytes(size));
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  return { port, server, stop: () => server.close() };
}

export function patternBytes(size: number, seed = 0): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed * 7 + (i >> 8)) & 0xff;
  return out;
}

export interface Harness {
  creds: TestServiceCredentials;
  relayEndpoint: string;
  relay: RelayServer;
  core: RelayCore;
  node: ServiceNode;
  target: Awaited<ReturnType<typeof startTarget>>;
  pins: PinStore;
  storeDir: string;
  overlay(): DnsResolveOverlay;
  tunnels: TunnelManager;
  socks: SocksProxy;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  name?: string;
  limits?: Partial<RelayLimits>;
  /** Point the client at a different relay URL (a hostile wrapper) than the node uses. */
  clientRelay?: (relayEndpoint: string) => string;
  /** Use an existing relay instead of starting one. */
  externalRelay?: { endpoint: string; keys: Map<string, string> };
  target?: { port: number };
}

export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const name = options.name ?? 'example.ox';
  const creds = makeTestCredentials(name);
  const target = await startTarget();
  let relayEndpoint: string;
  let relay: RelayServer | null = null;
  let core: RelayCore | null = null;
  const keys = options.externalRelay?.keys ?? new Map<string, string>();
  keys.set(name, creds.domainKeyB64);
  if (options.externalRelay) {
    relayEndpoint = options.externalRelay.endpoint;
  } else {
    const port = await freePort();
    relayEndpoint = `ws://127.0.0.1:${port}`;
    core = new RelayCore({
      endpoint: relayEndpoint,
      lookupDomainKey: async (n) => keys.get(n) ?? null,
      limits: options.limits,
    });
    relay = serveRelay({ core, hostname: '127.0.0.1', port });
  }

  const node = new ServiceNode({
    name,
    target: { host: '127.0.0.1', port: options.target?.port ?? target.port },
    relayEndpoint,
    nodeKey: creds.nodeKey,
    chain: creds.chain,
    log: process.env.TNP_TEST_DEBUG ? (m) => console.error(`[node] ${m}`) : () => {},
  });
  await node.start();
  await node.whenServing();

  const storeDir = mkdtempSync(join(tmpdir(), 'tnp-overlay-test-'));
  const pins = new PinStore(new OverlayStore(storeDir));
  const overlay = (): DnsResolveOverlay => {
    const clientRelay = options.clientRelay?.(relayEndpoint) ?? relayEndpoint;
    const kaCert = node.kaCert;
    if (!kaCert) throw new Error('node has no certificate');
    return {
      relay: clientRelay,
      available: true,
      domainKey: creds.domainKeyB64,
      rotations: [],
      chain: creds.chain,
      kaCert,
    };
  };
  const tunnels = new TunnelManager({ pins, resolveOverlay: async () => overlay() });
  const socks = new SocksProxy({ port: 0, tunnelManager: tunnels });
  await socks.ready;

  return {
    creds,
    relayEndpoint,
    relay: relay as RelayServer,
    core: core as RelayCore,
    node,
    target,
    pins,
    storeDir,
    overlay,
    tunnels,
    socks,
    async stop() {
      socks.stop();
      tunnels.shutdown();
      node.stop();
      target.stop();
      if (relay) await relay.stop();
      rmSync(storeDir, { recursive: true, force: true });
    },
  };
}

/** Speak SOCKS5 to `socksPort`, CONNECT `host:port`, send `request`, collect the response. */
export function socksFetch(
  socksPort: number,
  host: string,
  port: number,
  request: string | Buffer,
  options: { timeoutMs?: number } = {},
): Promise<{ reply: number; body: Buffer; error?: string }> {
  return new Promise((resolve) => {
    const socket = net.createConnection({
      host: '127.0.0.1',
      port: socksPort,
      allowHalfOpen: true,
    });
    let stage: 'greet' | 'connect' | 'data' = 'greet';
    let buf = Buffer.alloc(0);
    let reply = -1;
    const timer = setTimeout(() => finish('timeout'), options.timeoutMs ?? 15_000);
    let done = false;
    const finish = (error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ reply, body: stage === 'data' ? buf : Buffer.alloc(0), error });
    };
    socket.on('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greet' && buf.length >= 2) {
        buf = buf.subarray(2);
        stage = 'connect';
        const nameBytes = Buffer.from(host, 'latin1');
        const p = Buffer.alloc(2);
        p.writeUInt16BE(port);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, nameBytes.length]), nameBytes, p]));
      }
      if (stage === 'connect' && buf.length >= 10) {
        reply = buf[1];
        buf = buf.subarray(10);
        if (reply !== 0) return finish();
        stage = 'data';
        socket.write(request);
      }
    });
    socket.on('end', () => finish());
    socket.on('close', (hadError) => finish(hadError ? 'reset' : undefined));
    socket.on('error', () => finish('reset'));
  });
}

export function httpGet(size: number): string {
  return `GET /${size} HTTP/1.1\r\nHost: example.ox\r\nConnection: close\r\n\r\n`;
}

export function splitHttp(body: Buffer): { head: string; payload: Buffer } {
  const end = body.indexOf('\r\n\r\n');
  return { head: body.subarray(0, end).toString('latin1'), payload: body.subarray(end + 4) };
}
