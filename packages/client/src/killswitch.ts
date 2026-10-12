/**
 * The DNS kill switch.
 *
 * What it does, exactly: block outbound plain DNS — UDP and TCP to port 53,
 * over IPv4 and IPv6 — to every destination except loopback (the local TNP
 * resolver) and, when one is configured, the TNP public resolver. Nothing else
 * is blocked. It is not a full-traffic kill switch and not a VPN kill switch;
 * DNS-over-HTTPS, DNS-over-TLS and all non-DNS traffic pass untouched.
 *
 * Failure semantics: it is all or nothing. `enableKillSwitch` either installs
 * the rules for both address families, verifies the platform will actually
 * evaluate them, records them, and returns — or rolls back whatever it applied
 * and throws. A caller that asked for the kill switch must abort on that throw;
 * continuing without it is the fail-open the previous implementation had.
 *
 * Mechanism per platform:
 *  - Linux: an `inet` nftables table (one table covers IPv4 and IPv6). Without
 *    `nft`, a dedicated chain in both iptables and ip6tables; a host with IPv6
 *    and no ip6tables is refused rather than half-protected.
 *  - macOS: rules in the `com.apple/tnp-killswitch` pf anchor, which the stock
 *    ruleset evaluates through `anchor "com.apple/*"`. The main ruleset is
 *    checked for that line, pf is enabled with a reference token (`pfctl -E`)
 *    and the token released on teardown (`pfctl -X`), so pf is left as enabled
 *    or disabled as it was found.
 *  - Windows: outbound block rules whose remote addresses are the complement
 *    of the allowed set. Windows Firewall gives block rules precedence over
 *    allow rules, so "block all, allow some" cannot be expressed with two rules.
 *    Every firewall profile must be enabled, or the rules are inert.
 *
 * Planning (what to run) is pure and tested on every OS; `enableKillSwitch` and
 * `disableKillSwitch` are the only parts that touch the machine.
 */

import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { isIpLiteral, LEGACY_KILLSWITCH_MARKER_PATH, systemStateDir } from './config';
import { ensurePrivateDir, writeFileAtomic } from './secure-fs';
import {
  type Cmd,
  type CmdResult,
  type CmdRunner,
  findSystemBinary,
  formatCmd,
  isRoot,
  runChecked,
  runCmd,
} from './system-cmd';

export const NFT_TABLE = 'tnp_killswitch';
export const IPT_CHAIN = 'TNP_KILLSWITCH';
export const PF_ANCHOR = 'com.apple/tnp-killswitch';
/** The anchor 0.2.0 loaded into. Nothing referenced it, so it never filtered. */
const LEGACY_PF_ANCHOR = 'tnp-killswitch';
const LEGACY_PF_RULES_FILE = '/tmp/tnp-killswitch.conf';

export const NETSH_RULES = [
  { name: 'TNP-KillSwitch-DNS-UDP-v4', protocol: 'udp', family: 4 },
  { name: 'TNP-KillSwitch-DNS-TCP-v4', protocol: 'tcp', family: 4 },
  { name: 'TNP-KillSwitch-DNS-UDP-v6', protocol: 'udp', family: 6 },
  { name: 'TNP-KillSwitch-DNS-TCP-v6', protocol: 'tcp', family: 6 },
] as const;
/** Rule names 0.2.0 created; the allow rules never took effect under block precedence. */
const LEGACY_NETSH_RULES = [
  'TNP-KillSwitch-Block-DNS',
  'TNP-KillSwitch-Block-DNS-TCP',
  'TNP-KillSwitch-Allow-Local',
  'TNP-KillSwitch-Allow-TNP',
];

export type KillSwitchBackend = 'nft' | 'iptables' | 'pf' | 'netsh';

const BACKEND_TOOL: Record<KillSwitchBackend, string> = {
  nft: 'nft',
  iptables: 'iptables',
  pf: 'pfctl',
  netsh: 'netsh',
};

export class KillSwitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KillSwitchError';
  }
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Destinations besides loopback that may receive plain DNS. */
export interface KillSwitchAllow {
  v4: string[];
  v6: string[];
}

export function killSwitchAllow(publicDnsIp: string): KillSwitchAllow {
  const allow: KillSwitchAllow = { v4: [], v6: [] };
  if (!publicDnsIp) return allow;
  if (!isIpLiteral(publicDnsIp)) {
    throw new KillSwitchError(`TNP resolver address "${publicDnsIp}" is not an IP address`);
  }
  (publicDnsIp.includes(':') ? allow.v6 : allow.v4).push(publicDnsIp);
  return allow;
}

/** The sentence shown before the rules are applied and in status output. */
export function describeKillSwitch(allow: KillSwitchAllow): string {
  const extra = [...allow.v4, ...allow.v6];
  const except = extra.length
    ? `loopback (the local TNP resolver) and the TNP resolver ${extra.join(', ')}`
    : 'loopback (the local TNP resolver)';
  return (
    `blocks outbound plain DNS (UDP and TCP port 53, IPv4 and IPv6) to every address except ${except}. ` +
    'No other traffic is blocked: it is not a full-traffic kill switch, and DNS-over-HTTPS/DNS-over-TLS are not affected.'
  );
}

/**
 * Configured upstream resolvers the kill switch will cut off.
 *
 * The local resolver forwards public names to `upstreamDns`; a plain-DNS
 * upstream on port 53 that is neither loopback nor the TNP resolver is exactly
 * the traffic the kill switch drops, so the caller warns that public names will
 * stop resolving through it. DoH upstreams (`https://…`) are unaffected.
 */
export function upstreamsBlockedByKillSwitch(
  upstreamDns: string,
  allow: KillSwitchAllow,
): string[] {
  const allowed = new Set([...allow.v4, ...allow.v6]);
  const blocked: string[] = [];
  for (const raw of upstreamDns.split(',')) {
    const entry = raw.trim();
    if (!entry || /^https:\/\//i.test(entry)) continue;
    let host = entry;
    let port = 53;
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    if (bracketed) {
      host = bracketed[1];
      if (bracketed[2]) port = Number(bracketed[2]);
    } else if (/^[^:]+:\d+$/.test(entry)) {
      const [h, p] = entry.split(':');
      host = h;
      port = Number(p);
    }
    if (port !== 53) continue;
    if (host === '::1' || host.startsWith('127.')) continue;
    if (allowed.has(host)) continue;
    blocked.push(entry);
  }
  return blocked;
}

// ---------------------------------------------------------------------------
// Address arithmetic (Windows needs the complement of the allowed set)
// ---------------------------------------------------------------------------

function ipv4ToBigInt(addr: string): bigint {
  return addr.split('.').reduce((acc, octet) => (acc << 8n) | BigInt(Number(octet)), 0n);
}

function bigIntToIpv4(n: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((n >> shift) & 0xffn)).join('.');
}

function ipv6ToBigInt(addr: string): bigint {
  const groups = (part: string): number[] => {
    if (!part) return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (g.includes('.')) {
        const v4 = Number(ipv4ToBigInt(g));
        out.push(Math.floor(v4 / 0x10000), v4 & 0xffff);
      } else {
        out.push(Number.parseInt(g, 16));
      }
    }
    return out;
  };
  const [head, tail] = addr.includes('::') ? addr.split('::') : [addr, undefined];
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  return [...h, ...Array<number>(fill).fill(0), ...t].reduce(
    (acc, g) => (acc << 16n) | BigInt(g),
    0n,
  );
}

function bigIntToIpv6(n: bigint): string {
  const out: string[] = [];
  for (let i = 7; i >= 0; i--) out.push(((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  return out.join(':');
}

/** Gaps in [0, max] not covered by `excluded` (inclusive ranges). */
function complement(excluded: Array<[bigint, bigint]>, max: bigint): Array<[bigint, bigint]> {
  const sorted = [...excluded].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const gaps: Array<[bigint, bigint]> = [];
  let next = 0n;
  for (const [lo, hi] of sorted) {
    if (lo > next) gaps.push([next, lo - 1n]);
    if (hi + 1n > next) next = hi + 1n;
  }
  if (next <= max) gaps.push([next, max]);
  return gaps;
}

/** IPv4 ranges in netsh syntax covering everything but 127.0.0.0/8 and `allowed`. */
export function ipv4BlockRanges(allowed: string[]): string[] {
  const excluded: Array<[bigint, bigint]> = [
    [ipv4ToBigInt('127.0.0.0'), ipv4ToBigInt('127.255.255.255')],
    ...allowed.map((a): [bigint, bigint] => [ipv4ToBigInt(a), ipv4ToBigInt(a)]),
  ];
  return complement(excluded, 0xffffffffn).map(([lo, hi]) =>
    lo === hi ? bigIntToIpv4(lo) : `${bigIntToIpv4(lo)}-${bigIntToIpv4(hi)}`,
  );
}

/** IPv6 ranges in netsh syntax covering everything but ::1 and `allowed`. */
export function ipv6BlockRanges(allowed: string[]): string[] {
  const excluded: Array<[bigint, bigint]> = [
    [1n, 1n],
    ...allowed.map((a): [bigint, bigint] => [ipv6ToBigInt(a), ipv6ToBigInt(a)]),
  ];
  return complement(excluded, (1n << 128n) - 1n).map(([lo, hi]) =>
    lo === hi ? bigIntToIpv6(lo) : `${bigIntToIpv6(lo)}-${bigIntToIpv6(hi)}`,
  );
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export type BackendTools =
  | { backend: 'nft'; nft: string }
  | { backend: 'iptables'; iptables: string; ip6tables: string | null }
  | { backend: 'pf'; pfctl: string }
  | { backend: 'netsh'; netsh: string; powershell: string };

export interface VerifyStep {
  cmd: Cmd;
  /** An error message when the result shows the rules would not be enforced. */
  check: (result: CmdResult) => string | null;
}

export interface KillSwitchPlan {
  backend: KillSwitchBackend;
  apply: Cmd[];
  /** macOS only: `pfctl -E`, whose output carries the reference token. */
  enable?: Cmd;
  verify: VerifyStep[];
}

export function nftRuleset(allow: KillSwitchAllow): string {
  const accept = (family: 'ip' | 'ip6', dst: string) => [
    `    ${family} daddr ${dst} udp dport 53 accept`,
    `    ${family} daddr ${dst} tcp dport 53 accept`,
  ];
  return [
    // Create-then-delete-then-define in one `nft -f` transaction: an atomic
    // replace that works whether or not the table already exists.
    `table inet ${NFT_TABLE}`,
    `delete table inet ${NFT_TABLE}`,
    `table inet ${NFT_TABLE} {`,
    '  chain output {',
    '    type filter hook output priority 0; policy accept;',
    ...accept('ip', '127.0.0.0/8'),
    ...accept('ip6', '::1'),
    ...allow.v4.flatMap((a) => accept('ip', a)),
    ...allow.v6.flatMap((a) => accept('ip6', a)),
    '    udp dport 53 drop',
    '    tcp dport 53 drop',
    '  }',
    '}',
    '',
  ].join('\n');
}

export function pfRules(allow: KillSwitchAllow): string {
  // Passes first, every rule `quick`. 0.2.0 put a quick block first, which made
  // its passes unreachable; a non-quick block could instead be overridden by a
  // later pass elsewhere in the ruleset, since pf is last-match-wins.
  return [
    'pass out quick proto { tcp, udp } from any to 127.0.0.0/8 port 53',
    'pass out quick inet6 proto { tcp, udp } from any to ::1 port 53',
    ...allow.v4.map((a) => `pass out quick proto { tcp, udp } from any to ${a} port 53`),
    ...allow.v6.map((a) => `pass out quick inet6 proto { tcp, udp } from any to ${a} port 53`),
    'block drop out quick proto { tcp, udp } from any to any port 53',
    '',
  ].join('\n');
}

function iptablesApply(bin: string, loopback: string, allowed: string[]): Cmd[] {
  const cmds: Cmd[] = [{ file: bin, args: ['-w', '-N', IPT_CHAIN] }];
  for (const dst of [loopback, ...allowed]) {
    for (const proto of ['udp', 'tcp']) {
      cmds.push({
        file: bin,
        args: ['-w', '-A', IPT_CHAIN, '-d', dst, '-p', proto, '--dport', '53', '-j', 'RETURN'],
      });
    }
  }
  for (const proto of ['udp', 'tcp']) {
    cmds.push({
      file: bin,
      args: ['-w', '-A', IPT_CHAIN, '-p', proto, '--dport', '53', '-j', 'DROP'],
    });
  }
  cmds.push({ file: bin, args: ['-w', '-I', 'OUTPUT', '1', '-j', IPT_CHAIN] });
  return cmds;
}

const exitZero =
  (what: string) =>
  (r: CmdResult): string | null =>
    r.status === 0 ? null : `${what} (${(r.stderr || r.stdout).trim() || `exit ${r.status}`})`;

export function buildPlan(tools: BackendTools, allow: KillSwitchAllow): KillSwitchPlan {
  switch (tools.backend) {
    case 'nft':
      return {
        backend: 'nft',
        apply: [{ file: tools.nft, args: ['-f', '-'], input: nftRuleset(allow) }],
        verify: [
          {
            cmd: { file: tools.nft, args: ['list', 'table', 'inet', NFT_TABLE] },
            check: (r) =>
              r.status === 0 && r.stdout.includes('dport 53 drop')
                ? null
                : `nftables table inet ${NFT_TABLE} is not loaded`,
          },
        ],
      };
    case 'iptables': {
      const apply = iptablesApply(tools.iptables, '127.0.0.0/8', allow.v4);
      const verify: VerifyStep[] = [
        {
          cmd: { file: tools.iptables, args: ['-w', '-C', 'OUTPUT', '-j', IPT_CHAIN] },
          check: exitZero('iptables OUTPUT does not jump to the kill-switch chain'),
        },
      ];
      if (tools.ip6tables) {
        apply.push(...iptablesApply(tools.ip6tables, '::1/128', allow.v6));
        verify.push({
          cmd: { file: tools.ip6tables, args: ['-w', '-C', 'OUTPUT', '-j', IPT_CHAIN] },
          check: exitZero('ip6tables OUTPUT does not jump to the kill-switch chain'),
        });
      }
      return { backend: 'iptables', apply, verify };
    }
    case 'pf':
      return {
        backend: 'pf',
        apply: [{ file: tools.pfctl, args: ['-a', PF_ANCHOR, '-f', '-'], input: pfRules(allow) }],
        enable: { file: tools.pfctl, args: ['-E'] },
        verify: [
          {
            // Rules in an anchor nothing references are never evaluated — the
            // exact way 0.2.0's kill switch did nothing. The stock macOS
            // ruleset has `anchor "com.apple/*"`; a customised one may not.
            cmd: { file: tools.pfctl, args: ['-s', 'rules'] },
            check: (r) =>
              /^anchor "com\.apple\/\*"/m.test(r.stdout)
                ? null
                : 'the active pf ruleset has no `anchor "com.apple/*"` rule, so the kill-switch anchor would never be evaluated',
          },
          {
            cmd: { file: tools.pfctl, args: ['-a', PF_ANCHOR, '-s', 'rules'] },
            check: (r) =>
              r.status === 0 && r.stdout.includes('block drop out quick')
                ? null
                : `pf anchor ${PF_ANCHOR} did not load`,
          },
          {
            cmd: { file: tools.pfctl, args: ['-s', 'info'] },
            check: (r) => (/Status:\s*Enabled/.test(r.stdout) ? null : 'pf is not enabled'),
          },
        ],
      };
    case 'netsh': {
      const apply = NETSH_RULES.map(
        (rule): Cmd => ({
          file: tools.netsh,
          args: [
            'advfirewall',
            'firewall',
            'add',
            'rule',
            `name=${rule.name}`,
            'dir=out',
            'action=block',
            `protocol=${rule.protocol}`,
            'remoteport=53',
            `remoteip=${(rule.family === 4 ? ipv4BlockRanges(allow.v4) : ipv6BlockRanges(allow.v6)).join(',')}`,
            'profile=any',
            'enable=yes',
          ],
        }),
      );
      const verify: VerifyStep[] = [
        {
          // Rules in a disabled profile are stored but not enforced. The count
          // is printed rather than names so the check does not depend on the
          // display language.
          cmd: {
            file: tools.powershell,
            args: [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              '(Get-NetFirewallProfile | Where-Object { -not $_.Enabled } | Measure-Object).Count',
            ],
          },
          check: (r) =>
            r.status === 0 && r.stdout.trim() === '0'
              ? null
              : 'a Windows Firewall profile is disabled, so the kill-switch rules would not be enforced',
        },
        ...NETSH_RULES.map(
          (rule): VerifyStep => ({
            cmd: {
              file: tools.netsh,
              args: ['advfirewall', 'firewall', 'show', 'rule', `name=${rule.name}`],
            },
            check: exitZero(`firewall rule ${rule.name} was not created`),
          }),
        ),
      ];
      return { backend: 'netsh', apply, verify };
    }
  }
}

/**
 * Everything that removes kill-switch rules on this platform, for every
 * backend whose tool exists — a record naming one backend is not trusted to be
 * complete (the tool set may have changed since).
 */
export function teardownCommands(
  host: Pick<KillSwitchHost, 'platform' | 'findBinary'>,
  opts: { pfToken?: string; legacy?: boolean; publicDnsIp?: string } = {},
): Cmd[] {
  const cmds: Cmd[] = [];
  if (host.platform === 'win32') {
    const netsh = host.findBinary('netsh');
    if (!netsh) return cmds;
    for (const name of [...NETSH_RULES.map((r) => r.name), ...LEGACY_NETSH_RULES]) {
      cmds.push({
        file: netsh,
        args: ['advfirewall', 'firewall', 'delete', 'rule', `name=${name}`],
      });
    }
    return cmds;
  }
  if (host.platform === 'darwin') {
    const pfctl = host.findBinary('pfctl');
    if (!pfctl) return cmds;
    cmds.push({ file: pfctl, args: ['-a', PF_ANCHOR, '-F', 'all'] });
    cmds.push({ file: pfctl, args: ['-a', LEGACY_PF_ANCHOR, '-F', 'all'] });
    if (opts.pfToken && /^\d+$/.test(opts.pfToken)) {
      cmds.push({ file: pfctl, args: ['-X', opts.pfToken] });
    }
    return cmds;
  }
  const nft = host.findBinary('nft');
  if (nft) cmds.push({ file: nft, args: ['delete', 'table', 'inet', NFT_TABLE] });
  for (const name of ['iptables', 'ip6tables']) {
    const bin = host.findBinary(name);
    if (!bin) continue;
    cmds.push(
      { file: bin, args: ['-w', '-D', 'OUTPUT', '-j', IPT_CHAIN] },
      { file: bin, args: ['-w', '-F', IPT_CHAIN] },
      { file: bin, args: ['-w', '-X', IPT_CHAIN] },
    );
    // 0.2.0 inserted these straight into OUTPUT. They are only removed when its
    // marker says it ran, because an identical rule could be someone else's.
    if (opts.legacy && name === 'iptables') {
      const legacy = [
        ['-p', 'udp', '--dport', '53', '-j', 'DROP'],
        ['-p', 'tcp', '--dport', '53', '-j', 'DROP'],
        ['-p', 'udp', '--dport', '53', '-d', '127.0.0.1', '-j', 'ACCEPT'],
        ['-p', 'udp', '--dport', '5354', '-d', '127.0.0.1', '-j', 'ACCEPT'],
      ];
      if (opts.publicDnsIp && isIpLiteral(opts.publicDnsIp)) {
        legacy.push(['-p', 'udp', '--dport', '53', '-d', opts.publicDnsIp, '-j', 'ACCEPT']);
      }
      for (const spec of legacy) cmds.push({ file: bin, args: ['-w', '-D', 'OUTPUT', ...spec] });
    }
  }
  return cmds;
}

/** Commands that exit 0 (or print rules) only while kill-switch rules remain. */
function residualProbes(host: Pick<KillSwitchHost, 'platform' | 'findBinary'>): VerifyStep[] {
  const present = (what: string) => (r: CmdResult) => (r.status === 0 ? what : null);
  if (host.platform === 'win32') {
    const netsh = host.findBinary('netsh');
    if (!netsh) return [];
    return NETSH_RULES.map((rule) => ({
      cmd: { file: netsh, args: ['advfirewall', 'firewall', 'show', 'rule', `name=${rule.name}`] },
      check: present(`Windows Firewall rule ${rule.name}`),
    }));
  }
  if (host.platform === 'darwin') {
    const pfctl = host.findBinary('pfctl');
    if (!pfctl) return [];
    return [
      {
        cmd: { file: pfctl, args: ['-a', PF_ANCHOR, '-s', 'rules'] },
        check: (r) => (r.status === 0 && r.stdout.trim() ? `pf anchor ${PF_ANCHOR}` : null),
      },
    ];
  }
  const probes: VerifyStep[] = [];
  const nft = host.findBinary('nft');
  if (nft) {
    probes.push({
      cmd: { file: nft, args: ['list', 'table', 'inet', NFT_TABLE] },
      check: present(`nftables table inet ${NFT_TABLE}`),
    });
  }
  for (const name of ['iptables', 'ip6tables']) {
    const bin = host.findBinary(name);
    if (bin) {
      probes.push({
        cmd: { file: bin, args: ['-w', '-n', '-L', IPT_CHAIN] },
        check: present(`${name} chain ${IPT_CHAIN}`),
      });
    }
  }
  return probes;
}

export function parsePfToken(output: string): string | null {
  return /Token\s*:\s*(\d+)/.exec(output)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Host and state
// ---------------------------------------------------------------------------

export interface KillSwitchHost {
  platform: NodeJS.Platform;
  isRoot: boolean;
  findBinary: (name: string) => string | null;
  /** Whether the machine has IPv6 at all; a v4-only host needs no v6 rules. */
  ipv6Present: boolean;
  run: CmdRunner;
}

export function defaultHost(): KillSwitchHost {
  return {
    platform: process.platform,
    isRoot: isRoot(),
    findBinary: (name) => findSystemBinary(name),
    ipv6Present: process.platform !== 'linux' || existsSync('/proc/net/if_inet6'),
    run: runCmd,
  };
}

export function selectBackend(host: KillSwitchHost): BackendTools {
  if (host.platform === 'win32') {
    const netsh = host.findBinary('netsh');
    const powershell = host.findBinary('powershell');
    if (!netsh || !powershell) {
      throw new KillSwitchError('netsh.exe and powershell.exe are required for the kill switch');
    }
    return { backend: 'netsh', netsh, powershell };
  }
  if (!host.isRoot) {
    throw new KillSwitchError(
      'the kill switch changes firewall rules and needs root: rerun with sudo',
    );
  }
  if (host.platform === 'darwin') {
    const pfctl = host.findBinary('pfctl');
    if (!pfctl) throw new KillSwitchError('pfctl was not found');
    return { backend: 'pf', pfctl };
  }
  if (host.platform !== 'linux') {
    throw new KillSwitchError(`the kill switch is not supported on ${host.platform}`);
  }
  const nft = host.findBinary('nft');
  if (nft) return { backend: 'nft', nft };
  const iptables = host.findBinary('iptables');
  const ip6tables = host.findBinary('ip6tables');
  if (!iptables) throw new KillSwitchError('neither nft nor iptables was found');
  if (!ip6tables && host.ipv6Present) {
    throw new KillSwitchError(
      'IPv6 is enabled but ip6tables was not found: IPv6 DNS would not be blocked. Install nftables or ip6tables.',
    );
  }
  return { backend: 'iptables', iptables, ip6tables };
}

export interface KillSwitchRecord {
  version: 1;
  backend: KillSwitchBackend;
  pid: number;
  enabledAt: string;
  /** macOS: the `pfctl -E` reference to release with `pfctl -X`. */
  pfToken?: string;
}

export interface KillSwitchStore {
  /** `present` is true when a record file exists, even an unreadable one. */
  read(): { present: boolean; record: KillSwitchRecord | null };
  write(record: KillSwitchRecord): void;
  clear(): void;
  legacyPresent(): boolean;
  clearLegacy(): void;
}

export function killSwitchRecordPath(): string {
  return join(systemStateDir(), 'killswitch.json');
}

function parseRecord(raw: string): KillSwitchRecord | null {
  try {
    const r = JSON.parse(raw) as Partial<KillSwitchRecord>;
    if (r.version !== 1) return null;
    if (!['nft', 'iptables', 'pf', 'netsh'].includes(String(r.backend))) return null;
    if (r.pfToken !== undefined && !/^\d+$/.test(String(r.pfToken))) return null;
    return r as KillSwitchRecord;
  } catch {
    return null;
  }
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/** The record lives in the root-only system state dir, never in /tmp (audit S10). */
export function fileStore(): KillSwitchStore {
  const path = killSwitchRecordPath();
  return {
    read() {
      if (!lexists(path)) return { present: false, record: null };
      const st = lstatSync(path);
      if (!st.isFile()) return { present: true, record: null };
      try {
        return { present: true, record: parseRecord(readFileSync(path, 'utf-8')) };
      } catch {
        return { present: true, record: null };
      }
    },
    write(record) {
      ensurePrivateDir(systemStateDir());
      writeFileAtomic(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    },
    clear() {
      unlinkQuiet(path);
    },
    legacyPresent() {
      return lexists(LEGACY_KILLSWITCH_MARKER_PATH);
    },
    clearLegacy() {
      // unlink removes a planted symlink itself, never its target.
      unlinkQuiet(LEGACY_KILLSWITCH_MARKER_PATH);
      if (process.platform === 'darwin') unlinkQuiet(LEGACY_PF_RULES_FILE);
    },
  };
}

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Apply the kill switch, or throw `KillSwitchError` with nothing left applied.
 */
export function enableKillSwitch(
  publicDnsIp: string,
  host: KillSwitchHost = defaultHost(),
  store: KillSwitchStore = fileStore(),
): KillSwitchRecord {
  const allow = killSwitchAllow(publicDnsIp);
  const tools = selectBackend(host);
  const plan = buildPlan(tools, allow);

  // Start from a known state: a crashed earlier run may have left rules.
  const stale = store.read().record;
  for (const cmd of teardownCommands(host, {
    pfToken: stale?.pfToken,
    legacy: store.legacyPresent(),
    publicDnsIp,
  })) {
    host.run(cmd);
  }

  let pfToken: string | undefined;
  try {
    for (const cmd of plan.apply) runChecked(cmd, host.run);
    if (plan.enable) {
      const res = runChecked(plan.enable, host.run);
      const token = parsePfToken(`${res.stdout}\n${res.stderr}`);
      if (!token)
        throw new KillSwitchError(`${formatCmd(plan.enable)} returned no reference token`);
      pfToken = token;
    }
    for (const step of plan.verify) {
      const problem = step.check(host.run(step.cmd));
      if (problem) throw new KillSwitchError(problem);
    }
    const record: KillSwitchRecord = {
      version: 1,
      backend: plan.backend,
      pid: process.pid,
      enabledAt: new Date().toISOString(),
      ...(pfToken ? { pfToken } : {}),
    };
    store.write(record);
    store.clearLegacy();
    return record;
  } catch (err) {
    for (const cmd of teardownCommands(host, { pfToken })) host.run(cmd);
    throw err instanceof KillSwitchError ? err : new KillSwitchError(errorMessage(err));
  }
}

/** True when an earlier run (this version's or 0.2.0's) recorded active rules. */
export function killSwitchRecorded(store: KillSwitchStore = fileStore()): boolean {
  return store.read().present || store.legacyPresent();
}

/**
 * Remove every kill-switch rule this platform could hold and report what, if
 * anything, is still in place. The record is kept while rules remain, so a
 * later run (or `tnp uninstall`) retries.
 */
export function disableKillSwitch(
  publicDnsIp: string,
  host: KillSwitchHost = defaultHost(),
  store: KillSwitchStore = fileStore(),
): { residual: string[] } {
  if (host.platform !== 'win32' && !host.isRoot) {
    throw new KillSwitchError('removing kill-switch firewall rules needs root: rerun with sudo');
  }
  const { record } = store.read();
  for (const cmd of teardownCommands(host, {
    pfToken: record?.pfToken,
    legacy: store.legacyPresent(),
    publicDnsIp,
  })) {
    host.run(cmd);
  }
  const residual = residualProbes(host)
    .map((probe) => probe.check(host.run(probe.cmd)))
    .filter((r): r is string => r !== null);
  // No probe for a backend whose tool is gone is not evidence its rules are
  // gone: kernel rules outlive the binary that loaded them. Keep the record.
  if (record) {
    const tool = BACKEND_TOOL[record.backend];
    if (!host.findBinary(tool)) {
      residual.push(
        `${record.backend} rules, which cannot be checked or removed because ${tool} is missing`,
      );
    }
  }
  if (residual.length === 0) {
    store.clear();
    store.clearLegacy();
  }
  return { residual };
}
