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
 * serials seen under each pin (most recently raised kept, per name), so an
 * older (superseded but unexpired) grant or certificate is refused once a
 * newer one has been seen.
 *
 * Several processes share the file (`tnp connect`, `tnp pins`, `tnp test`).
 * Nothing is cached: every read goes to disk, and every change is made under
 * an exclusive lock file — re-read, decide, write atomically, unlock — so one
 * process never overwrites another's pin, and `tnp pins forget` is not undone
 * by a running client.
 */

import { closeSync, constants, lstatSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { parsePublicKey } from '@tnp/crypto';
import { isCanonicalName } from '@tnp/shared-types';
import type { OverlayStore } from './store';

export interface Pin {
  domainKey: string;
  /** ISO 8601, when this key was first pinned (or last rotated to). */
  pinnedAt: string;
  /** Rollback high-water marks: `serialKey → serial`, least recently raised first. Bounded. */
  serials: Record<string, number>;
}

interface PinFile {
  version: 1;
  pins: Record<string, Pin>;
}

/** Serial marks kept per pin; the least recently raised are dropped past this. */
export const MAX_SERIALS_PER_PIN = 256;

/** A lock older than this is a crashed holder's and is broken. */
const STALE_LOCK_MS = 10_000;
/** How long to wait for another process's lock before giving up. */
const LOCK_WAIT_MS = 5_000;

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

/** Raise the marks in `serials`, moving each raised key to the most-recent end. */
export function raiseSerials(
  current: Record<string, number>,
  serials: ReadonlyArray<{ key: string; serial: number }>,
): Record<string, number> {
  const entries = new Map(Object.entries(current));
  for (const { key, serial } of serials) {
    const value = Math.max(entries.get(key) ?? 0, serial);
    entries.delete(key);
    entries.set(key, value);
  }
  const list = [...entries];
  return Object.fromEntries(list.slice(Math.max(0, list.length - MAX_SERIALS_PER_PIN)));
}

export class PinStore {
  constructor(private readonly store: OverlayStore) {}

  private read(): PinFile {
    const raw = this.store.readPrivate(this.store.pinsPath);
    if (raw === null) return { version: 1, pins: {} };
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
    return file;
  }

  private withLock<T>(fn: () => T): T {
    const lockPath = `${this.store.pinsPath}.lock`;
    this.store.ensureDir(this.store.root);
    const deadline = Date.now() + LOCK_WAIT_MS;
    let fd: number | null = null;
    while (fd === null) {
      try {
        fd = openSync(
          lockPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        try {
          if (Date.now() - lstatSync(lockPath).mtimeMs > STALE_LOCK_MS) {
            unlinkSync(lockPath); // a holder that crashed
            continue;
          }
        } catch {
          continue; // released between our open and stat
        }
        if (Date.now() > deadline) {
          throw new Error(`the pin file ${this.store.pinsPath} is locked by another process`);
        }
        sleepSync(10);
      }
    }
    try {
      writeSync(fd, `${process.pid}\n`);
      return fn();
    } finally {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        // already broken as stale by someone else
      }
    }
  }

  get(name: string): Pin | undefined {
    return this.read().pins[name];
  }

  list(): Array<{ name: string } & Pin> {
    return Object.entries(this.read().pins)
      .map(([name, pin]) => ({ name, ...pin }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  knownSerials(name: string): Map<string, number> {
    return new Map(Object.entries(this.get(name)?.serials ?? {}));
  }

  /**
   * Decide about `name` under the lock, against the pin as it is on disk NOW.
   * `decide` gets the current pin (or undefined) and returns the pin to store
   * (undefined: leave it as it is) — or throws, which changes nothing.
   */
  update<T>(name: string, decide: (pin: Pin | undefined) => { pin?: Pin; result: T }): T {
    return this.withLock(() => {
      const file = this.read();
      const { pin, result } = decide(file.pins[name]);
      if (pin && JSON.stringify(pin) !== JSON.stringify(file.pins[name])) {
        file.pins[name] = pin;
        this.store.writePrivate(this.store.pinsPath, `${JSON.stringify(file, null, 2)}\n`);
      }
      return result;
    });
  }

  /** The pin for `name` after recording `domainKey` and raising the serial marks. */
  static next(
    existing: Pin | undefined,
    domainKey: string,
    serials: ReadonlyArray<{ key: string; serial: number }>,
  ): Pin {
    const keyChanged = !existing || existing.domainKey !== domainKey;
    return {
      domainKey,
      pinnedAt: keyChanged ? new Date().toISOString() : existing.pinnedAt,
      serials: raiseSerials(keyChanged ? {} : existing.serials, serials),
    };
  }

  /** Record `domainKey` for `name`. Callers must have verified the chain first. */
  record(
    name: string,
    domainKey: string,
    serials: ReadonlyArray<{ key: string; serial: number }>,
  ): void {
    this.update(name, (existing) => ({
      pin: PinStore.next(existing, domainKey, serials),
      result: undefined,
    }));
  }

  /** Forget a pin. The next contact with `name` is a first contact again. */
  forget(name: string): boolean {
    return this.withLock(() => {
      const file = this.read();
      if (!file.pins[name]) return false;
      delete file.pins[name];
      this.store.writePrivate(this.store.pinsPath, `${JSON.stringify(file, null, 2)}\n`);
      return true;
    });
  }
}
