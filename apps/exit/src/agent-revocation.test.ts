/**
 * Revocation keeps its promise even when the exit cannot reach the API: the
 * agent stops serving at once when told to (401/403, 503 vpn_not_configured),
 * fails closed after the staleness limit, and deletes the connection-tracking
 * entries of every peer it removes.
 */

import { describe, expect, test } from 'bun:test';
import { generateWireGuardKeyPair } from '@tnp/crypto/wireguard';
import { vpnIpv4ForIndex, vpnIpv6ForIpv4 } from '@tnp/shared-types';
import {
  conntrackCommands,
  createConntrackRunner,
  createPeerFetcher,
  ExitAgent,
  StopServingError,
  syncOnce,
} from './agent';
import { allowedIpsFor } from './reconcile';

const peer = (index: number) => {
  const ipv4 = vpnIpv4ForIndex(index);
  return { publicKey: generateWireGuardKeyPair().publicKey, ipv4, ipv6: vpnIpv6ForIpv4(ipv4) };
};

function fakeWg(initial: Array<[string, string[]]> = []) {
  const peers = new Map(initial);
  const conntrack: string[][] = [];
  const runWg = async (args: string[]) => {
    if (args[0] === 'show') {
      return [...peers]
        .map(([k, ips]) => `${k}\t${ips.length ? ips.join(' ') : '(none)'}`)
        .join('\n');
    }
    for (let i = 2; i < args.length; ) {
      if (args[i + 2] === 'remove') {
        peers.delete(args[i + 1]);
        i += 3;
      } else {
        peers.set(args[i + 1], args[i + 3].split(',').sort());
        i += 4;
      }
    }
    return '';
  };
  const runConntrack = async (args: string[]) => {
    // Order matters: entries are deleted only once the peer is gone from wg0.
    conntrack.push([...args, `peers-left:${peers.size}`]);
  };
  return { peers, conntrack, runWg, runConntrack };
}

describe('revocation', () => {
  test('a removed peer loses its connection-tracking entries, after it leaves wg0', async () => {
    const keep = peer(2);
    const revoked = peer(3);
    const wg = fakeWg([
      [keep.publicKey, allowedIpsFor(keep)],
      [revoked.publicKey, allowedIpsFor(revoked)],
    ]);
    await syncOnce({
      fetchPeers: async () => ({ peers: [keep] }),
      runWg: wg.runWg,
      runConntrack: wg.runConntrack,
      iface: 'wg0',
    });
    expect(wg.conntrack).toEqual([
      ['-D', '-f', 'ipv4', '-s', revoked.ipv4, 'peers-left:1'],
      ['-D', '-f', 'ipv6', '-s', revoked.ipv6, 'peers-left:1'],
    ]);
  });

  test('401, 403 and 503 vpn_not_configured stop serving at once', async () => {
    for (const response of [
      () => new Response('{}', { status: 401 }),
      () => new Response('{}', { status: 403 }),
      () => Response.json({ code: 'vpn_not_configured' }, { status: 503 }),
    ]) {
      const p = peer(2);
      const wg = fakeWg([[p.publicKey, allowedIpsFor(p)]]);
      const lines: string[] = [];
      const agent = new ExitAgent({
        fetchPeers: createPeerFetcher({
          apiUrl: 'https://api.example.test',
          token: 't'.repeat(43),
          fetch: (async () => response()) as unknown as typeof fetch,
        }),
        runWg: wg.runWg,
        runConntrack: wg.runConntrack,
        iface: 'wg0',
        intervalMs: 20_000,
        log: (line) => lines.push(line),
      });
      await agent.tick();
      expect(wg.peers.size).toBe(0);
      expect(wg.conntrack).toHaveLength(2);
      expect(agent.health().status).toBe('flushed');
      expect(lines[0]).toStartWith('stopped serving');
    }
  });

  test('a 503 for any other reason is an outage, not a stop', async () => {
    const fetchPeers = createPeerFetcher({
      apiUrl: 'https://api.example.test',
      token: 't'.repeat(43),
      fetch: (async () =>
        Response.json({ error: 'busy' }, { status: 503 })) as unknown as typeof fetch,
    });
    const err = await fetchPeers().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StopServingError);
  });

  test('an outage keeps peers until the staleness limit, then removes them all; a sync restores them', async () => {
    let now = 0;
    let down = false;
    const p = peer(2);
    const wg = fakeWg();
    const agent = new ExitAgent({
      fetchPeers: async () => {
        if (down) throw new Error('peer list request failed with HTTP 502');
        return { peers: [p] };
      },
      runWg: wg.runWg,
      runConntrack: wg.runConntrack,
      iface: 'wg0',
      intervalMs: 20_000,
      maxStaleMs: 600_000,
      log: () => {},
      now: () => now,
    });
    await agent.tick();
    expect(wg.peers.size).toBe(1);

    down = true;
    now += 599_000;
    await agent.tick();
    expect(wg.peers.size).toBe(1);

    now += 2_000;
    await agent.tick();
    expect(wg.peers.size).toBe(0);
    expect(agent.health().status).toBe('flushed');

    down = false;
    now += 20_000;
    await agent.tick();
    expect(wg.peers.size).toBe(1);
    expect(agent.health().status).toBe('ok');
  });
});

describe('conntrackCommands', () => {
  test('only host prefixes of removed peers, as argument arrays', () => {
    const p = peer(5);
    const actual = new Map([[p.publicKey, allowedIpsFor(p)]]);
    expect(conntrackCommands(actual, [{ kind: 'remove', publicKey: p.publicKey }])).toEqual([
      ['-D', '-f', 'ipv4', '-s', p.ipv4],
      ['-D', '-f', 'ipv6', '-s', p.ipv6],
    ]);
    expect(
      conntrackCommands(actual, [{ kind: 'set', publicKey: p.publicKey, allowedIps: [] }]),
    ).toEqual([]);
    expect(
      conntrackCommands(new Map([[p.publicKey, ['10.77.0.0/16']]]), [
        { kind: 'remove', publicKey: p.publicKey },
      ]),
    ).toEqual([]);
  });

  test('the runner treats "nothing to delete" (exit 1) as success', async () => {
    await createConntrackRunner('/bin/false')(['-D']);
    await expect(createConntrackRunner('/bin/sh')(['-c', 'exit 2'])).rejects.toThrow(
      'conntrack -c failed (2)',
    );
  });
});
