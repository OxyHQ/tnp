import { describe, expect, test } from 'bun:test';
import { generateWireGuardKeyPair } from '@tnp/crypto/wireguard';
import { type ExitPeer, vpnIpv4ForIndex, vpnIpv6ForIpv4 } from '@tnp/shared-types';
import {
  allowedIpsFor,
  PEERS_PER_COMMAND,
  parseWgAllowedIps,
  planPeerChanges,
  WgOutputError,
  wgSetCommands,
} from './reconcile';

const peer = (index: number, publicKey = generateWireGuardKeyPair().publicKey): ExitPeer => {
  const ipv4 = vpnIpv4ForIndex(index);
  return { publicKey, ipv4, ipv6: vpnIpv6ForIpv4(ipv4) };
};

describe('parseWgAllowedIps', () => {
  test('reads keys and their prefixes, and (none)', () => {
    const a = peer(2);
    const b = peer(3);
    const output = `${a.publicKey}\t${a.ipv6}/128 ${a.ipv4}/32\n${b.publicKey}\t(none)\n`;
    expect(parseWgAllowedIps(output)).toEqual(
      new Map([
        [a.publicKey, [`${a.ipv4}/32`, `${a.ipv6}/128`]],
        [b.publicKey, []],
      ]),
    );
    expect(parseWgAllowedIps('')).toEqual(new Map());
  });

  test('anything unexpected is an error, so the round changes nothing', () => {
    for (const bad of [
      'garbage',
      'abc\t10.77.0.2/32',
      `${peer(2).publicKey} 10.77.0.2/32`,
      `${peer(2).publicKey}\ta\tb`,
    ]) {
      expect(() => parseWgAllowedIps(bad)).toThrow(WgOutputError);
    }
  });
});

describe('planPeerChanges', () => {
  test('adds missing peers, removes revoked ones, fixes changed addresses, leaves the rest', () => {
    const keep = peer(2);
    const add = peer(3);
    const moved = peer(4);
    const revoked = peer(5);
    const actual = new Map([
      [keep.publicKey, allowedIpsFor(keep)],
      [moved.publicKey, ['10.77.0.99/32']],
      [revoked.publicKey, allowedIpsFor(revoked)],
    ]);
    const plan = planPeerChanges([keep, add, moved], actual);
    expect(plan[0]).toEqual({ kind: 'remove', publicKey: revoked.publicKey });
    expect(plan.slice(1).sort((x, y) => x.publicKey.localeCompare(y.publicKey))).toEqual(
      [
        { kind: 'set' as const, publicKey: add.publicKey, allowedIps: allowedIpsFor(add) },
        { kind: 'set' as const, publicKey: moved.publicKey, allowedIps: allowedIpsFor(moved) },
      ].sort((x, y) => x.publicKey.localeCompare(y.publicKey)),
    );
  });

  test('an in-sync interface needs nothing; an empty list removes everyone', () => {
    const peers = [peer(2), peer(3)];
    const actual = new Map(peers.map((p) => [p.publicKey, allowedIpsFor(p)]));
    expect(planPeerChanges(peers, actual)).toEqual([]);
    expect(planPeerChanges([], actual).map((c) => c.kind)).toEqual(['remove', 'remove']);
  });

  test('removals come before sets, so a reused address is freed first', () => {
    const old = peer(9);
    const fresh = peer(9);
    const plan = planPeerChanges([fresh], new Map([[old.publicKey, allowedIpsFor(old)]]));
    expect(plan.map((c) => c.kind)).toEqual(['remove', 'set']);
  });
});

describe('wgSetCommands', () => {
  test('argument arrays only, for execFile — never a shell string', () => {
    const a = peer(2);
    const b = peer(3);
    expect(
      wgSetCommands('wg0', [
        { kind: 'remove', publicKey: b.publicKey },
        { kind: 'set', publicKey: a.publicKey, allowedIps: allowedIpsFor(a) },
      ]),
    ).toEqual([
      [
        'set',
        'wg0',
        'peer',
        b.publicKey,
        'remove',
        'peer',
        a.publicKey,
        'allowed-ips',
        allowedIpsFor(a).join(','),
      ],
    ]);
  });

  test('batches at most PEERS_PER_COMMAND peers per invocation', () => {
    const changes = Array.from({ length: PEERS_PER_COMMAND * 2 + 1 }, (_, i) => ({
      kind: 'remove' as const,
      publicKey: peer(i + 2).publicKey,
    }));
    const commands = wgSetCommands('wg0', changes);
    expect(commands.map((c) => (c.length - 2) / 3)).toEqual([
      PEERS_PER_COMMAND,
      PEERS_PER_COMMAND,
      1,
    ]);
    expect(wgSetCommands('wg0', [])).toEqual([]);
  });

  test('refuses anything that is not a key, an interface or a prefix list', () => {
    const a = peer(2);
    expect(() => wgSetCommands('wg0; reboot', [])).toThrow();
    expect(() => wgSetCommands('-h', [{ kind: 'remove', publicKey: a.publicKey }])).toThrow();
    expect(() => wgSetCommands('wg0', [{ kind: 'remove', publicKey: '--help' }])).toThrow();
    expect(() =>
      wgSetCommands('wg0', [{ kind: 'remove', publicKey: `${a.publicKey} x` }]),
    ).toThrow();
    expect(() =>
      wgSetCommands('wg0', [
        { kind: 'set', publicKey: a.publicKey, allowedIps: ['0.0.0.0/0 remove'] },
      ]),
    ).toThrow();
    expect(() =>
      wgSetCommands('wg0', [{ kind: 'set', publicKey: a.publicKey, allowedIps: [] }]),
    ).toThrow();
  });
});
