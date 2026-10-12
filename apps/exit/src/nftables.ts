/**
 * The exit's packet filter, as an nftables ruleset (docs/architecture/exit-nodes.md §3, §9).
 *
 * Generated rather than hand-written so that every input is validated and the
 * whole policy is one tested function: the blocked ranges below are the
 * mandatory SSRF list, and a ruleset missing one of them is a test failure,
 * not a review comment.
 *
 * What it enforces:
 *
 * - **Input**: only WireGuard on the uplink, replies, DHCP and the ICMP that
 *   keeps the path working. Nothing on the host is reachable from a peer — no
 *   SSH, no agent health port, no metadata service.
 * - **Forward**: peers may reach the public internet and nothing else. Every
 *   loopback, private, CGNAT, link-local (including the cloud metadata service
 *   at 169.254.169.254 and fd00:ec2::254), unique-local, multicast, reserved
 *   and documentation range is refused, as is every network the operator lists
 *   (the VPC). Outbound SMTP (TCP 25) and SMB/NetBIOS are refused. Peer-to-peer
 *   traffic is refused (it would leave and re-enter `wg0`).
 * - **IPv6** is captured by every client config (`::/0`) and refused here with
 *   an immediate ICMP error, so it can neither leak around the tunnel nor hang
 *   waiting for a timeout. It is not carried to the internet yet.
 * - **NAT**: peers leave through the host's own address (masquerade).
 *
 * What it never does: log. There is no `log` statement anywhere; the only
 * state is named aggregate counters (forwarded, refused by class) and the
 * kernel's connection-tracking table, which NAT needs and which lives in
 * memory for the life of each flow.
 */

import { isCidr, isValidIpv4, VPN_TUNNEL_IPV4_CIDR, VPN_WIREGUARD_PORT } from '@tnp/shared-types';

/** Destinations no peer may reach, IPv4. exit-nodes.md §3 plus the other special-use blocks. */
export const BLOCKED_IPV4: readonly string[] = [
  '0.0.0.0/8', // "this network" (reserved)
  '10.0.0.0/8', // RFC 1918 (also the tunnel pool itself: no peer-to-peer)
  '100.64.0.0/10', // CGNAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local, including the cloud metadata service 169.254.169.254
  '172.16.0.0/12', // RFC 1918
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // documentation (TEST-NET-1)
  '192.168.0.0/16', // RFC 1918
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // documentation (TEST-NET-2)
  '203.0.113.0/24', // documentation (TEST-NET-3)
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, including broadcast 255.255.255.255
];

/** Destinations no peer may reach, IPv6. Enforced even though IPv6 is refused below, so that carrying it later cannot forget them. */
export const BLOCKED_IPV6: readonly string[] = [
  '::/128', // unspecified (reserved)
  '::1/128', // loopback
  '::ffff:0:0/96', // IPv4-mapped: would reach the IPv4 ranges above
  '64:ff9b::/96', // NAT64 well-known prefix: same
  '64:ff9b:1::/48', // local-use NAT64
  '100::/64', // discard-only
  '2001:db8::/32', // documentation
  '2002::/16', // 6to4: embeds an IPv4 address
  'fc00::/7', // unique local, including the cloud metadata service fd00:ec2::254
  'fe80::/10', // link-local
  'ff00::/8', // multicast
];

/** Refused destination ports: SMTP (spam) and SMB/NetBIOS (worms, never legitimate across the internet). */
export const BLOCKED_TCP_PORTS: readonly number[] = [25, 137, 139, 445];
export const BLOCKED_UDP_PORTS: readonly number[] = [137, 138];

export interface ExitFirewallOptions {
  /** The WireGuard interface, e.g. `wg0`. */
  wgInterface: string;
  /** The interface with the default route, e.g. `ens5`. */
  uplinkInterface: string;
  /** WireGuard UDP port. */
  listenPort?: number;
  /** The operator's own networks — at least the VPC CIDR(s). Refused like private space. */
  operatorCidrs: readonly string[];
  /** The resolvers device configs name. DNS to them is rate-limited per peer; IPv4 only is used. */
  dnsServers: readonly string[];
  /** Per-peer DNS packets per second to `dnsServers` before drops. */
  dnsPacketsPerSecond?: number;
}

const IFACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$/;

export class FirewallConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FirewallConfigError';
  }
}

function elements(values: readonly string[]): string {
  return values.join(', ');
}

/** Render the complete ruleset. Throws `FirewallConfigError` on any invalid input. */
export function renderExitRuleset(options: ExitFirewallOptions): string {
  const {
    wgInterface,
    uplinkInterface,
    listenPort = VPN_WIREGUARD_PORT,
    operatorCidrs,
    dnsServers,
    dnsPacketsPerSecond = 50,
  } = options;
  if (!IFACE_RE.test(wgInterface)) throw new FirewallConfigError('invalid WireGuard interface');
  if (!IFACE_RE.test(uplinkInterface)) throw new FirewallConfigError('invalid uplink interface');
  if (wgInterface === uplinkInterface) throw new FirewallConfigError('interfaces must differ');
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65_535) {
    throw new FirewallConfigError('invalid listen port');
  }
  if (operatorCidrs.length === 0) {
    throw new FirewallConfigError('at least one operator CIDR (the VPC) is required');
  }
  for (const cidr of operatorCidrs) {
    if (!isCidr(cidr)) throw new FirewallConfigError('invalid operator CIDR');
  }
  for (const ip of dnsServers) {
    if (!isValidIpv4(ip) && !isCidr(`${ip}/128`))
      throw new FirewallConfigError('invalid DNS server');
  }
  if (
    !Number.isInteger(dnsPacketsPerSecond) ||
    dnsPacketsPerSecond < 1 ||
    dnsPacketsPerSecond > 100_000
  ) {
    throw new FirewallConfigError('invalid DNS rate');
  }

  const operatorV4 = operatorCidrs.filter((c) => !c.includes(':'));
  const operatorV6 = operatorCidrs.filter((c) => c.includes(':'));
  const dnsV4 = dnsServers.filter((ip) => isValidIpv4(ip));
  const wg = JSON.stringify(wgInterface);
  const up = JSON.stringify(uplinkInterface);

  const lines = [
    '#!/usr/sbin/nft -f',
    '# TNP exit packet filter. Generated by @tnp/exit (apps/exit/src/nftables.ts); do not edit.',
    '# No rule here logs. Counters are aggregate only.',
    '',
    // Idempotent replace of this table only; nothing else on the host is touched.
    'table inet tnp_exit',
    'delete table inet tnp_exit',
    '',
    'table inet tnp_exit {',
    '  set blocked_v4 {',
    '    type ipv4_addr',
    '    flags interval',
    '    auto-merge',
    `    elements = { ${elements([...BLOCKED_IPV4, ...operatorV4])} }`,
    '  }',
    '',
    '  set blocked_v6 {',
    '    type ipv6_addr',
    '    flags interval',
    '    auto-merge',
    `    elements = { ${elements([...BLOCKED_IPV6, ...operatorV6])} }`,
    '  }',
    '',
  ];
  if (dnsV4.length > 0) {
    lines.push(
      '  set dns_v4 {',
      '    type ipv4_addr',
      `    elements = { ${elements(dnsV4)} }`,
      '  }',
      '',
      '  set dns_rate {',
      '    type ipv4_addr',
      '    size 65536',
      '    flags dynamic,timeout',
      '    timeout 1m',
      '  }',
      '',
    );
  }
  lines.push(
    '  counter forwarded {}',
    '  counter refused_private {}',
    '  counter refused_port {}',
    '  counter refused_ipv6 {}',
    '  counter refused_dns_rate {}',
    '',
    '  chain input {',
    '    type filter hook input priority filter; policy drop;',
    '    iif "lo" accept',
    '    ct state invalid drop',
    '    ct state established,related accept',
    `    iifname ${up} udp dport ${listenPort} accept`,
    `    iifname ${up} udp sport 67 udp dport 68 accept`,
    `    iifname ${up} udp sport 547 udp dport 546 accept`,
    '    meta nfproto ipv4 icmp type { echo-request, destination-unreachable, time-exceeded, parameter-problem } limit rate 50/second accept',
    '    meta nfproto ipv6 icmpv6 type { destination-unreachable, packet-too-big, time-exceeded, parameter-problem, echo-request, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept',
    '  }',
    '',
    '  chain forward {',
    '    type filter hook forward priority filter; policy drop;',
    // Clamp MSS to the path MTU so a large-MTU path cannot black-hole TCP.
    '    tcp flags syn tcp option maxseg size set rt mtu',
    '    ct state invalid drop',
    '    ct state established,related accept',
    `    iifname != ${wg} drop`,
    `    ip saddr != ${VPN_TUNNEL_IPV4_CIDR} drop`,
    `    oifname != ${up} counter name refused_private reject with icmpx type admin-prohibited`,
    '    ip6 daddr @blocked_v6 counter name refused_private reject with icmpx type admin-prohibited',
    '    meta nfproto ipv6 counter name refused_ipv6 reject with icmpx type admin-prohibited',
    '    ip daddr @blocked_v4 counter name refused_private reject with icmpx type admin-prohibited',
    `    tcp dport { ${elements(BLOCKED_TCP_PORTS.map(String))} } counter name refused_port reject with tcp reset`,
    `    udp dport { ${elements(BLOCKED_UDP_PORTS.map(String))} } counter name refused_port reject with icmpx type admin-prohibited`,
  );
  if (dnsV4.length > 0) {
    lines.push(
      `    ip daddr @dns_v4 udp dport 53 add @dns_rate { ip saddr limit rate over ${dnsPacketsPerSecond}/second burst ${dnsPacketsPerSecond * 4} packets } counter name refused_dns_rate drop`,
    );
  }
  lines.push(
    `    oifname ${up} counter name forwarded accept`,
    '  }',
    '',
    '  chain postrouting {',
    '    type nat hook postrouting priority srcnat; policy accept;',
    `    oifname ${up} ip saddr ${VPN_TUNNEL_IPV4_CIDR} masquerade`,
    '  }',
    '}',
    '',
  );
  return lines.join('\n');
}
