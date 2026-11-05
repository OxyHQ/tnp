/**
 * Which address a request comes from, for rate limiting.
 *
 * Production is Cloudflare → ALB → task, and some callers (TNP's own DNS
 * server, a VPN exit's resolver) reach the ALB through Cloudflare too. The
 * client address is `resolveClientIp` from `@oxy.so/core/server` — the same
 * rule every Oxy backend applies through `oxyTrustProxy`: the ALB (a private
 * socket peer) is trusted to have appended the address it saw, and that
 * address is trusted to have appended the client's only when it is one of
 * Cloudflare's published edge ranges. Nothing further left is ever read, so a
 * client that reaches the ALB without Cloudflare is keyed by its own address
 * and cannot choose another.
 *
 * It is applied here, not through Express's `trust proxy`: that setting also
 * makes `req.hostname` read `X-Forwarded-Host`, which the ALB passes through
 * from the client, and the parking page and the installer rewrite both route
 * on the hostname.
 *
 * IPv6 clients are keyed by their /64: one subscriber is routinely given a
 * whole /64, and a limit per /128 is no limit at all.
 */

import { BlockList, isIP } from 'node:net';
import { resolveClientIp } from '@oxy.so/core/server';
import type { Request } from 'express';

/** `::ffff:192.0.2.1` → `192.0.2.1`; everything else unchanged. */
export function unmapIpv4(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  return mapped ? mapped[1] : address;
}

/**
 * A set of addresses and CIDRs. Entries that do not parse are reported rather
 * than silently dropped: a typo in an exemption list should be visible.
 */
export function buildAddressSet(entries: readonly string[]): {
  set: BlockList;
  invalid: string[];
} {
  const set = new BlockList();
  const invalid: string[] = [];
  for (const entry of entries) {
    const [address, prefixText] = entry.split('/');
    const family = isIP(address);
    if (family === 0) {
      invalid.push(entry);
      continue;
    }
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (prefixText === undefined) {
      set.addAddress(address, type);
      continue;
    }
    const prefix = Number(prefixText);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
      invalid.push(entry);
      continue;
    }
    set.addSubnet(address, prefix, type);
  }
  return { set, invalid };
}

export function addressIn(set: BlockList, address: string): boolean {
  const unmapped = unmapIpv4(address);
  const family = isIP(unmapped);
  if (family === 0) return false;
  return set.check(unmapped, family === 4 ? 'ipv4' : 'ipv6');
}

/** The /64 an IPv6 address belongs to, as a stable key. */
function ipv6Prefix64(address: string): string {
  const [head, tail = ''] = address.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::')
    ? [...left, ...new Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** The rate-limit key for an address: itself for IPv4, its /64 for IPv6. */
export function addressKey(address: string): string {
  const unmapped = unmapIpv4(address);
  return isIP(unmapped) === 6 ? ipv6Prefix64(unmapped) : unmapped;
}

/**
 * The client's address as the proxy chain proves it, by Oxy's one rule
 * (`resolveClientIp` from `@oxy.so/core/server`): the socket peer is believed
 * as a proxy only when it is private (the ALB), and the hop the ALB saw only
 * when it is a Cloudflare edge. Empty only when the socket has already closed.
 */
export function clientAddress(req: Request): string {
  return unmapIpv4(resolveClientIp(req) ?? '');
}
