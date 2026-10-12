/**
 * The registry's copy of each native name's DOMAIN KEY.
 *
 * Normative spec: docs/architecture/security.md §1 ("Domain keys and pinning").
 *
 * The domain key is generated on the owner's device and is the root of every
 * grant chain for the name; there is no Oxy root above it. The registry
 * PUBLISHES it — clients pin the first key they see per name and relays check
 * service nodes against it — but it is not the authority for it:
 *
 *  - The first key for a name is set by its owner (Oxy-authenticated).
 *  - After that, a different key is accepted ONLY with a rotation statement
 *    signed by the current key. The owner's Oxy account alone cannot replace
 *    it, so neither can anyone who compels or compromises that account.
 *  - There is deliberately NO reset. A lost domain key cannot be replaced
 *    in-band: a reset would be indistinguishable, to a client that pinned the
 *    old key, from the takeover pinning exists to refuse. Recovery is an
 *    out-of-band operator action, and pinned clients will (correctly) refuse
 *    the new key until their users choose to forget the pin.
 *
 * Whoever runs the database can of course write a different key into it
 * directly. That is the compelled-operator case, and client-side pinning is
 * the defence; first contact still trusts the registry until a
 * key-transparency log exists (threat-model.md).
 */

import {
  bytesEqual,
  MAX_DOMAIN_KEY_ROTATIONS,
  parsePublicKey,
  verifyDomainKeyRotation,
} from '@tnp/crypto';
import { isReservedTld } from '@tnp/namespace';
import {
  type DomainKeyRecord,
  isCanonicalName,
  type RegisterDomainKeyRequest,
} from '@tnp/shared-types';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { domains, serviceNodes, tlds } from '../db/schema/index.js';
import type { Executor } from './db.js';

/** How far in the future a rotation's `issuedAt` may be, to absorb clock skew. */
export const MAX_ROTATION_SKEW_SECONDS = 300;

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

/** The published record for an active name under an active TLD, or null. */
export async function lookupDomainKey(db: Executor, name: string): Promise<DomainKeyRecord | null> {
  const parts = splitNativeName(name);
  if (!parts) return null;
  const [row] = await db
    .select({ domainKey: domains.domainKey, rotations: domains.domainKeyRotations })
    .from(domains)
    .innerJoin(tlds, and(eq(tlds.name, domains.tld), eq(tlds.status, 'active')))
    .where(
      and(eq(domains.name, parts.label), eq(domains.tld, parts.tld), eq(domains.status, 'active')),
    )
    .limit(1);
  if (!row?.domainKey) return null;
  return { name, domainKey: row.domainKey, rotations: row.rotations };
}

export type RegisterDomainKeyResult =
  | { status: 200 | 201; record: DomainKeyRecord }
  | { status: 400 | 403 | 404 | 409; error: string };

const REQUIRES_ROTATION =
  'A different domain key requires a rotation statement signed by the current key';

/**
 * Register a name's first domain key, or rotate it with a statement signed by
 * the current one. Every write is conditional on the key it read, so two
 * concurrent writers cannot both win.
 */
export async function registerDomainKey(
  db: Executor,
  params: { userId: string; request: RegisterDomainKeyRequest; now: number },
): Promise<RegisterDomainKeyResult> {
  const { name, domainKey, rotation } = params.request;
  const parts = splitNativeName(name);
  if (!parts) {
    return { status: 400, error: 'name must be a registered name of the form label.tld' };
  }
  const nextKey = canonicalKey(domainKey);
  if (!nextKey) return { status: 400, error: 'domainKey must be canonical base64 of 32 bytes' };

  const [domain] = await db
    .select({
      id: domains.id,
      oxyUserId: domains.oxyUserId,
      domainKey: domains.domainKey,
      rotations: domains.domainKeyRotations,
    })
    .from(domains)
    .where(
      and(eq(domains.name, parts.label), eq(domains.tld, parts.tld), eq(domains.status, 'active')),
    )
    .limit(1);

  if (!domain) return { status: 404, error: 'Domain not found' };
  if (domain.oxyUserId !== params.userId)
    return { status: 403, error: 'You do not own this domain' };

  // First registration.
  if (!domain.domainKey) {
    if (rotation) return { status: 400, error: 'There is no domain key to rotate yet' };
    const [updated] = await db
      .update(domains)
      .set({ domainKey, domainKeyRotations: [], updatedAt: sql`now()` })
      .where(and(eq(domains.id, domain.id), isNull(domains.domainKey)))
      .returning({ id: domains.id });
    if (!updated) return { status: 409, error: 'A domain key was registered concurrently' };
    return { status: 201, record: { name, domainKey, rotations: [] } };
  }

  const currentKey = canonicalKey(domain.domainKey);
  if (currentKey && bytesEqual(currentKey, nextKey)) {
    return {
      status: 200,
      record: { name, domainKey: domain.domainKey, rotations: domain.rotations },
    };
  }

  // A different key: only through a statement the current key signed.
  if (!rotation || !currentKey) return { status: 403, error: REQUIRES_ROTATION };
  const verified = verifyDomainKeyRotation(rotation, name);
  if (
    !verified.ok ||
    !bytesEqual(verified.previousKey, currentKey) ||
    !bytesEqual(verified.nextKey, nextKey)
  ) {
    return { status: 403, error: REQUIRES_ROTATION };
  }
  const last = domain.rotations[domain.rotations.length - 1];
  if (
    (last && verified.issuedAt <= last.issuedAt) ||
    verified.issuedAt > params.now + MAX_ROTATION_SKEW_SECONDS
  ) {
    return {
      status: 403,
      error: 'Rotation issuedAt must be later than the previous rotation and not in the future',
    };
  }

  const rotations = [...domain.rotations, rotation].slice(-MAX_DOMAIN_KEY_ROTATIONS);
  const [updated] = await db
    .update(domains)
    .set({ domainKey, domainKeyRotations: rotations, updatedAt: sql`now()` })
    .where(and(eq(domains.id, domain.id), eq(domains.domainKey, domain.domainKey)))
    .returning({ id: domains.id });
  if (!updated) return { status: 409, error: 'The domain key changed concurrently' };
  // Rotation retires every node chained under the old key: stop publishing its
  // material, which no client would accept any more. The node re-registers
  // with a chain from the new key.
  await db
    .update(serviceNodes)
    .set({ chain: [], kaCert: null, updatedAt: sql`now()` })
    .where(eq(serviceNodes.domainId, domain.id));
  return { status: 200, record: { name, domainKey, rotations } };
}
