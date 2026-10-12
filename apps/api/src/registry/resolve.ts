/**
 * Native name resolution: what `/dns/resolve` answers and whether the API's
 * parking page serves a Host.
 *
 * Split in two on purpose. `loadNameFacts` asks the database everything the
 * answer depends on, in a fixed shape; `decideResolution` and
 * `decideParkingPage` are pure functions of those facts, a clock and two
 * settings. The semantics — CNAME at a name, NODATA against NXDOMAIN, when a
 * node counts, when parking is synthesized — are then testable one rule at a
 * time without a server, and the real-PostgreSQL tests only have to show the
 * loader asks the right questions. Normative description:
 * docs/architecture/resolution.md, "Registry answers".
 */

import { and, eq, like, or, sql } from 'drizzle-orm';
import {
  isNativeNameServed,
  isReservedTld,
  nativeExpiryState,
  normalizeName,
} from '@tnp/namespace';
import type { DomainKeyRotation, Grant, KeyAgreementCertificate } from '@tnp/crypto';
import type { DnsResolveAnswer, DnsResolveOverlay, DnsResolveResponse } from '@tnp/shared-types';
import { dnsRecords, domains, serviceNodes, tlds } from '../db/schema/index.js';
import type { Executor } from './db.js';
import { isServiceNodeOnline, type NodeLiveness } from './nodes.js';
import { escapeLikePattern } from '@oxy.so/utils/sql';

/** TTL of a synthesized parking answer: short, so registering a name takes effect quickly. */
export const PARKING_TTL_SECONDS = 300;

export interface ServiceNodeFacts extends NodeLiveness {
  /** The node key (Ed25519). */
  publicKey: string;
  connectedRelay: string;
  /** Grant chain rooted at the domain key; empty for a node registered before transport v1. */
  chain: Grant[];
  /** Current key-agreement certificate; null for a node registered before transport v1. */
  kaCert: KeyAgreementCertificate | null;
}

export type NameFacts =
  /** Not a name TNP answers for: a single label, a reserved TLD, or no active TLD row. */
  | { kind: 'not-native'; fqdn: string }
  | {
      kind: 'native';
      fqdn: string;
      /** The vestigial `tlds.custom` flag; every native TLD has it set. */
      tldCustom: boolean;
      /** Null when the second-level name is not registered. */
      domain: null | {
        expiresAt: Date | null;
        /** The name's domain key, or null if the owner never registered one. */
        domainKey: string | null;
        /** Rotation statements for the domain key, oldest first. */
        domainKeyRotations: DomainKeyRotation[];
        /** `@` for the registered name itself, otherwise the labels below it. */
        label: string;
        /** Every record stored at `label`, of every type. */
        records: { type: string; value: string; ttl: number }[];
        /** Whether any record exists strictly below `label` (an empty non-terminal). */
        hasDescendants: boolean;
        node: ServiceNodeFacts | null;
      };
    };

export interface ResolutionSettings {
  /** Empty when unset: parking answers are then never synthesized. */
  parkingIp: string;
  /** `TNP_NATIVE_EXPIRY_ENFORCED`. */
  expiryEnforced: boolean;
  now: Date;
}

/**
 * Gather what resolution depends on.
 *
 * Records at the label are fetched for every type, not only the queried one:
 * whether the name has a CNAME, or anything at all, decides the answer to a
 * query for a type it does not have. Records may be stored under the relative
 * label or, from before names were normalized, the full name; both match.
 */
export async function loadNameFacts(db: Executor, name: string): Promise<NameFacts> {
  const fqdn = normalizeName(name);
  const labels = fqdn.split('.');
  if (labels.length < 2 || labels.some((label) => label === '')) {
    return { kind: 'not-native', fqdn };
  }

  const tld = labels[labels.length - 1];
  // TNP never answers for a label the public DNS root delegates, whatever the
  // TLD table happens to contain (naming.md rule N1). Checked before the lookup
  // so a reserved row left by an earlier seed cannot produce an answer.
  if (isReservedTld(tld)) return { kind: 'not-native', fqdn };

  const [tldRow] = await db
    .select({ custom: tlds.custom })
    .from(tlds)
    .where(and(eq(tlds.name, tld), eq(tlds.status, 'active')))
    .limit(1);
  if (!tldRow) return { kind: 'not-native', fqdn };

  const domainName = labels[labels.length - 2];
  const [domain] = await db
    .select({
      id: domains.id,
      expiresAt: domains.expiresAt,
      domainKey: domains.domainKey,
      domainKeyRotations: domains.domainKeyRotations,
    })
    .from(domains)
    .where(and(eq(domains.name, domainName), eq(domains.tld, tld), eq(domains.status, 'active')))
    .limit(1);
  if (!domain) return { kind: 'native', fqdn, tldCustom: tldRow.custom, domain: null };

  const label = labels.length > 2 ? labels.slice(0, -2).join('.') : '@';

  const [records, [descendants], [node]] = await Promise.all([
    db
      .select({ type: dnsRecords.type, value: dnsRecords.value, ttl: dnsRecords.ttl })
      .from(dnsRecords)
      .where(
        and(
          eq(dnsRecords.domainId, domain.id),
          or(eq(dnsRecords.name, label), eq(dnsRecords.name, fqdn)),
        ),
      ),
    label === '@'
      ? Promise.resolve([{ present: false }])
      : db
          .select({ present: sql<boolean>`count(*) > 0` })
          .from(dnsRecords)
          .where(
            and(
              eq(dnsRecords.domainId, domain.id),
              or(
                like(dnsRecords.name, `%.${escapeLikePattern(label)}`),
                like(dnsRecords.name, `%.${escapeLikePattern(fqdn)}`),
              ),
            ),
          ),
    db
      .select({
        publicKey: serviceNodes.publicKey,
        connectedRelay: serviceNodes.connectedRelay,
        status: serviceNodes.status,
        lastSeen: serviceNodes.lastSeen,
        chain: serviceNodes.chain,
        kaCert: serviceNodes.kaCert,
      })
      .from(serviceNodes)
      .where(eq(serviceNodes.domainId, domain.id))
      .limit(1),
  ]);

  return {
    kind: 'native',
    fqdn,
    tldCustom: tldRow.custom,
    domain: {
      expiresAt: domain.expiresAt,
      domainKey: domain.domainKey,
      domainKeyRotations: domain.domainKeyRotations,
      label,
      records,
      hasDescendants: descendants?.present ?? false,
      node: node ?? null,
    },
  };
}

/**
 * The overlay block for an online node, or null when a client could not use
 * it: no domain key to root the chain at, no certificate, or a certificate
 * that has already expired. Nothing here is a trust decision — the client
 * verifies all of it independently — it only avoids routing clients at a
 * node whose key material is certain to be refused.
 */
function overlayFor(
  domain: { domainKey: string | null; domainKeyRotations: DomainKeyRotation[] },
  node: ServiceNodeFacts,
  now: Date,
): DnsResolveOverlay | null {
  if (!domain.domainKey || !node.kaCert || node.chain.length === 0) return null;
  if (node.kaCert.notAfter <= Math.floor(now.getTime() / 1000)) return null;
  return {
    relay: node.connectedRelay,
    available: true,
    domainKey: domain.domainKey,
    rotations: domain.domainKeyRotations,
    chain: node.chain,
    kaCert: node.kaCert,
  };
}

/** Whether a registered name is withheld because it expired and enforcement is on. */
function isHeld(expiresAt: Date | null, settings: ResolutionSettings): boolean {
  return settings.expiryEnforced && !isNativeNameServed(nativeExpiryState(expiresAt, settings.now));
}

/**
 * The `/dns/resolve` answer.
 *
 * - Not a native name → NXDOMAIN.
 * - Unregistered native name, or a registered one held after expiry → the
 *   parking address for A/ANY when `parkingIp` is set (the name is synthesized
 *   to exist, so other types are NODATA); NXDOMAIN when it is not.
 * - Registered name: records of the queried type. A name with a CNAME answers
 *   every other type with that CNAME, as DNS does — it never falls through to
 *   parking. No records of that type but other records, or an online service
 *   node → NODATA. Nothing at all at the label and no online node → parking for
 *   A/ANY if configured, otherwise NODATA for the registered name itself or an
 *   empty non-terminal, NXDOMAIN for any other label.
 * - The overlay block is attached only for a node whose heartbeat is fresh, on
 *   a name with a domain key, carrying a chain and an unexpired certificate.
 */
export function decideResolution(
  facts: NameFacts,
  qtype: string,
  settings: ResolutionSettings,
): DnsResolveResponse {
  const base = { name: facts.fqdn, type: qtype };
  const nxdomain: DnsResolveResponse = { ...base, answers: [], rcode: 'NXDOMAIN' };
  if (facts.kind === 'not-native') return nxdomain;

  const parking: DnsResolveAnswer[] =
    settings.parkingIp && (qtype === 'A' || qtype === 'ANY')
      ? [{ name: facts.fqdn, type: 'A', value: settings.parkingIp, ttl: PARKING_TTL_SECONDS }]
      : [];

  const { domain } = facts;
  if (!domain || isHeld(domain.expiresAt, settings)) {
    if (!facts.tldCustom || !settings.parkingIp) return nxdomain;
    return { ...base, answers: parking, rcode: 'NOERROR' };
  }

  const nodeOnline = isServiceNodeOnline(domain.node, settings.now);
  // Answers keep treating an online node as online (no parking) whatever its
  // key material; only the overlay block is withheld when a client could not
  // verify it.
  const overlayBlock =
    nodeOnline && domain.node ? overlayFor(domain, domain.node, settings.now) : null;
  const overlay = overlayBlock ? { overlay: overlayBlock } : {};

  let matching =
    qtype === 'ANY' ? domain.records : domain.records.filter((record) => record.type === qtype);
  if (matching.length === 0 && qtype !== 'CNAME') {
    matching = domain.records.filter((record) => record.type === 'CNAME');
  }

  if (matching.length > 0) {
    return {
      ...base,
      answers: matching.map((record) => ({
        name: facts.fqdn,
        type: record.type,
        value: record.value,
        ttl: record.ttl,
      })),
      rcode: 'NOERROR',
      ...overlay,
    };
  }

  if (domain.records.length === 0 && !nodeOnline) {
    if (settings.parkingIp) return { ...base, answers: parking, rcode: 'NOERROR' };
    const exists = domain.label === '@' || domain.hasDescendants;
    return exists ? { ...base, answers: [], rcode: 'NOERROR' } : nxdomain;
  }

  return { ...base, answers: [], rcode: 'NOERROR', ...overlay };
}

export type ParkingPage = 'available' | 'registered' | 'held';

/**
 * Which page the API serves for a Host, or null to pass the request on.
 *
 * Uses the same facts and the same node and expiry rules as
 * `decideResolution`, so every name resolution points at the parking address
 * lands on a page rather than a 404 — including a registered name whose node
 * has gone quiet, which used to be passed on because a node row existed. Only
 * a name an online node serves through the overlay is passed on. A name held
 * after expiry gets its own page — never "available", because it is not.
 */
export function decideParkingPage(
  facts: NameFacts,
  settings: ResolutionSettings,
): ParkingPage | null {
  if (facts.kind === 'not-native') return null;
  const { domain } = facts;
  if (!domain) return facts.tldCustom ? 'available' : null;
  if (isHeld(domain.expiresAt, settings)) return 'held';
  if (isServiceNodeOnline(domain.node, settings.now)) return null;
  return 'registered';
}
