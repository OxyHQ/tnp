import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { parseNftablesArgs } from './cli';
import {
  BLOCKED_IPV4,
  BLOCKED_IPV6,
  type ExitFirewallOptions,
  FirewallConfigError,
  renderExitRuleset,
} from './nftables';

const OPTIONS: ExitFirewallOptions = {
  wgInterface: 'wg0',
  uplinkInterface: 'ens5',
  operatorCidrs: ['172.31.0.0/16'],
  dnsServers: ['198.51.100.53'],
};

const ruleset = renderExitRuleset(OPTIONS);
const forward = ruleset.slice(
  ruleset.indexOf('chain forward'),
  ruleset.indexOf('chain postrouting'),
);

describe('the exit ruleset', () => {
  test('matches the reviewed snapshot', () => {
    expect(ruleset).toMatchSnapshot();
  });

  test('blocks every exit-nodes.md §3 range, the metadata service and the VPC', () => {
    const mandatory = [
      '127.0.0.0/8',
      '::1/128',
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      '100.64.0.0/10',
      '169.254.0.0/16', // covers 169.254.169.254
      'fe80::/10',
      'fc00::/7', // covers fd00:ec2::254
      '224.0.0.0/4',
      'ff00::/8',
      '0.0.0.0/8',
      '240.0.0.0/4',
      '::/128',
    ];
    for (const range of mandatory) {
      expect([...BLOCKED_IPV4, ...BLOCKED_IPV6]).toContain(range);
      expect(ruleset).toContain(range);
    }
    const v4 = ruleset.slice(ruleset.indexOf('set blocked_v4'), ruleset.indexOf('set blocked_v6'));
    expect(v4).toContain('172.31.0.0/16');
    expect(forward).toContain('ip daddr @blocked_v4 counter name refused_private reject');
    expect(forward).toContain('ip6 daddr @blocked_v6 counter name refused_private reject');
  });

  test('refuses outbound SMTP on TCP 25 with a reset', () => {
    expect(forward).toMatch(
      /tcp dport \{ 25(, \d+)* \} counter name refused_port reject with tcp reset/,
    );
  });

  test('refuses all IPv6 forwarding, forwards only wg0 → uplink, and masquerades IPv4', () => {
    expect(forward).toContain('meta nfproto ipv6 counter name refused_ipv6 reject');
    expect(forward).toContain('iifname != "wg0" drop');
    expect(forward).toContain('oifname != "ens5" counter name refused_private reject');
    expect(forward).toContain('ip saddr != 10.77.0.0/16 drop');
    expect(forward).toContain('policy drop;');
    expect(ruleset).toContain('oifname "ens5" ip saddr 10.77.0.0/16 masquerade');
    // Blocks come before the accept.
    expect(forward.indexOf('@blocked_v4')).toBeLessThan(forward.indexOf('name forwarded accept'));
    expect(forward.indexOf('tcp dport')).toBeLessThan(forward.indexOf('name forwarded accept'));
  });

  test('nothing on the host is reachable from a peer, and nothing logs', () => {
    const input = ruleset.slice(ruleset.indexOf('chain input'), ruleset.indexOf('chain forward'));
    expect(input).toContain('policy drop;');
    expect(input).not.toContain('wg0');
    expect(input).toContain('iifname "ens5" udp dport 51820 accept');
    expect(ruleset).not.toMatch(/\blog\b/);
  });

  test('rate-limits DNS per peer only when resolvers are given', () => {
    expect(forward).toContain(
      'ip daddr @dns_v4 udp dport 53 add @dns_rate { ip saddr limit rate over 50/second',
    );
    const none = renderExitRuleset({ ...OPTIONS, dnsServers: [] });
    expect(none).not.toContain('dns_v4');
  });

  test('refuses invalid input instead of rendering it', () => {
    const bad: Array<Partial<ExitFirewallOptions>> = [
      { wgInterface: 'wg0"; flush ruleset; "' },
      { uplinkInterface: '' },
      { uplinkInterface: 'wg0' },
      { operatorCidrs: [] },
      { operatorCidrs: ['10.0.0.0/16 }'] },
      { dnsServers: ['198.51.100.53 }'] },
      { listenPort: 0 },
    ];
    for (const over of bad)
      expect(() => renderExitRuleset({ ...OPTIONS, ...over })).toThrow(FirewallConfigError);
  });

  test('the bootstrap arguments map onto the options', () => {
    expect(
      parseNftablesArgs([
        '--uplink',
        'ens5',
        '--operator-cidr',
        '10.0.0.0/16,10.1.0.0/16',
        '--dns',
        '198.51.100.53',
      ]),
    ).toEqual({
      wgInterface: 'wg0',
      uplinkInterface: 'ens5',
      listenPort: 51820,
      operatorCidrs: ['10.0.0.0/16', '10.1.0.0/16'],
      dnsServers: ['198.51.100.53'],
    });
    expect(() => parseNftablesArgs(['--uplink'])).toThrow(FirewallConfigError);
    expect(() => parseNftablesArgs(['--bogus', 'x'])).toThrow(FirewallConfigError);
  });
});

/**
 * The kernel's own parser, where it can be reached without privileges: `nft -c`
 * inside a fresh user + network namespace. GitHub's runners forbid
 * unprivileged user namespaces, so there this reports why it did not run
 * rather than passing silently; the bootstrap runs `nft -c` on the host before
 * loading anything, and refuses to bring up wg0 if it fails.
 */
const probe = spawnSync('unshare', ['-rn', 'nft', '--version'], { encoding: 'utf8' });
const nftUsable = probe.status === 0;
if (!nftUsable)
  console.warn('[nftables.test] nft -c not run: nft or unprivileged namespaces unavailable here');

describe.if(nftUsable)('nft accepts the ruleset', () => {
  test('nft -c, with overlapping operator ranges and IPv6 VPC space', () => {
    const text = renderExitRuleset({
      ...OPTIONS,
      operatorCidrs: ['172.31.0.0/16', '10.0.0.0/16', '2600:1f14:abc:de00::/56'],
      dnsServers: ['198.51.100.53', '2001:db8::53'],
    });
    const check = spawnSync('unshare', ['-rn', 'nft', '-c', '-f', '-'], {
      input: text,
      encoding: 'utf8',
    });
    expect({ status: check.status, stderr: check.stderr }).toEqual({ status: 0, stderr: '' });
  });
});
