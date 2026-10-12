/**
 * Which address a request comes from, for rate limiting.
 *
 * Production is Cloudflare → ALB → task. Every hop appends to
 * `X-Forwarded-For`, but only appends made by a proxy we trust mean anything:
 * a client can send any `X-Forwarded-For` it likes, and it arrives with the
 * real entries appended after it.
 *
 * - Trusting one hop (`TNP_TRUST_PROXY_HOPS=1`, the production default)
 *   trusts only the ALB, so the peer is whatever connected to the ALB. That is
 *   unforgeable — but for traffic through Cloudflare it is a Cloudflare edge
 *   address shared by many users, so keying limits on it alone would throttle
 *   everyone behind the same edge together.
 * - Trusting two would take the address Cloudflare saw — and would take a
 *   forged one from anyone who reaches the ALB without going through
 *   Cloudflare, which nothing in this repository prevents.
 *
 * The hop count is applied here, not through Express's `trust proxy`: that
 * setting also makes `req.hostname` read `X-Forwarded-Host`, which the ALB
 * passes through from the client, and the parking page and the installer
 * rewrite both route on the hostname.
 *
 * So `CF-Connecting-IP` (set by Cloudflare, overwriting any client value) is
 * used only when `TNP_TRUST_CF_CONNECTING_IP` is on (the production default)
 * AND the request's peer is inside Cloudflare's published ranges. A client
 * that bypasses Cloudflare cannot make its peer a Cloudflare address, so it
 * cannot choose its own key; it is keyed by its own address instead.
 *
 * IPv6 clients are keyed by their /64: one subscriber is routinely given a
 * whole /64, and a limit per /128 is no limit at all.
 */

import type { Request } from 'express';
import { BlockList, isIP } from 'node:net';

/**
 * Cloudflare's published edge ranges (https://www.cloudflare.com/ips/), as of
 * 2026-10. They change rarely; `TNP_CLOUDFLARE_IP_RANGES` overrides them
 * without a release. A stale list fails safe: a request from a new edge range
 * falls back to the peer address, which is coarser but still unforgeable.
 */
export const CLOUDFLARE_IP_RANGES: readonly string[] = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];

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

export interface ClientIpSettings {
  /** Proxies in front of the API whose `X-Forwarded-For` appends are believed. */
  trustProxyHops: number;
  trustCloudflareHeader: boolean;
  cloudflare: BlockList;
}

/**
 * The address that connected to the outermost trusted proxy: the socket peer,
 * then one `X-Forwarded-For` entry from the right per trusted hop. Entries
 * further left were written by the client or an untrusted hop and are never
 * read. Same rule as Express's numeric `trust proxy`.
 */
export function peerAddress(req: Request, trustProxyHops: number): string {
  const socketPeer = req.socket.remoteAddress ?? '';
  if (trustProxyHops <= 0) return unmapIpv4(socketPeer);
  const forwarded = (req.get('x-forwarded-for') ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const chain = [...forwarded, socketPeer];
  const chosen = chain[Math.max(0, chain.length - 1 - trustProxyHops)] ?? socketPeer;
  // A malformed entry from a trusted hop is not an address; fall back to the socket.
  return unmapIpv4(isIP(unmapIpv4(chosen)) !== 0 ? chosen : socketPeer);
}

/** The client's address as best this request can prove it. */
export function clientAddress(req: Request, settings: ClientIpSettings): string {
  const peer = peerAddress(req, settings.trustProxyHops);
  if (settings.trustCloudflareHeader && addressIn(settings.cloudflare, peer)) {
    const forwarded = req.get('cf-connecting-ip')?.trim() ?? '';
    if (isIP(forwarded) !== 0) return unmapIpv4(forwarded);
  }
  return peer;
}
