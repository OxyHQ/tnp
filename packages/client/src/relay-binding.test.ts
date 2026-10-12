/**
 * The resolve record's relay is registry data. A client reaches a name only
 * through the relay the service node itself signed it is attached to (node
 * key, rooted in the domain key) — or, for a node that publishes no binding,
 * only through an Oxy-operated relay. And a service node is never kept off
 * its other relays by an impostor's spoofed refusal, and leaves a relay the
 * directory stops listing.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import {
  generateSigningKeyPair,
  type ServiceRelayBinding,
  signServiceRelayBinding,
  verifyServiceRelayBinding,
} from '@tnp/crypto';
import { encodeError, ErrorCode, ErrorScope } from '@tnp/protocol/v1';
import { RelayCore, serveRelay } from '@tnp/relay-core';
import { OverlayVerificationError } from './overlay/verify';
import { type RelayCandidate, ServiceNode } from './service-node';
import {
  directoryLookup,
  freePort,
  type Harness,
  httpGet,
  patternBytes,
  socksFetch,
  splitHttp,
  startHarness,
} from './testing/overlay-harness';
import { TunnelError, TunnelManager } from './tunnel';

const harnesses: Harness[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.stop();
  for (const c of cleanups.splice(0)) await c();
});

async function harness(options: Parameters<typeof startHarness>[0] = {}): Promise<Harness> {
  const h = await startHarness(options);
  harnesses.push(h);
  return h;
}

/** A TunnelManager that is served `overlay` by the (hostile) registry. */
function tunnelsFor(h: Harness, overlay: unknown): TunnelManager {
  const tunnels = new TunnelManager({
    pins: h.pins,
    resolveOverlay: async () => overlay,
    directory: directoryLookup(h.relayKeys, h.oxyRelays),
  });
  cleanups.push(() => tunnels.shutdown());
  return tunnels;
}

async function refusal(tunnels: TunnelManager): Promise<Error> {
  const err = await tunnels.openStream('example.ox', 80).then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err).not.toBeNull();
  return err as Error;
}

/** A second genuine relay, listed in the directory, that the node is NOT attached to. */
async function otherListedRelay(h: Harness): Promise<string> {
  const port = await freePort();
  const endpoint = `ws://127.0.0.1:${port}`;
  const identity = generateSigningKeyPair();
  const core = new RelayCore({ endpoint, identity, lookupDomainKey: async () => null });
  const server = serveRelay({ core, hostname: '127.0.0.1', port });
  cleanups.push(() => server.stop());
  h.relayKeys.set(endpoint, identity.publicKey);
  return endpoint;
}

describe('the client uses only the relay the service node signed', () => {
  test('with a valid binding the fetch works (end to end)', async () => {
    const h = await harness();
    expect(h.overlay().relayBinding).toBeDefined();
    const res = await socksFetch(h.socks.port, 'example.ox', 80, httpGet(2000));
    expect(splitHttp(res.body).payload.equals(patternBytes(2000))).toBe(true);
  });

  test('the registry naming another listed relay than the node signed is refused', async () => {
    const h = await harness();
    const other = await otherListedRelay(h);
    // The registry (or anyone who can change its rows) points clients at a
    // listed relay of its choosing, keeping the node's genuine binding.
    const err = await refusal(tunnelsFor(h, { ...h.overlay(), relay: other }));
    expect(err).toBeInstanceOf(TunnelError);
    expect(err.message).toContain('the service node signed that it is attached to');
  });

  test('a binding naming the relay under another key than the directory lists is refused', async () => {
    const h = await harness();
    const binding = h.bindingFor(h.relayEndpoint, generateSigningKeyPair().publicKey);
    const err = await refusal(tunnelsFor(h, { ...h.overlay(), relayBinding: binding }));
    expect(err.message).toContain('different key than the signed directory lists');
  });

  test('a binding not signed by the node key the chain authorizes, or stale, is refused', async () => {
    const h = await harness();
    const other = await otherListedRelay(h);
    const otherKey = h.relayKeys.get(other) as Uint8Array;
    const forged = signServiceRelayBinding(
      'example.ox',
      { endpoint: other, relayKey: otherKey, issuedAt: Math.floor(Date.now() / 1000) },
      generateSigningKeyPair(),
    );
    const err = await refusal(
      tunnelsFor(h, { ...h.overlay(), relay: other, relayBinding: forged }),
    );
    expect(err).toBeInstanceOf(OverlayVerificationError);
    expect((err as OverlayVerificationError).reason).toBe('bad-binding');

    const stale = signServiceRelayBinding(
      'example.ox',
      {
        endpoint: h.relayEndpoint,
        relayKey: h.relayIdentity.publicKey,
        issuedAt: Math.floor(Date.now() / 1000) - 7200,
      },
      h.creds.nodeKey,
    );
    const err2 = await refusal(tunnelsFor(h, { ...h.overlay(), relayBinding: stale }));
    expect((err2 as OverlayVerificationError).reason).toBe('bad-binding');
  });

  test('without a binding only an Oxy-operated relay is used', async () => {
    const h = await harness({ relayBinding: false });
    expect(h.overlay().relayBinding).toBeUndefined();
    const err = await refusal(h.tunnels);
    expect(err.message).toContain('only Oxy-operated relays are used');
    h.oxyRelays.add(h.relayEndpoint);
    const res = await socksFetch(h.socks.port, 'example.ox', 80, httpGet(500));
    expect(splitHttp(res.body).payload.equals(patternBytes(500))).toBe(true);
  });
});

describe('tnp connect re-checks open links', () => {
  test('links to a relay the directory no longer lists are closed', async () => {
    const h = await harness();
    const res = await socksFetch(h.socks.port, 'example.ox', 80, httpGet(100));
    expect(splitHttp(res.body).payload.equals(patternBytes(100))).toBe(true);
    const clientsBefore = h.core.stats().clients;
    expect(clientsBefore).toBeGreaterThan(0);
    // Still listed: kept.
    await h.tunnels.recheckLinks();
    expect(h.core.stats().clients).toBe(clientsBefore);
    // Delisted: closed.
    h.relayKeys.delete(h.relayEndpoint);
    await h.tunnels.recheckLinks();
    const until = Date.now() + 3000;
    while (h.core.stats().clients > 0 && Date.now() < until) await Bun.sleep(20);
    expect(h.core.stats().clients).toBe(0);
  });
});

describe('service node', () => {
  test('heartbeats carry a fresh binding to the relay it is attached to, signed by its node key', async () => {
    const h = await harness();
    const beats: Array<[string, ServiceRelayBinding | null]> = [];
    const node = new ServiceNode({
      name: 'example.ox',
      target: { host: '127.0.0.1', port: h.target.port },
      relays: [{ endpoint: h.relayEndpoint, relayKey: h.relayIdentity.publicKey }],
      nodeKey: h.creds.nodeKey,
      chain: h.creds.chain,
      heartbeat: async (endpoint, binding) => {
        beats.push([endpoint, binding]);
      },
      log: () => {},
    });
    cleanups.push(() => node.stop());
    await node.start();
    await node.whenServing();
    await Bun.sleep(20);
    const [endpoint, binding] = beats[0] ?? ['', null];
    expect(endpoint).toBe(h.relayEndpoint);
    const verified = verifyServiceRelayBinding(
      'example.ox',
      binding,
      h.creds.nodeKey.publicKey,
      Math.floor(Date.now() / 1000),
    );
    expect(verified.ok && verified.endpoint).toBe(h.relayEndpoint);
    expect(verified.ok && verified.relayKey).toEqual(h.relayIdentity.publicKey);
  });

  test('a spoofed ALREADY_REGISTERED from an unproven relay does not block fail-over', async () => {
    // The adversarial review's PoC: an impostor answers with a refusal
    // claiming the name is served elsewhere, which used to hold the node off
    // every other relay for five minutes.
    const h = await harness();
    const port = await freePort();
    let impostorConns = 0;
    const impostor = Bun.serve({
      hostname: '127.0.0.1',
      port,
      fetch(req, srv) {
        return srv.upgrade(req, { data: undefined }) ? undefined : new Response('no');
      },
      websocket: {
        open(ws: ServerWebSocket<unknown>) {
          impostorConns++;
          ws.sendBinary(
            encodeError({
              code: ErrorCode.ALREADY_REGISTERED,
              scope: ErrorScope.CONNECTION,
              detail: '',
            }),
          );
        },
        message() {},
      },
    });
    cleanups.push(() => impostor.stop(true));
    const node = new ServiceNode({
      name: 'example.ox',
      target: { host: '127.0.0.1', port: h.target.port },
      relays: [
        { endpoint: `ws://127.0.0.1:${port}`, relayKey: h.relayIdentity.publicKey },
        { endpoint: h.relayEndpoint, relayKey: h.relayIdentity.publicKey },
      ],
      nodeKey: h.creds.nodeKey,
      chain: h.creds.chain,
      log: () => {},
    });
    cleanups.push(() => node.stop());
    const start = Date.now();
    await node.start();
    await node.whenServing();
    expect(node.relayEndpoint).toBe(h.relayEndpoint);
    expect(impostorConns).toBeGreaterThanOrEqual(1);
    expect(Date.now() - start).toBeLessThan(10_000);
  }, 20_000);

  test('a relay the directory stops listing is left; no verified directory detaches the node', async () => {
    const h = await harness();
    const second = await otherListedRelay(h);
    const secondKey = h.relayKeys.get(second) as Uint8Array;
    const listed: RelayCandidate[] = [
      { endpoint: h.relayEndpoint, relayKey: h.relayIdentity.publicKey },
    ];
    let directoryUp = true;
    const node = new ServiceNode({
      name: 'example.ox',
      target: { host: '127.0.0.1', port: h.target.port },
      relays: listed,
      nodeKey: h.creds.nodeKey,
      chain: h.creds.chain,
      refreshRelays: async () => {
        if (!directoryUp) throw new Error('no verified relay directory: expired');
        return listed;
      },
      refreshIntervalMs: 100,
      log: () => {},
    });
    cleanups.push(() => node.stop());
    await node.start();
    await node.whenServing();

    // The directory becomes unverifiable: the node detaches and stays detached.
    directoryUp = false;
    const waitFor = async (cond: () => boolean) => {
      const until = Date.now() + 5000;
      while (!cond() && Date.now() < until) await Bun.sleep(20);
      return cond();
    };
    expect(await waitFor(() => node.status !== 'serving')).toBe(true);
    await Bun.sleep(400);
    expect(node.status).not.toBe('serving');

    // Verified again: it reattaches.
    directoryUp = true;
    expect(await waitFor(() => node.status === 'serving')).toBe(true);

    // Delisted (the directory now lists only another relay): it leaves.
    listed.splice(0, 1, { endpoint: second, relayKey: secondKey });
    expect(await waitFor(() => node.relayEndpoint === second)).toBe(true);
  }, 20_000);
});
