/**
 * Router exports of a personal rule set, generated on the user's device from
 * decrypted rules. Pure functions: the web dashboard calls them in the browser
 * and nothing they produce is sent anywhere.
 *
 * Every rule passed in has already been through `parseDnsRule`, so names are
 * LDH ASCII and addresses are validated literals: nothing here can carry a
 * quote, a newline or a shell metacharacter into a config file or the `uci`
 * commands.
 *
 * The formats cannot all say what TNP's own resolver says, and each output
 * states where it differs (docs/dns-rules.mdx has the full table).
 */

import type { DnsRule } from './dns-rules.js';

type Block = Extract<DnsRule, { type: 'block' }>;
type Redirect = Extract<DnsRule, { type: 'redirect' }>;

function split(rules: readonly DnsRule[]): { blocks: Block[]; redirects: Redirect[] } {
  const byName = <T extends DnsRule>(a: T, b: T) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  return {
    blocks: rules.filter((r): r is Block => r.type === 'block').sort(byName),
    redirects: rules.filter((r): r is Redirect => r.type === 'redirect').sort(byName),
  };
}

const GENERATED =
  'Generated in your browser from your TNP personal DNS rules. TNP never saw this file.';

/** dnsmasq configuration lines (also what OpenWrt's dnsmasq reads from a conf-dir). */
export function exportDnsmasq(rules: readonly DnsRule[]): string {
  const { blocks, redirects } = split(rules);
  const lines = [
    '# TNP personal DNS rules for dnsmasq.',
    `# ${GENERATED}`,
    '#',
    '# How dnsmasq differs from the TNP client:',
    '# - address=/name/... matches the name AND every name under it. TNP blocks a',
    '#   subtree only for rules marked "and subdomains", and redirects one exact name.',
    '# - address=/name/ with no address answers NXDOMAIN, as TNP does.',
    '# - A redirect to an IPv4 address does not stop AAAA lookups; add an IPv6',
    '#   redirect for the same name if your devices use IPv6 (check with dig AAAA).',
    '# - cname= is answered only when dnsmasq itself knows the target (from',
    '#   /etc/hosts, DHCP or host-record), so CNAME redirects are left commented out.',
    '',
  ];
  if (blocks.length > 0) {
    lines.push('# Blocks');
    for (const rule of blocks) lines.push(`address=/${rule.name}/`);
    lines.push('');
  }
  if (redirects.length > 0) {
    lines.push('# Redirects');
    for (const rule of redirects) {
      if (rule.target.kind === 'name') {
        lines.push(`# cname=${rule.name},${rule.target.value}`);
      } else {
        lines.push(`address=/${rule.name}/${rule.target.value}`);
      }
    }
    lines.push('');
  }
  if (blocks.length + redirects.length === 0) lines.push('# (no rules)', '');
  return lines.join('\n');
}

/** OpenWrt `uci` commands that add the same dnsmasq entries. */
export function exportUci(rules: readonly DnsRule[]): string {
  const { blocks, redirects } = split(rules);
  const lines = [
    '# TNP personal DNS rules for OpenWrt. Run on the router as root.',
    `# ${GENERATED}`,
    '# Same semantics as the dnsmasq export: address= also covers subdomains.',
    '# Running this twice adds every entry twice; to start over, first review',
    '#   uci show dhcp.@dnsmasq[0].address',
    '# and remove the entries this script added.',
    '',
  ];
  for (const rule of blocks) {
    lines.push(`uci add_list dhcp.@dnsmasq[0].address='/${rule.name}/'`);
  }
  for (const rule of redirects) {
    if (rule.target.kind === 'name') {
      lines.push(
        `# CNAME, answered only if dnsmasq knows ${rule.target.value} locally:`,
        '# uci add dhcp cname',
        `# uci set dhcp.@cname[-1].cname='${rule.name}'`,
        `# uci set dhcp.@cname[-1].target='${rule.target.value}'`,
      );
    } else {
      lines.push(`uci add_list dhcp.@dnsmasq[0].address='/${rule.name}/${rule.target.value}'`);
    }
  }
  lines.push('uci commit dhcp', '/etc/init.d/dnsmasq restart', '');
  return lines.join('\n');
}

/** AdGuard Home custom filtering rules (Adblock-style DNS syntax with `$dnsrewrite`). */
export function exportAdGuard(rules: readonly DnsRule[]): string {
  const { blocks, redirects } = split(rules);
  const lines = [
    '! TNP personal DNS rules for AdGuard Home (Filters > Custom filtering rules).',
    `! ${GENERATED}`,
    '! ||name^ covers subdomains; |name^ is the exact name only.',
    '',
  ];
  for (const rule of blocks) {
    lines.push(`${rule.subdomains ? '||' : '|'}${rule.name}^$dnsrewrite=NXDOMAIN;;`);
  }
  for (const rule of redirects) {
    const type = rule.target.kind === 'ipv4' ? 'A' : rule.target.kind === 'ipv6' ? 'AAAA' : 'CNAME';
    lines.push(`|${rule.name}^$dnsrewrite=NOERROR;${type};${rule.target.value}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Hosts-file lines, for Pi-hole's Local DNS records or any `/etc/hosts`.
 * A hosts file can neither cover subdomains nor express a CNAME, so those
 * rules are emitted as comments saying where to put them in Pi-hole instead.
 */
export function exportHosts(rules: readonly DnsRule[]): string {
  const { blocks, redirects } = split(rules);
  const lines = [
    '# TNP personal DNS rules in hosts format (Pi-hole: Local DNS > DNS records).',
    `# ${GENERATED}`,
    '# Hosts entries answer one exact name. Blocks answer 0.0.0.0 / :: here,',
    '# not NXDOMAIN.',
    '',
  ];
  for (const rule of blocks) {
    lines.push(`0.0.0.0 ${rule.name}`, `:: ${rule.name}`);
    if (rule.subdomains) {
      const escaped = rule.name.replaceAll('.', '\\.');
      lines.push(`# subdomains: add the regex (\\.|^)${escaped}$ to Pi-hole's domain blocklist`);
    }
  }
  for (const rule of redirects) {
    if (rule.target.kind === 'name') {
      lines.push(
        `# CNAME ${rule.name} -> ${rule.target.value}: add it in Pi-hole under Local DNS > CNAME records`,
      );
    } else {
      lines.push(`${rule.target.value} ${rule.name}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
