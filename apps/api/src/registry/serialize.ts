/**
 * Row → wire DTO for the native registry.
 *
 * Every public read goes through `toPublicDomain`, which is built field by
 * field rather than by spreading the row: a column added to `domains` later
 * (an owner key, a contact) must be a decision to publish, not an accident of
 * `...row`. The owner DTO is the public one plus what only the owner needs.
 */

import { nativeExpiryState } from "@tnp/namespace";
import type {
  DnsRecordDto,
  OwnedDomain,
  OwnedDomainSummary,
  OwnedDomainWithRecords,
  PublicDomain,
  PublicDomainWithRecords,
} from "@tnp/shared-types";
import type { dnsRecords, domains } from "../db/schema/index.js";

type DomainRow = typeof domains.$inferSelect;
type DnsRecordRow = typeof dnsRecords.$inferSelect;

export function serializeDnsRecord(record: DnsRecordRow): DnsRecordDto {
  return {
    _id: record.id,
    type: record.type,
    name: record.name,
    value: record.value,
    ttl: record.ttl,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function toPublicDomain(domain: DomainRow): PublicDomain {
  return {
    _id: domain.id,
    name: domain.name,
    tld: domain.tld,
    status: domain.status,
    createdAt: domain.createdAt.toISOString(),
    updatedAt: domain.updatedAt.toISOString(),
    expiresAt: domain.expiresAt ? domain.expiresAt.toISOString() : null,
  };
}

/** Records are filtered by domain here so a caller batching several domains' records cannot mix them. */
function recordsOf(domain: DomainRow, records: DnsRecordRow[]): DnsRecordDto[] {
  return records.filter((record) => record.domainId === domain.id).map(serializeDnsRecord);
}

export function toPublicDomainWithRecords(
  domain: DomainRow,
  records: DnsRecordRow[],
): PublicDomainWithRecords {
  return { ...toPublicDomain(domain), records: recordsOf(domain, records) };
}

export function toOwnedDomain(domain: DomainRow, now: Date): OwnedDomain {
  return { ...toPublicDomain(domain), expiryState: nativeExpiryState(domain.expiresAt, now) };
}

export function toOwnedDomainSummary(
  domain: DomainRow,
  recordCount: number,
  now: Date,
): OwnedDomainSummary {
  return { ...toOwnedDomain(domain, now), recordCount };
}

export function toOwnedDomainWithRecords(
  domain: DomainRow,
  records: DnsRecordRow[],
  now: Date,
): OwnedDomainWithRecords {
  return { ...toOwnedDomain(domain, now), records: recordsOf(domain, records) };
}
