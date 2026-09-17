/**
 * Validation of a Namecheap provider account's non-secret configuration.
 *
 * Runs when an adapter is built, so a misconfigured account fails once, loudly,
 * with `ProviderError("credentials")` — not on the first customer's purchase.
 */

import { ProviderError } from "../errors.js";
import type { ProviderAccountConfig } from "../registry.js";

export interface NamecheapSettings {
  readonly apiUser: string;
  readonly userName: string;
  readonly clientIp: string;
}

/** Global parameter limits (https://www.namecheap.com/support/api/global-parameters/). */
const MAX_USER_LENGTH = 20;
const USER_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Ranges that can never be the public egress address Namecheap sees.
 *
 * `ClientIp` must be the address the call really leaves from (services.md §7).
 * A private, loopback, link-local or CGNAT address in config is always a
 * mistake — most often the task's own VPC address — and Namecheap would
 * reject every call with an authentication error that looks like a bad key.
 */
const NON_PUBLIC_V4: ReadonlyArray<readonly [number, number]> = [
  [ip(0, 0, 0, 0), 8], // "this network"
  [ip(10, 0, 0, 0), 8], // private
  [ip(100, 64, 0, 0), 10], // CGNAT (RFC 6598)
  [ip(127, 0, 0, 0), 8], // loopback
  [ip(169, 254, 0, 0), 16], // link-local
  [ip(172, 16, 0, 0), 12], // private
  [ip(192, 0, 0, 0), 24], // IETF protocol assignments
  [ip(192, 0, 2, 0), 24], // TEST-NET-1
  [ip(192, 88, 99, 0), 24], // 6to4 relay anycast (deprecated)
  [ip(192, 168, 0, 0), 16], // private
  [ip(198, 18, 0, 0), 15], // benchmarking
  [ip(198, 51, 100, 0), 24], // TEST-NET-2
  [ip(203, 0, 113, 0), 24], // TEST-NET-3
  [ip(224, 0, 0, 0), 4], // multicast
  [ip(240, 0, 0, 0), 4], // reserved, includes broadcast
];

function ip(a: number, b: number, c: number, d: number): number {
  return ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
}

/** Parse a strict dotted-quad IPv4 literal: no leading zeros, no shorthand. */
export function parseIPv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    // "010" is octal to some parsers and decimal to others; refuse the ambiguity.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    out = out * 256 + octet;
  }
  return out;
}

export function isPublicIPv4(value: string): boolean {
  const addr = parseIPv4(value);
  if (addr === null) return false;
  return !NON_PUBLIC_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((addr & mask) >>> 0) === base;
  });
}

function requireUser(config: Readonly<Record<string, unknown>>, key: "apiUser" | "userName"): string {
  const value = config[key];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_USER_LENGTH || !USER_RE.test(value)) {
    throw new ProviderError("credentials", `namecheap account config.${key} is missing or invalid`);
  }
  return value;
}

export function readNamecheapSettings(account: ProviderAccountConfig): NamecheapSettings {
  if (account.ref.adapter !== "namecheap") {
    throw new ProviderError("credentials", `account ${account.ref.id} is not a namecheap account`);
  }
  if (account.ref.environment !== "sandbox" && account.ref.environment !== "production") {
    throw new ProviderError("credentials", `account ${account.ref.id} has no valid environment`);
  }
  if (account.secretRef === null || account.secretRef.length === 0) {
    throw new ProviderError("credentials", `namecheap account ${account.ref.id} has no secretRef`);
  }
  const apiUser = requireUser(account.config, "apiUser");
  const userName = requireUser(account.config, "userName");
  const clientIp = account.config.clientIp;
  if (typeof clientIp !== "string" || !isPublicIPv4(clientIp)) {
    throw new ProviderError(
      "credentials",
      `namecheap account ${account.ref.id} config.clientIp must be the public IPv4 egress address`,
    );
  }
  return { apiUser, userName, clientIp };
}
