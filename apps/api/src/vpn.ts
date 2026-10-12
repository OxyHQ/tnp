/**
 * Configuration and exit authentication for the standard-tier VPN
 * (docs/architecture/vpn.md §10).
 *
 * The feature is OFF unless `TNP_VPN_EXITS` names at least one exit: every
 * `/me/vpn` route that would hand out a config answers 503
 * `vpn_not_configured`, and `/exit/peers` serves nobody. A malformed value
 * turns it off too, loudly, rather than taking the API down with it — DNS
 * must keep resolving whatever happens to the VPN configuration.
 *
 * - `TNP_VPN_EXITS`  JSON array of `{ id, region, endpoint, publicKey }`
 *   (`endpoint` is `host:port`; `publicKey` the exit's WireGuard public key).
 * - `TNP_VPN_DNS`    resolver addresses for the device config's `DNS =` line,
 *   comma-separated. Defaults to `TNP_PARKING_IP` (the public resolver's
 *   address). With neither, the feature stays off: a config without a resolver
 *   would leave every device on whatever DNS its network hands it.
 * - `TNP_EXIT_TOKENS` bearer secrets the exit agents present, comma-separated,
 *   one per exit so each can be revoked alone. At least 43 base64url
 *   characters each (`isStrongExitToken`);
 *   held only as SHA-256 digests in memory.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  isStrongExitToken,
  isValidIpv4,
  isValidIpv6,
  parseVpnExit,
  VPN_ALLOWED_IPS,
  VPN_MAX_DEVICES_PER_USER,
  type VpnExit,
  type VpnNetwork,
} from '@tnp/shared-types';

export interface VpnConfig {
  exits: VpnExit[];
  dns: string[];
  /** SHA-256 of each accepted exit token. */
  exitTokenDigests: Uint8Array[];
  maxDevices: number;
}

export interface VpnConfigResult {
  /** Null when the feature is off. */
  config: VpnConfig | null;
  /** Problems an operator must see at startup. Never contains a token. */
  warnings: string[];
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

export function digestToken(token: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(token, 'utf8').digest());
}

/** Read the VPN settings from the environment. Pure: takes the env, logs nothing. */
export function readVpnConfig(env: Record<string, string | undefined>): VpnConfigResult {
  const warnings: string[] = [];
  const raw = env.TNP_VPN_EXITS?.trim();
  if (!raw) return { config: null, warnings };

  const off = (why: string): VpnConfigResult => ({
    config: null,
    warnings: [...warnings, `VPN disabled: ${why}`],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return off('TNP_VPN_EXITS is not valid JSON');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return off('TNP_VPN_EXITS must be a non-empty JSON array');
  }
  const exits: VpnExit[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const exit = parseVpnExit(parsed[i], `TNP_VPN_EXITS[${i}]`);
    if (!exit.ok) return off(exit.error);
    if (exits.some((e) => e.id === exit.value.id || e.publicKey === exit.value.publicKey)) {
      return off(`TNP_VPN_EXITS[${i}] repeats an id or a public key`);
    }
    exits.push(exit.value);
  }

  const dnsSource = env.TNP_VPN_DNS?.trim() ? 'TNP_VPN_DNS' : 'TNP_PARKING_IP';
  const dns = list(env[dnsSource]);
  if (dns.length === 0) return off('neither TNP_VPN_DNS nor TNP_PARKING_IP names a resolver');
  if (!dns.every((ip) => isValidIpv4(ip) || isValidIpv6(ip))) {
    return off(`${dnsSource} must list IP addresses only`);
  }

  const exitTokenDigests: Uint8Array[] = [];
  let ignored = 0;
  for (const token of list(env.TNP_EXIT_TOKENS)) {
    if (isStrongExitToken(token)) exitTokenDigests.push(digestToken(token));
    else ignored++;
  }
  if (ignored > 0) {
    warnings.push(
      `ignored ${ignored} TNP_EXIT_TOKENS entr${ignored === 1 ? 'y' : 'ies'}: tokens must be at least 43 random base64url characters`,
    );
  }
  if (exitTokenDigests.length === 0) {
    warnings.push('no valid TNP_EXIT_TOKENS: no exit can fetch its peers until one is set');
  }

  return {
    config: { exits, dns, exitTokenDigests, maxDevices: VPN_MAX_DEVICES_PER_USER },
    warnings,
  };
}

/** What a device needs besides its own key, as `/me/vpn` returns it. */
export function vpnNetwork(config: VpnConfig): VpnNetwork {
  return {
    exits: config.exits.map((exit) => ({ ...exit })),
    dns: [...config.dns],
    allowedIPs: [...VPN_ALLOWED_IPS],
    maxDevices: config.maxDevices,
  };
}

/**
 * Whether an `Authorization` header carries one of the configured exit tokens.
 *
 * Both sides are hashed first, so every comparison is of two 32-byte values
 * and `timingSafeEqual` sees equal lengths whatever was sent; every configured
 * digest is compared, with no early exit, so the time taken says nothing about
 * which token (if any) came close.
 */
export function exitTokenMatches(
  header: string | undefined,
  digests: readonly Uint8Array[],
  equal: (a: Uint8Array, b: Uint8Array) => boolean = timingSafeEqual,
): boolean {
  const match = /^Bearer ([\x21-\x7e]{1,512})$/.exec(header ?? '');
  const presented = digestToken(match ? match[1] : '');
  let matched = false;
  for (const digest of digests) {
    // Non-short-circuiting on purpose: `equal` runs for every digest.
    matched = equal(presented, digest) || matched;
  }
  return match !== null && matched;
}
