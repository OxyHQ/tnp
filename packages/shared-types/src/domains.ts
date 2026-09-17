/**
 * Response contracts for the native registry's `/domains` and `/tlds` reads.
 *
 * Two audiences, two types. A public DTO goes to anyone who asks — the
 * directory, search, lookup, the proposals list — and carries nothing that
 * identifies an owner: no Oxy user id, no local user id. The owner DTO goes
 * only to the authenticated owner and adds what they need to manage the name.
 * Before these existed one serializer served both and the public directory
 * published every owner's Oxy id (issue #62, finding A2).
 *
 * Timestamps are ISO 8601 strings, serialized by the API rather than left to
 * `JSON.stringify` of a `Date`, so the type describes the bytes on the wire.
 */

import type { DnsRecordDto } from "./dns-records.js";

export type DomainStatus = "active" | "pending" | "suspended";

/**
 * Lifecycle state of a native registration, as `@tnp/namespace` computes it.
 * Repeated here as a wire type; the API assigns the policy's value to it, so a
 * state added there without being added here fails to compile.
 */
export type NativeExpiryStateDto = "active" | "renewable" | "grace" | "expired";

/** A native domain as anyone may see it. */
export interface PublicDomain {
  _id: string;
  name: string;
  tld: string;
  status: DomainStatus;
  createdAt: string;
  updatedAt: string;
  /** Null for a registration without an expiry. */
  expiresAt: string | null;
}

/** `GET /domains/lookup/:domain`. */
export interface PublicDomainWithRecords extends PublicDomain {
  records: DnsRecordDto[];
}

/** `GET /domains`. */
export interface PublicDomainPage {
  domains: PublicDomain[];
  total: number;
  page: number;
  pages: number;
}

/** A native domain as its owner sees it. */
export interface OwnedDomain extends PublicDomain {
  expiryState: NativeExpiryStateDto;
}

/** `GET /domains/owned` entry: a count, not the records, so the list stays cheap. */
export interface OwnedDomainSummary extends OwnedDomain {
  recordCount: number;
}

/** `GET /domains/owned`. */
export interface OwnedDomainPage {
  domains: OwnedDomainSummary[];
  total: number;
  page: number;
  pages: number;
}

/** `GET /domains/mine` entry and `POST /domains/register` response. */
export interface OwnedDomainWithRecords extends OwnedDomain {
  records: DnsRecordDto[];
}

/**
 * Why a native name cannot be registered.
 *
 * - `registered` — someone holds it, including an expired name held for its owner.
 * - `reserved` — the TLD belongs to the public DNS root or the IETF.
 * - `tld_not_available` — a syntactically fine TLD TNP does not operate.
 * - `invalid` — not a registrable `name.tld`, including subdomains.
 */
export type NativeAvailabilityReason = "registered" | "reserved" | "tld_not_available" | "invalid";

/**
 * `GET /domains/check/:domain` and `GET /domains/check/:name/:tld`.
 *
 * Native availability only. Whether a public name can be bought is a question
 * for the services layer and a provider, and is never answered here.
 */
export interface NativeAvailability {
  domain: string;
  available: boolean;
  /** Present exactly when `available` is false. */
  reason?: NativeAvailabilityReason;
  /** Human-readable explanation for `invalid` and `reserved`. */
  detail?: string;
  namespace: "tnp-native";
}

/** `GET /tlds/proposals` entry. */
export interface TldProposalEntry {
  _id: string;
  tld: string;
  reason: string;
  status: "open" | "approved" | "rejected";
  createdAt: string;
  score: number;
  userVote: "up" | "down" | null;
  /**
   * Whether the caller proposed it — computed by the server so the list never
   * has to publish who did.
   */
  proposedByMe: boolean;
}

/** `GET /tlds` entry. */
export interface PublicTld {
  _id: string;
  name: string;
  status: "active" | "proposed" | "pending";
  custom: boolean;
  createdAt: string;
}

/** `POST /domains/:id/renew` response. */
export type RenewDomainResponse = OwnedDomain;
