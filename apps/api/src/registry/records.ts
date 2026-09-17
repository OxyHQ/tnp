/**
 * DNS record mutations under a native domain.
 *
 * The rules that span records — a CNAME stands alone at its name, no exact
 * duplicates, a per-domain cap — are checks over the domain's other records, so
 * a check followed by a write is only correct if nobody else writes in between.
 * Each mutation therefore runs in a transaction that first takes
 * `SELECT … FOR UPDATE` on the domain row: every writer for the same domain
 * queues on that one lock, and each check reads the records its predecessor
 * committed. A transaction alone would not do it — under READ COMMITTED two
 * concurrent inserts each miss the other's row.
 */

import { and, eq } from "drizzle-orm";
import {
  mergeDnsRecordUpdate,
  MAX_DNS_RECORDS_PER_DOMAIN,
  type DnsRecordErrorCode,
  type DnsRecordField,
  type DnsRecordInput,
  type UpdateDnsRecordRequest,
} from "@tnp/shared-types";
import type { Database } from "../db/postgres.js";
import { dnsRecords, domains } from "../db/schema/index.js";
import type { Executor } from "./db.js";

type DnsRecordRow = typeof dnsRecords.$inferSelect;

export type RecordConflictCode = "cname_conflict" | "duplicate" | "record_limit";

export type RecordMutationFailure =
  | { ok: false; status: 404; code: "domain_not_found" | "record_not_found"; error: string }
  | { ok: false; status: 409; code: RecordConflictCode; error: string }
  | { ok: false; status: 400; code: DnsRecordErrorCode; field: DnsRecordField; error: string };

export type RecordMutationResult<T> = { ok: true; value: T } | RecordMutationFailure;

/** The fields the conflict rules read. */
export interface ExistingRecord {
  id: string;
  type: string;
  name: string;
  value: string;
}

/**
 * Whether `candidate` may sit beside `existing`. Pure; `ignoreId` is the
 * record being updated, which must not conflict with its own previous self.
 *
 * - A CNAME says "this name is that other name", so nothing else may share its
 *   name (RFC 1034 §3.6.2) — neither another CNAME nor any other type.
 * - An exact duplicate (type, name and value) is refused rather than stored
 *   twice and answered twice.
 */
export function findRecordConflict(
  existing: readonly ExistingRecord[],
  candidate: Pick<DnsRecordInput, "type" | "name" | "value">,
  ignoreId: string | null,
): { code: "cname_conflict" | "duplicate"; error: string } | null {
  const sameName = existing.filter(
    (record) => record.id !== ignoreId && record.name === candidate.name,
  );

  if (
    sameName.some((record) => record.type === candidate.type && record.value === candidate.value)
  ) {
    return {
      code: "duplicate",
      error: `An identical ${candidate.type} record already exists at ${candidate.name}`,
    };
  }
  if (candidate.type === "CNAME" && sameName.length > 0) {
    return {
      code: "cname_conflict",
      error: `A CNAME cannot share its name with other records, and ${candidate.name} already has one`,
    };
  }
  if (candidate.type !== "CNAME" && sameName.some((record) => record.type === "CNAME")) {
    return {
      code: "cname_conflict",
      error: `${candidate.name} has a CNAME record, which cannot share its name with other records`,
    };
  }
  return null;
}

/**
 * Make a record name relative to its domain.
 *
 * Records were once stored with fully-qualified names, and a person typing
 * `www.example.ox` into the name field means `www`. Stored relative, the name
 * matches what the resolver looks up.
 */
export function relativeRecordName(name: string, fqdn: string): string {
  if (name === fqdn) return "@";
  const suffix = `.${fqdn}`;
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

/** Existing records with names in the same relative, lowercase form as a validated candidate. */
function comparable(records: readonly ExistingRecord[], fqdn: string): ExistingRecord[] {
  return records.map((record) => ({
    id: record.id,
    type: record.type,
    name: relativeRecordName(record.name.toLowerCase(), fqdn),
    value: record.value,
  }));
}

async function lockDomain(tx: Executor, domainId: string) {
  const [domain] = await tx
    .select({ id: domains.id, name: domains.name, tld: domains.tld })
    .from(domains)
    .where(eq(domains.id, domainId))
    .for("update");
  return domain ?? null;
}

const DOMAIN_NOT_FOUND: RecordMutationFailure = {
  ok: false,
  status: 404,
  code: "domain_not_found",
  error: "Domain not found",
};

const RECORD_NOT_FOUND: RecordMutationFailure = {
  ok: false,
  status: 404,
  code: "record_not_found",
  error: "Record not found",
};

export async function createDnsRecord(
  db: Database,
  domainId: string,
  input: DnsRecordInput,
): Promise<RecordMutationResult<DnsRecordRow>> {
  return db.transaction(async (tx) => {
    const domain = await lockDomain(tx, domainId);
    if (!domain) return DOMAIN_NOT_FOUND;

    const fqdn = `${domain.name}.${domain.tld}`;
    const record = { ...input, name: relativeRecordName(input.name, fqdn) };

    const existing = await tx
      .select({ id: dnsRecords.id, type: dnsRecords.type, name: dnsRecords.name, value: dnsRecords.value })
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain.id));

    const conflict = findRecordConflict(comparable(existing, fqdn), record, null);
    if (conflict) return { ok: false, status: 409, ...conflict };

    if (existing.length >= MAX_DNS_RECORDS_PER_DOMAIN) {
      return {
        ok: false,
        status: 409,
        code: "record_limit",
        error: `A domain can hold at most ${MAX_DNS_RECORDS_PER_DOMAIN} records`,
      };
    }

    // domainId comes from the locked row, never from a request body.
    const [inserted] = await tx
      .insert(dnsRecords)
      .values({ domainId: domain.id, ...record })
      .returning();
    return { ok: true, value: inserted };
  });
}

export async function updateDnsRecord(
  db: Database,
  domainId: string,
  recordId: string,
  patch: UpdateDnsRecordRequest,
): Promise<RecordMutationResult<DnsRecordRow>> {
  return db.transaction(async (tx) => {
    const domain = await lockDomain(tx, domainId);
    if (!domain) return DOMAIN_NOT_FOUND;

    const existing = await tx
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain.id));

    // Looked up among this domain's records only: a record id belonging to
    // another domain is not found, not editable through an owned one.
    const current = existing.find((record) => record.id === recordId);
    if (!current) return RECORD_NOT_FOUND;

    // The record that would result is what gets validated, not the patch.
    const merged = mergeDnsRecordUpdate(current, patch);
    if (!merged.ok) {
      return { ok: false, status: 400, code: merged.code, field: merged.field, error: merged.error };
    }
    const fqdn = `${domain.name}.${domain.tld}`;
    const record = { ...merged.value, name: relativeRecordName(merged.value.name, fqdn) };

    const conflict = findRecordConflict(comparable(existing, fqdn), record, current.id);
    if (conflict) return { ok: false, status: 409, ...conflict };

    const [updated] = await tx
      .update(dnsRecords)
      .set({ ...record, updatedAt: new Date() })
      .where(and(eq(dnsRecords.id, current.id), eq(dnsRecords.domainId, domain.id)))
      .returning();
    return { ok: true, value: updated };
  });
}

export async function deleteDnsRecord(
  db: Database,
  domainId: string,
  recordId: string,
): Promise<RecordMutationResult<null>> {
  // Deleting cannot break a cross-record rule, but it takes the same lock so
  // every record mutation for one domain runs in one order, with no exception
  // to reason about.
  return db.transaction(async (tx) => {
    const domain = await lockDomain(tx, domainId);
    if (!domain) return DOMAIN_NOT_FOUND;

    const deleted = await tx
      .delete(dnsRecords)
      .where(and(eq(dnsRecords.id, recordId), eq(dnsRecords.domainId, domain.id)))
      .returning({ id: dnsRecords.id });
    return deleted.length === 0 ? RECORD_NOT_FOUND : { ok: true, value: null };
  });
}
