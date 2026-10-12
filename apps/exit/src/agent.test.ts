/**
 * The exit agent's sync loop, with the API and `wg` replaced by fakes — plus
 * the consumer half of the `/exit/peers` contract: a body typed as the API's
 * `ExitPeersResponse` (the route builds exactly this type; its real output is
 * parsed the same way in `apps/api/test-db/vpn-devices.test.ts`) is what the
 * agent accepts.
 */

import { describe, expect, test } from 'bun:test';
import { generateWireGuardKeyPair } from '@tnp/crypto/wireguard';
import { type ExitPeersResponse, vpnIpv4ForIndex, vpnIpv6ForIpv4 } from '@tnp/shared-types';
import {
  createPeerFetcher,
  createWgRunner,
  ExitAgent,
  MAX_PEERS_BODY_BYTES,
  syncOnce,
} from './agent';
import { allowedIpsFor } from './reconcile';

const peer = (index: number) => {
  const ipv4 = vpnIpv4ForIndex(index);
  return { publicKey: generateWireGuardKeyPair().publicKey, ipv4, ipv6: vpnIpv6ForIpv4(ipv4) };
};

/** A fake `wg` holding peers in memory and recording every argument list. */
function fakeWg(initial: Array<[string, string[]]> = []) {
  const peers = new Map(initial);
  const calls: string[][] = [];
  const runWg = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'show') {
      return [...peers]
        .map(([k, ips]) => `${k}\t${ips.length ? ips.join(' ') : '(none)'}`)
        .join('\n');
    }
    for (let i = 2; i < args.length; ) {
      const key = args[i + 1];
      if (args[i + 2] === 'remove') {
        peers.delete(key);
        i += 3;
      } else {
        peers.set(key, args[i + 3].split(',').sort());
        i += 4;
      }
    }
    return '';
  };
  const conntrack: string[][] = [];
  const runConntrack = async (args: string[]) => {
    conntrack.push(args);
  };
  return { peers, calls, runWg, conntrack, runConntrack };
}

describe('syncOnce', () => {
  test('converges the interface on the API list, and a second round changes nothing', async () => {
    const keep = peer(2);
    const add = peer(3);
    const revoked = peer(4);
    const wg = fakeWg([
      [keep.publicKey, allowedIpsFor(keep)],
      [revoked.publicKey, allowedIpsFor(revoked)],
    ]);
    const body: ExitPeersResponse = { peers: [keep, add] };
    const deps = {
      fetchPeers: async () => JSON.parse(JSON.stringify(body)),
      runWg: wg.runWg,
      runConntrack: wg.runConntrack,
      iface: 'wg0',
    };

    expect(await syncOnce(deps)).toEqual({ peers: 2, set: 1, removed: 1, rejected: 0 });
    expect(wg.peers).toEqual(
      new Map([
        [keep.publicKey, allowedIpsFor(keep)],
        [add.publicKey, allowedIpsFor(add)],
      ]),
    );
    const before = wg.calls.length;
    expect(await syncOnce(deps)).toEqual({ peers: 2, set: 0, removed: 0, rejected: 0 });
    expect(wg.calls.slice(before)).toEqual([['show', 'wg0', 'allowed-ips']]);
  });

  test('when the API fails or answers garbage, no peer is touched', async () => {
    const existing = peer(2);
    const wg = fakeWg([[existing.publicKey, allowedIpsFor(existing)]]);
    for (const fetchPeers of [
      async () => {
        throw new Error('peer list request failed with HTTP 503');
      },
      async () => ({ peers: 'nope' }),
      async () => [],
    ]) {
      await expect(
        syncOnce({ fetchPeers, runWg: wg.runWg, runConntrack: wg.runConntrack, iface: 'wg0' }),
      ).rejects.toThrow();
    }
    expect(wg.calls.filter((c) => c[0] === 'set')).toEqual([]);
    expect(wg.peers.size).toBe(1);
  });

  test('when wg prints something unexpected, nothing is set', async () => {
    const calls: string[][] = [];
    const runWg = async (args: string[]) => {
      calls.push(args);
      return 'interface: wg0\n  public key: x';
    };
    await expect(
      syncOnce({
        fetchPeers: async () => ({ peers: [peer(2)] }),
        runWg,
        runConntrack: async () => {},
        iface: 'wg0',
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([['show', 'wg0', 'allowed-ips']]);
  });
});

describe('createPeerFetcher', () => {
  const ok = (body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers });

  test('sends the bearer token to /exit/peers and refuses redirects', async () => {
    let seen: { url: string; init?: RequestInit } | null = null;
    const fetchPeers = createPeerFetcher({
      apiUrl: 'https://api.example.test/',
      token: 't'.repeat(40),
      fetch: (async (url: string, init?: RequestInit) => {
        seen = { url, init };
        return ok({ peers: [] });
      }) as unknown as typeof fetch,
    });
    expect(await fetchPeers()).toEqual({ peers: [] });
    const got = seen as unknown as { url: string; init: RequestInit };
    expect(got.url).toBe('https://api.example.test/exit/peers');
    expect((got.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${'t'.repeat(40)}`,
    );
    expect(got.init.redirect).toBe('error');
  });

  test('anything but a 200 with a bounded JSON body is an error that quotes nothing', async () => {
    const cases: Response[] = [
      new Response('{}', { status: 401 }),
      new Response('{}', { status: 503 }),
      new Response('{}', {
        status: 200,
        headers: { 'Content-Length': String(MAX_PEERS_BODY_BYTES + 1) },
      }),
      new Response('not json SECRETKEY', { status: 200 }),
    ];
    for (const response of cases) {
      const fetchPeers = createPeerFetcher({
        apiUrl: 'https://api.example.test',
        token: 't'.repeat(40),
        fetch: (async () => response) as unknown as typeof fetch,
      });
      const err = (await fetchPeers().catch((e: Error) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).not.toContain('SECRETKEY');
    }
  });
});

describe('createWgRunner', () => {
  test('passes arguments as an array: shell metacharacters stay literal', async () => {
    const run = createWgRunner('/bin/echo');
    expect(await run(['set', 'wg0;', 'touch', '/tmp/pwned', '$(id)'])).toBe(
      'set wg0; touch /tmp/pwned $(id)\n',
    );
  });

  test('a failure reports the exit, not stderr', async () => {
    const run = createWgRunner('/bin/false');
    await expect(run(['show'])).rejects.toThrow('wg show failed');
  });
});

describe('ExitAgent health', () => {
  test('starting, then ok, then stale once syncs stop succeeding', async () => {
    let now = 1_000_000;
    let fail = false;
    const agent = new ExitAgent({
      fetchPeers: async () => {
        if (fail) throw new Error('down');
        return { peers: [] };
      },
      runWg: fakeWg().runWg,
      runConntrack: async () => {},
      iface: 'wg0',
      intervalMs: 20_000,
      log: () => {},
      now: () => now,
    });
    expect(agent.health()).toEqual({
      status: 'starting',
      peers: null,
      lastSyncAgeSeconds: null,
      consecutiveFailures: 0,
    });
    await agent.tick();
    expect(agent.health()).toEqual({
      status: 'ok',
      peers: 0,
      lastSyncAgeSeconds: 0,
      consecutiveFailures: 0,
    });
    fail = true;
    now += 60_000;
    await agent.tick();
    expect(agent.health().status).toBe('ok');
    expect(agent.health().consecutiveFailures).toBe(1);
    now += 30_000;
    expect(agent.health().status).toBe('stale');
  });

  test('log lines carry counts, never keys or addresses', async () => {
    const lines: string[] = [];
    const p = peer(2);
    const agent = new ExitAgent({
      fetchPeers: async () => ({ peers: [p, { ...p, publicKey: 'bad' }] }),
      runWg: fakeWg().runWg,
      runConntrack: async () => {},
      iface: 'wg0',
      intervalMs: 20_000,
      log: (line) => lines.push(line),
    });
    await agent.tick();
    expect(lines).toEqual(['synced: 1 peers, 1 set, 0 removed, 1 rejected']);
    expect(lines.join('\n')).not.toContain(p.publicKey);
    expect(lines.join('\n')).not.toContain(p.ipv4);
  });
});
