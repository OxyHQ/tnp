/**
 * Domain-key pins: trust on first use, like SSH `known_hosts`
 * (docs/architecture/security.md §1, "Domain keys and pinning").
 *
 * The first time this client verifies a name's service node, it records that
 * name's domain key. From then on a different key is accepted only through
 * rotation statements signed by the pinned key; anything else fails closed.
 * That is what stops a compelled or compromised registry from substituting a
 * key for a name this client has used before. It does nothing for the FIRST
 * contact, which still trusts the registry — a key-transparency log is what
 * closes that, and it does not exist yet.
 *
 * The file also keeps rollback high-water marks for the grant and certificate
 * serials seen under each pin, so an older (superseded but unexpired) grant or
 * certificate is refused once a newer one has been seen.
 */

import { parsePublicKey } from '@tnp/crypto';
import { isCanonicalName } from '@tnp/shared-types';
import type { OverlayStore } from './store';

export interface Pin {
  domainKey: string;
  /** ISO 8601, when this key was first pinned (or last rotated to). */
  pinnedAt: string;
  /** Rollback high-water marks: `serialKey → serial`. Bounded. */
  serials: Record<string, number>;
}

interface PinFile {
  version: 1;
  pins: Record<string, Pin>;
}

/** Serial marks kept per pin; the oldest are dropped past this. */
const MAX_SERIALS_PER_PIN = 32;

export class PinStore {
  private cache: PinFile | null = null;

  constructor(private readonly store: OverlayStore) {}

  private load(): PinFile {
    if (this.cache) return this.cache;
    const raw = this.store.readPrivate(this.store.pinsPath);
    if (raw === null) {
      this.cache = { version: 1, pins: {} };
      return this.cache;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt pin file must not silently become "no pins" — that would
      // turn every name back into a first contact. Fail closed.
      throw new Error(
        `the pin file ${this.store.pinsPath} is corrupt; refusing to continue without it`,
      );
    }
    const file = parsed as PinFile;
    if (file?.version !== 1 || typeof file.pins !== 'object' || file.pins === null) {
      throw new Error(`the pin file ${this.store.pinsPath} has an unknown format`);
    }
    for (const [name, pin] of Object.entries(file.pins)) {
      if (!isCanonicalName(name) || typeof pin?.domainKey !== 'string') {
        throw new Error(`the pin file ${this.store.pinsPath} has a malformed entry`);
      }
      parsePublicKey(pin.domainKey);
      pin.serials ??= {};
    }
    this.cache = file;
    return file;
  }

  private save(): void {
    if (!this.cache) return;
    this.store.writePrivate(this.store.pinsPath, `${JSON.stringify(this.cache, null, 2)}\n`);
  }

  get(name: string): Pin | undefined {
    return this.load().pins[name];
  }

  list(): Array<{ name: string } & Pin> {
    return Object.entries(this.load().pins)
      .map(([name, pin]) => ({ name, ...pin }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  knownSerials(name: string): Map<string, number> {
    return new Map(Object.entries(this.get(name)?.serials ?? {}));
  }

  /**
   * Record `domainKey` for `name` after a successful verification, raising the
   * serial marks. Callers must have verified the chain first.
   */
  record(
    name: string,
    domainKey: string,
    serials: ReadonlyArray<{ key: string; serial: number }>,
  ): void {
    const file = this.load();
    const existing = file.pins[name];
    const keyChanged = !existing || existing.domainKey !== domainKey;
    const marks: Record<string, number> = keyChanged ? {} : { ...existing.serials };
    for (const { key, serial } of serials) marks[key] = Math.max(marks[key] ?? 0, serial);
    const entries = Object.entries(marks);
    const bounded = Object.fromEntries(
      entries.slice(Math.max(0, entries.length - MAX_SERIALS_PER_PIN)),
    );
    const pinnedAt = keyChanged ? new Date().toISOString() : existing.pinnedAt;
    const unchanged =
      !keyChanged && JSON.stringify(bounded) === JSON.stringify(existing.serials ?? {});
    file.pins[name] = { domainKey, pinnedAt, serials: bounded };
    if (!unchanged) this.save();
  }

  /** Forget a pin. The next contact with `name` is a first contact again. */
  forget(name: string): boolean {
    const file = this.load();
    if (!file.pins[name]) return false;
    delete file.pins[name];
    this.save();
    return true;
  }
}
