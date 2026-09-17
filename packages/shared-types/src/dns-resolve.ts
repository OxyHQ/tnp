/**
 * `GET /dns/resolve` response — the contract between the registry and every
 * resolver (`packages/client`'s DNS proxy, which `apps/dns-server` also runs).
 *
 * Grown only by addition: resolvers already in the field parse this, and a
 * removed or retyped field is an outage on machines nobody can upgrade from
 * here.
 */

export interface DnsResolveAnswer {
  name: string;
  type: string;
  value: string;
  ttl: number;
}

export interface DnsResolveOverlay {
  serviceNodePubKey: string;
  relay: string;
  available: boolean;
}

/**
 * - `NOERROR` — the name exists. `answers` may still be empty: that is NODATA,
 *   "no records of this type", and must not be cached as a missing name.
 * - `NXDOMAIN` — TNP knows no such name.
 */
export type DnsResolveRcode = "NOERROR" | "NXDOMAIN";

export interface DnsResolveResponse {
  name: string;
  type: string;
  answers: DnsResolveAnswer[];
  overlay?: DnsResolveOverlay;
  /**
   * Always sent by the current API. Optional in the type because an API image
   * older than the field omits it, and a resolver must then fall back to
   * reading empty `answers` as NXDOMAIN, as it always has.
   */
  rcode?: DnsResolveRcode;
}
