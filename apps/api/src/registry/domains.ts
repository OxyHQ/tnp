/**
 * Native domain reads and lifecycle writes that need more than one statement
 * or a precise predicate: availability, renewal and the owner's inventory.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import {
  isNativeRenewalAllowed,
  isReservedTld,
  nativeExpiryState,
  nextNativeExpiry,
  parseNativeDomainName,
  type NativeExpiryState,
} from "@tnp/namespace";
import type { NativeAvailability } from "@tnp/shared-types";
import { domains, tlds } from "../db/schema/index.js";
import type { Executor } from "./db.js";

type DomainRow = typeof domains.$inferSelect;

/**
 * The part of an availability check that needs no database: whether `input` is
 * a registrable native name at all. A refusal is already the whole answer.
 */
export function parseAvailabilityQuery(
  input: string,
): { ok: true; name: string; tld: string } | { ok: false; answer: NativeAvailability } {
  const parsed = parseNativeDomainName(input);
  if (parsed.ok) return parsed;
  return {
    ok: false,
    answer: {
      domain: input.trim().toLowerCase(),
      available: false,
      reason: parsed.reason === "reserved" ? "reserved" : "invalid",
      detail: parsed.detail,
      namespace: "tnp-native",
    },
  };
}

/**
 * Whether a parsed native name could be registered right now.
 *
 * Applies the same policy registration does, in the order registration does:
 * name syntax and reserved TLDs first (`parseAvailabilityQuery`), then the TLD
 * table, then the registry. An expired registration is still a row, held for
 * its owner, so it is `registered` whether or not expiry is enforced — the
 * policy never releases a name by letting it lapse.
 */
export async function checkNativeAvailability(
  db: Executor,
  parsed: { name: string; tld: string },
): Promise<NativeAvailability> {
  const domain = `${parsed.name}.${parsed.tld}`;

  const [tldRow] = await db
    .select({ id: tlds.id })
    .from(tlds)
    .where(and(eq(tlds.name, parsed.tld), eq(tlds.status, "active")))
    .limit(1);
  if (!tldRow) {
    return {
      domain,
      available: false,
      reason: "tld_not_available",
      detail: `TLD .${parsed.tld} is not available`,
      namespace: "tnp-native",
    };
  }

  const [existing] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.name, parsed.name), eq(domains.tld, parsed.tld)))
    .limit(1);

  return existing
    ? { domain, available: false, reason: "registered", namespace: "tnp-native" }
    : { domain, available: true, namespace: "tnp-native" };
}

export type RenewalOutcome =
  | { ok: true; domain: DomainRow }
  | {
      ok: false;
      status: 403 | 404 | 409;
      code: "not_found" | "forbidden" | "not_native" | "no_expiry" | "not_renewable" | "conflict";
      error: string;
      expiryState?: NativeExpiryState;
    };

/**
 * Renew a native registration for its owner. Free; one term per call.
 *
 * The UPDATE is a compare-and-set on the expiry this call read. Two renewals
 * racing each read the same expiry, compute the same new one, and only the
 * first UPDATE still matches its predicate — the second reports a conflict
 * instead of a second success. Without the predicate the second would still
 * write the same value, so the name would not be extended twice, but the owner
 * would be told it had been.
 *
 * The comparison truncates to milliseconds because that is all a JavaScript
 * `Date` read back from the row can carry; a microsecond-precision value set
 * by SQL would otherwise never compare equal and could never be renewed.
 */
export async function renewNativeDomain(
  db: Executor,
  params: { domainId: string; oxyUserId: string; now: Date },
): Promise<RenewalOutcome> {
  const { domainId, oxyUserId, now } = params;

  const [row] = await db
    .select({ oxyUserId: domains.oxyUserId, tld: domains.tld, expiresAt: domains.expiresAt })
    .from(domains)
    .where(eq(domains.id, domainId))
    .limit(1);

  if (!row) return { ok: false, status: 404, code: "not_found", error: "Domain not found" };
  if (row.oxyUserId !== oxyUserId) {
    return { ok: false, status: 403, code: "forbidden", error: "You do not own this domain" };
  }
  // A registration under a reserved TLD predates the namespace policy. Its
  // path out is the migration in naming.md §6, not another year.
  if (isReservedTld(row.tld)) {
    return {
      ok: false,
      status: 409,
      code: "not_native",
      error: `.${row.tld} is not a TNP-native TLD; this registration cannot be renewed`,
    };
  }
  if (row.expiresAt === null) {
    return { ok: false, status: 409, code: "no_expiry", error: "This domain does not expire" };
  }

  const state = nativeExpiryState(row.expiresAt, now);
  if (!isNativeRenewalAllowed(state)) {
    return {
      ok: false,
      status: 409,
      code: "not_renewable",
      error: "This domain can be renewed from 90 days before it expires",
      expiryState: state,
    };
  }

  const [renewed] = await db
    .update(domains)
    .set({ expiresAt: nextNativeExpiry(row.expiresAt, now), updatedAt: now })
    .where(
      and(
        eq(domains.id, domainId),
        eq(domains.oxyUserId, oxyUserId),
        sql`date_trunc('milliseconds', ${domains.expiresAt}) = ${row.expiresAt.toISOString()}::timestamptz`,
      ),
    )
    .returning();

  if (!renewed) {
    return {
      ok: false,
      status: 409,
      code: "conflict",
      error: "This domain was changed while renewing; reload and try again",
    };
  }
  return { ok: true, domain: renewed };
}

/** One page of the owner's domains, each with its record count and no records. */
export async function listOwnedDomains(
  db: Executor,
  params: { oxyUserId: string; page: number; limit: number },
): Promise<{ rows: { domain: DomainRow; recordCount: number }[]; total: number }> {
  const { oxyUserId, page, limit } = params;

  // Literal SQL with both sides qualified, not drizzle column objects: in a
  // single-table select drizzle renders those unqualified, and inside the
  // subquery an unqualified `id` is the RECORD's id — every count reads 0 with
  // no error (see registry/tlds.ts, where that shipped).
  const recordCount = sql<number>`(
    select count(*) from dns_records r where r.domain_id = domains.id
  )::int`;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({ domain: domains, recordCount })
      .from(domains)
      .where(eq(domains.oxyUserId, oxyUserId))
      .orderBy(desc(domains.createdAt), desc(domains.id))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(domains)
      .where(eq(domains.oxyUserId, oxyUserId)),
  ]);

  return { rows, total };
}
