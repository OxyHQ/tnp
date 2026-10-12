/**
 * The registry's copy of each native name's DOMAIN KEY.
 *
 * Normative spec: docs/architecture/security.md §1 ("Domain keys and pinning").
 *
 * The domain key is generated on the owner's device and is the root of every
 * grant chain for the name; there is no Oxy root above it. The registry
 * PUBLISHES it — clients pin the first key they see per name and relays check
 * service nodes against it — but it is not the authority for it. What this
 * file guarantees, and only this:
 *
 *  - The first key for a name that never had one is set by its owner
 *    (Oxy-authenticated).
 *  - While a name is registered, a different key is accepted ONLY with a
 *    rotation statement signed by the current key. The owner's Oxy account
 *    alone cannot replace it.
 *  - Releasing a name does not forget its key: the key and its history are
 *    kept in `domain_key_tombstones`, never deleted. When the name is
 *    registered again (by anyone), its first key must be the released key, or
 *    come with a rotation signed by it. Otherwise a new key is accepted only
 *    after the RESET HOLD (default 30 days after the release), and it is
 *    published with `keyReset` — the previous key's fingerprint and when —
 *    so clients that pinned the old key keep refusing with a clear message and
 *    new clients can see the name's key is not its original.
 *
 * So an Oxy session (or whoever compels one) can replace a name's key only by
 * releasing it and waiting out the hold, visibly. Whoever writes the database
 * directly can do anything; client-side pinning is the defence, and first
 * contact still trusts the registry until a key-transparency log exists
 * (threat-model.md).
 */

import {
  bytesEqual,
  type DomainKeyRotation,
  domainKeyFingerprint,
  MAX_DOMAIN_KEY_ROTATIONS,
  parsePublicKey,
  verifyDomainKeyRotation,
} from '@tnp/crypto';
import { isNativeNameServed, isReservedTld, nativeExpiryState } from '@tnp/namespace';
import {
  type DomainKeyRecord,
  isCanonicalName,
  type RegisterDomainKeyRequest,
} from '@tnp/shared-types';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { domainKeyTombstones, domains, serviceNodes, tlds } from '../db/schema/index.js';
import type { Executor } from './db.js';

/** How far in the future a rotation's `issuedAt` may be, to absorb clock skew. */
export const MAX_ROTATION_SKEW_SECONDS = 300;

/** Default reset hold: how long after a release a re-registered name may take an unrelated key. */
export const DEFAULT_RESET_HOLD_SECONDS = 30 * 86_400;

/** `label.tld` under a TLD TNP may serve, or null. */
export function splitNativeName(name: string): { label: string; tld: string } | null {
  if (!isCanonicalName(name)) return null;
  const parts = name.split('.');
  if (parts.length !== 2) return null;
  const [label, tld] = parts;
  if (isReservedTld(tld)) return null;
  return { label, tld };
}

/** The 32 key bytes of canonical base64, or null. */
export function canonicalKey(value: string): Uint8Array | null {
  try {
    return parsePublicKey(value);
  } catch {
    return null;
  }
}

export interface LookupSettings {
  /** `TNP_NATIVE_EXPIRY_ENFORCED`: a name withheld after expiry publishes no key either. */
  expiryEnforced: boolean;
  now: Date;
}

function keyResetOf(row: { domainKeyResetFrom: string | null; domainKeyResetAt: Date | null }) {
  return row.domainKeyResetFrom && row.domainKeyResetAt
    ? {
        keyReset: {
          previousKeyFingerprint: row.domainKeyResetFrom,
          since: row.domainKeyResetAt.toISOString(),
        },
      }
    : {};
}

/**
 * The published record for an active name under an active TLD, or null —
 * including for a name withheld after expiry, by the same rule `/dns/resolve`
 * applies, so relays and clients see the same thing from both.
 */
export async function lookupDomainKey(
  db: Executor,
  name: string,
  settings: LookupSettings = { expiryEnforced: false, now: new Date() },
): Promise<DomainKeyRecord | null> {
  const parts = splitNativeName(name);
  if (!parts) return null;
  const [row] = await db
    .select({
      domainKey: domains.domainKey,
      rotations: domains.domainKeyRotations,
      expiresAt: domains.expiresAt,
      domainKeyResetFrom: domains.domainKeyResetFrom,
      domainKeyResetAt: domains.domainKeyResetAt,
    })
    .from(domains)
    .innerJoin(tlds, and(eq(tlds.name, domains.tld), eq(tlds.status, 'active')))
    .where(
      and(eq(domains.name, parts.label), eq(domains.tld, parts.tld), eq(domains.status, 'active')),
    )
    .limit(1);
  if (!row?.domainKey) return null;
  if (
    settings.expiryEnforced &&
    !isNativeNameServed(nativeExpiryState(row.expiresAt, settings.now))
  ) {
    return null;
  }
  return { name, domainKey: row.domainKey, rotations: row.rotations, ...keyResetOf(row) };
}

/**
 * Keep a released name's key. Called inside the release transaction, before
 * the `domains` row is deleted. A name released twice keeps the newer key.
 */
export async function tombstoneDomainKey(tx: Executor, domainId: string): Promise<void> {
  const [row] = await tx
    .select({
      name: domains.name,
      tld: domains.tld,
      domainKey: domains.domainKey,
      rotations: domains.domainKeyRotations,
    })
    .from(domains)
    .where(eq(domains.id, domainId))
    .for('update')
    .limit(1);
  if (!row?.domainKey) return;
  await tx
    .insert(domainKeyTombstones)
    .values({
      name: row.name,
      tld: row.tld,
      domainKey: row.domainKey,
      rotations: row.rotations,
    })
    .onConflictDoUpdate({
      target: [domainKeyTombstones.name, domainKeyTombstones.tld],
      set: { domainKey: row.domainKey, rotations: row.rotations, releasedAt: sql`now()` },
    });
}

export type RegisterDomainKeyResult =
  | { status: 200 | 201; record: DomainKeyRecord }
  | { status: 400 | 403 | 404 | 409; error: string };

const REQUIRES_ROTATION =
  'A different domain key requires a rotation statement signed by the current key';

type RotationCheck = { ok: true } | { ok: false; error: string };

function checkRotation(
  rotation: DomainKeyRotation,
  name: string,
  previous: Uint8Array,
  next: Uint8Array,
  history: DomainKeyRotation[],
  now: number,
): RotationCheck {
  const verified = verifyDomainKeyRotation(rotation, name);
  if (
    !verified.ok ||
    !bytesEqual(verified.previousKey, previous) ||
    !bytesEqual(verified.nextKey, next)
  ) {
    return { ok: false, error: REQUIRES_ROTATION };
  }
  const last = history[history.length - 1];
  if (
    (last && verified.issuedAt <= last.issuedAt) ||
    verified.issuedAt > now + MAX_ROTATION_SKEW_SECONDS
  ) {
    return {
      ok: false,
      error: 'Rotation issuedAt must be later than the previous rotation and not in the future',
    };
  }
  return { ok: true };
}

/**
 * Register a name's first domain key, or rotate it with a statement signed by
 * the current one. Runs in one transaction with the domain row locked, so it
 * serializes against node registration (which checks the key it verified
 * against is still current) and against a concurrent rotation.
 */
export async function registerDomainKey(
  db: Executor,
  params: {
    userId: string;
    request: RegisterDomainKeyRequest;
    now: number;
    resetHoldSeconds?: number;
  },
): Promise<RegisterDomainKeyResult> {
  const { name, domainKey, rotation } = params.request;
  const parts = splitNativeName(name);
  if (!parts) {
    return { status: 400, error: 'name must be a registered name of the form label.tld' };
  }
  const nextKey = canonicalKey(domainKey);
  if (!nextKey) return { status: 400, error: 'domainKey must be canonical base64 of 32 bytes' };
  const hold = params.resetHoldSeconds ?? DEFAULT_RESET_HOLD_SECONDS;

  return db.transaction(async (tx) => {
    const [domain] = await tx
      .select({
        id: domains.id,
        oxyUserId: domains.oxyUserId,
        domainKey: domains.domainKey,
        rotations: domains.domainKeyRotations,
        domainKeyResetFrom: domains.domainKeyResetFrom,
        domainKeyResetAt: domains.domainKeyResetAt,
      })
      .from(domains)
      .where(
        and(
          eq(domains.name, parts.label),
          eq(domains.tld, parts.tld),
          eq(domains.status, 'active'),
        ),
      )
      .for('update')
      .limit(1);

    if (!domain) return { status: 404, error: 'Domain not found' } as const;
    if (domain.oxyUserId !== params.userId) {
      return { status: 403, error: 'You do not own this domain' } as const;
    }

    // First key for this registration.
    if (!domain.domainKey) {
      const [tombstone] = await tx
        .select()
        .from(domainKeyTombstones)
        .where(
          and(eq(domainKeyTombstones.name, parts.label), eq(domainKeyTombstones.tld, parts.tld)),
        )
        .limit(1);

      let rotations: DomainKeyRotation[] = [];
      let reset: { from: string; at: Date } | null = null;
      if (!tombstone) {
        if (rotation)
          return { status: 400, error: 'There is no domain key to rotate yet' } as const;
      } else {
        const released = canonicalKey(tombstone.domainKey);
        if (released && bytesEqual(released, nextKey) && !rotation) {
          // The released key itself, history and all.
          rotations = tombstone.rotations;
        } else if (rotation && released) {
          const check = checkRotation(
            rotation,
            name,
            released,
            nextKey,
            tombstone.rotations,
            params.now,
          );
          if (!check.ok) return { status: 403, error: check.error } as const;
          rotations = [...tombstone.rotations, rotation].slice(-MAX_DOMAIN_KEY_ROTATIONS);
        } else {
          const allowedAt = Math.floor(tombstone.releasedAt.getTime() / 1000) + hold;
          if (params.now < allowedAt) {
            return {
              status: 403,
              error:
                `${name} was released with a domain key on ${tombstone.releasedAt.toISOString()}. ` +
                'A new key needs a rotation statement signed by that key; without one it can be ' +
                `registered after ${new Date(allowedAt * 1000).toISOString()}, marked as a reset, ` +
                'and clients that pinned the old key will refuse it.',
            } as const;
          }
          reset = {
            from: domainKeyFingerprint(tombstone.domainKey),
            at: new Date(params.now * 1000),
          };
        }
      }

      const [updated] = await tx
        .update(domains)
        .set({
          domainKey,
          domainKeyRotations: rotations,
          domainKeyResetFrom: reset?.from ?? null,
          domainKeyResetAt: reset?.at ?? null,
          updatedAt: sql`now()`,
        })
        .where(and(eq(domains.id, domain.id), isNull(domains.domainKey)))
        .returning({ id: domains.id });
      if (!updated)
        return { status: 409, error: 'A domain key was registered concurrently' } as const;
      return {
        status: 201,
        record: {
          name,
          domainKey,
          rotations,
          ...(reset
            ? { keyReset: { previousKeyFingerprint: reset.from, since: reset.at.toISOString() } }
            : {}),
        },
      } as const;
    }

    const currentKey = canonicalKey(domain.domainKey);
    if (currentKey && bytesEqual(currentKey, nextKey)) {
      return {
        status: 200,
        record: {
          name,
          domainKey: domain.domainKey,
          rotations: domain.rotations,
          ...keyResetOf(domain),
        },
      } as const;
    }

    // A different key: only through a statement the current key signed.
    if (!rotation || !currentKey) return { status: 403, error: REQUIRES_ROTATION } as const;
    const check = checkRotation(rotation, name, currentKey, nextKey, domain.rotations, params.now);
    if (!check.ok) return { status: 403, error: check.error } as const;

    const rotations = [...domain.rotations, rotation].slice(-MAX_DOMAIN_KEY_ROTATIONS);
    const [updated] = await tx
      .update(domains)
      .set({ domainKey, domainKeyRotations: rotations, updatedAt: sql`now()` })
      .where(and(eq(domains.id, domain.id), eq(domains.domainKey, domain.domainKey)))
      .returning({ id: domains.id });
    if (!updated) return { status: 409, error: 'The domain key changed concurrently' } as const;
    // Rotation retires every node chained under the old key: stop publishing
    // its material, which no client would accept any more. Same transaction,
    // so a node registration cannot slip in between (it locks this row too).
    await tx
      .update(serviceNodes)
      .set({ chain: [], kaCert: null, updatedAt: sql`now()` })
      .where(eq(serviceNodes.domainId, domain.id));
    return {
      status: 200,
      record: { name, domainKey, rotations, ...keyResetOf(domain) },
    } as const;
  });
}
