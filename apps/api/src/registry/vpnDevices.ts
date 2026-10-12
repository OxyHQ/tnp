/**
 * Storage of WireGuard VPN devices (docs/architecture/vpn.md §10).
 *
 * The registry keeps, per device, its owner, its name, its public key and its
 * tunnel address — nothing else. It never sees a private key and records no
 * use: no handshake, no endpoint, no byte count.
 *
 * Two properties are enforced by the database, not by a read-then-write:
 *
 * - **Unique key and address.** Unique indexes on both. Addresses are drawn at
 *   random from the pool and inserted with `ON CONFLICT DO NOTHING`; a clash
 *   draws again. Random rather than sequential so an address says nothing
 *   about how many devices exist or when this one was added.
 * - **The per-account cap.** Creating a device takes a transaction-scoped
 *   advisory lock, then counts. Two concurrent creates run one after the
 *   other, so neither can push an account past the cap.
 *
 * And one by a lock: **a freed address is not reused for 24 h**
 * (`vpn_address_quarantine`, address and release time only). Allocation and
 * release both take the same transaction-scoped advisory lock, so a create
 * can never slip between a delete and its quarantine row. Without the hold, a
 * new device could inherit the old one's live flows — the exit's connection
 * tracking, and remote servers' sessions keyed by the exit's address and port.
 */

import { randomInt } from 'node:crypto';
import { and, count, eq, sql } from 'drizzle-orm';
import {
  type CreateVpnDeviceRequest,
  type ExitPeer,
  VPN_MAX_HOST_INDEX,
  VPN_MIN_HOST_INDEX,
  type VpnDevice,
  vpnIpv4ForIndex,
  vpnIpv6ForIpv4,
} from '@tnp/shared-types';
import { vpnAddressQuarantine, vpnDevices } from '../db/schema/index.js';
import type { Executor } from './db.js';

type Row = typeof vpnDevices.$inferSelect;

/** Advisory lock serialising address allocation and release (and so the per-account cap). */
const ADDRESS_LOCK = 7_701_001;
/** How long a freed address is held back before another device may get it. */
export const VPN_ADDRESS_QUARANTINE_SECONDS = 24 * 60 * 60;
/** Draws before giving up. At a quarter full, 32 clashes in a row is ~2^-64. */
const MAX_ADDRESS_ATTEMPTS = 32;

function toDevice(row: Row): VpnDevice {
  return {
    id: row.id,
    name: row.name,
    publicKey: row.publicKey,
    ipv4: row.address,
    ipv6: vpnIpv6ForIpv4(row.address),
    createdAt: row.createdAt.toISOString(),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A device id is a UUID; anything else cannot name a row and is answered 404 without a query. */
export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export async function listVpnDevices(db: Executor, oxyUserId: string): Promise<VpnDevice[]> {
  const rows = await db
    .select()
    .from(vpnDevices)
    .where(eq(vpnDevices.oxyUserId, oxyUserId))
    .orderBy(vpnDevices.createdAt, vpnDevices.id);
  return rows.map(toDevice);
}

export type CreateVpnDeviceResult =
  | { ok: true; device: VpnDevice }
  | { ok: false; code: 'device_limit' | 'public_key_in_use' | 'address_pool_exhausted' };

export interface CreateVpnDeviceOptions {
  maxDevices: number;
  /** A host index in `[VPN_MIN_HOST_INDEX, VPN_MAX_HOST_INDEX]`. Injectable for tests. */
  drawIndex?: () => number;
  /** Defaults to `VPN_ADDRESS_QUARANTINE_SECONDS`. */
  quarantineSeconds?: number;
}

const defaultDraw = () => randomInt(VPN_MIN_HOST_INDEX, VPN_MAX_HOST_INDEX + 1);

export async function createVpnDevice(
  db: Executor,
  oxyUserId: string,
  request: CreateVpnDeviceRequest,
  options: CreateVpnDeviceOptions,
): Promise<CreateVpnDeviceResult> {
  const drawIndex = options.drawIndex ?? defaultDraw;
  const hold = options.quarantineSeconds ?? VPN_ADDRESS_QUARANTINE_SECONDS;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADDRESS_LOCK}::int8)`);
    await tx
      .delete(vpnAddressQuarantine)
      .where(sql`${vpnAddressQuarantine.releasedAt} <= now() - make_interval(secs => ${hold})`);

    const [{ n }] = await tx
      .select({ n: count() })
      .from(vpnDevices)
      .where(eq(vpnDevices.oxyUserId, oxyUserId));
    if (n >= options.maxDevices) return { ok: false, code: 'device_limit' } as const;

    for (let attempt = 0; attempt < MAX_ADDRESS_ATTEMPTS; attempt++) {
      const index = drawIndex();
      if (!Number.isInteger(index) || index < VPN_MIN_HOST_INDEX || index > VPN_MAX_HOST_INDEX) {
        throw new RangeError('drawn host index is outside the pool');
      }
      const address = vpnIpv4ForIndex(index);
      const [held] = await tx
        .select({ address: vpnAddressQuarantine.address })
        .from(vpnAddressQuarantine)
        .where(eq(vpnAddressQuarantine.address, address));
      if (held) continue;
      // No conflict target: a clash on the key or on the address both return
      // no row instead of aborting the transaction, and are told apart below.
      const [row] = await tx
        .insert(vpnDevices)
        .values({
          oxyUserId,
          name: request.name,
          publicKey: request.publicKey,
          address,
        })
        .onConflictDoNothing()
        .returning();
      if (row) return { ok: true, device: toDevice(row) } as const;

      const [taken] = await tx
        .select({ id: vpnDevices.id })
        .from(vpnDevices)
        .where(eq(vpnDevices.publicKey, request.publicKey));
      if (taken) return { ok: false, code: 'public_key_in_use' } as const;
    }
    return { ok: false, code: 'address_pool_exhausted' } as const;
  });
}

export async function renameVpnDevice(
  db: Executor,
  oxyUserId: string,
  id: string,
  name: string,
): Promise<VpnDevice | null> {
  const [row] = await db
    .update(vpnDevices)
    .set({ name })
    .where(and(eq(vpnDevices.id, id), eq(vpnDevices.oxyUserId, oxyUserId)))
    .returning();
  return row ? toDevice(row) : null;
}

/** Delete one of the caller's devices. Returns whether it existed. */
export async function deleteVpnDevice(
  db: Executor,
  oxyUserId: string,
  id: string,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${ADDRESS_LOCK}::int8)`);
    const [deleted] = await tx
      .delete(vpnDevices)
      .where(and(eq(vpnDevices.id, id), eq(vpnDevices.oxyUserId, oxyUserId)))
      .returning({ address: vpnDevices.address });
    if (!deleted) return false;
    await tx
      .insert(vpnAddressQuarantine)
      .values({ address: deleted.address })
      .onConflictDoUpdate({
        target: vpnAddressQuarantine.address,
        set: { releasedAt: sql`now()` },
      });
    return true;
  });
}

/** Every device an exit must accept: a key and its addresses, nothing that names an account. */
export async function listExitPeers(db: Executor): Promise<ExitPeer[]> {
  const rows = await db
    .select({ publicKey: vpnDevices.publicKey, address: vpnDevices.address })
    .from(vpnDevices)
    .orderBy(vpnDevices.address);
  return rows.map((row) => ({
    publicKey: row.publicKey,
    ipv4: row.address,
    ipv6: vpnIpv6ForIpv4(row.address),
  }));
}
