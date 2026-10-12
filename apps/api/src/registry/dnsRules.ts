/**
 * Storage of a user's encrypted personal DNS rules.
 *
 * The API is a mailbox for one opaque envelope per Oxy account. It validates
 * the envelope's shape (`@tnp/shared-types`) and enforces exactly one thing
 * about its content: `version` moves forward by one per write. That is
 * optimistic concurrency — two devices saving at once cannot silently
 * overwrite each other — and it is a compare-and-set in SQL, not a read
 * followed by a write.
 *
 * Rollback protection does NOT rest on the server: a compelled server can
 * serve any old envelope it kept. The version is authenticated inside the
 * ciphertext, and the client refuses a version lower than one it has seen
 * (`@tnp/crypto/dns-rules`, `packages/client/src/dns-rules-store.ts`).
 */

import { and, eq, sql } from 'drizzle-orm';
import type { DnsRulesRecord, PutDnsRulesRequest } from '@tnp/shared-types';
import { dnsRuleSets } from '../db/schema/index.js';
import type { Executor } from './db.js';

type Row = typeof dnsRuleSets.$inferSelect;

function toRecord(row: Row): DnsRulesRecord {
  return {
    v: 1,
    kdfParams: row.kdfParams,
    salt: row.salt,
    wrappedKey: row.wrappedKey,
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    version: row.version,
    userId: row.oxyUserId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getDnsRuleSet(
  db: Executor,
  oxyUserId: string,
): Promise<DnsRulesRecord | null> {
  const [row] = await db.select().from(dnsRuleSets).where(eq(dnsRuleSets.oxyUserId, oxyUserId));
  return row ? toRecord(row) : null;
}

export type PutDnsRuleSetResult =
  | { ok: true; record: DnsRulesRecord }
  | { ok: false; currentVersion: number };

/**
 * Store `envelope` if its version is exactly the stored version plus one, or
 * 1 when nothing is stored. Otherwise nothing changes and the current version
 * is returned (0 when there is none).
 */
export async function putDnsRuleSet(
  db: Executor,
  oxyUserId: string,
  envelope: PutDnsRulesRequest,
): Promise<PutDnsRuleSetResult> {
  const values = {
    envelopeVersion: envelope.v,
    kdfParams: envelope.kdfParams,
    salt: envelope.salt,
    wrappedKey: envelope.wrappedKey,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    version: envelope.version,
  };

  const [row] =
    envelope.version === 1
      ? await db
          .insert(dnsRuleSets)
          .values({ oxyUserId, ...values })
          .onConflictDoNothing({ target: dnsRuleSets.oxyUserId })
          .returning()
      : await db
          .update(dnsRuleSets)
          .set({ ...values, updatedAt: sql`now()` })
          .where(
            and(
              eq(dnsRuleSets.oxyUserId, oxyUserId),
              eq(dnsRuleSets.version, envelope.version - 1),
            ),
          )
          .returning();

  if (row) return { ok: true, record: toRecord(row) };

  const [current] = await db
    .select({ version: dnsRuleSets.version })
    .from(dnsRuleSets)
    .where(eq(dnsRuleSets.oxyUserId, oxyUserId));
  return { ok: false, currentVersion: current?.version ?? 0 };
}

/** Delete the caller's envelope. Returns whether there was one. */
export async function deleteDnsRuleSet(db: Executor, oxyUserId: string): Promise<boolean> {
  const deleted = await db
    .delete(dnsRuleSets)
    .where(eq(dnsRuleSets.oxyUserId, oxyUserId))
    .returning({ oxyUserId: dnsRuleSets.oxyUserId });
  return deleted.length > 0;
}
