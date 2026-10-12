/**
 * The client's view of the signed relay directory (docs/architecture/discovery.md
 * §2–§3): fetched from the API, verified against the pinned directory key(s),
 * cached on disk with its validity window, and never replaced by an older one.
 *
 * - A document is used only after `verifySignedRelayDirectory` accepts it:
 *   pinned signature, not expired, endpoints canonical and public, serial no
 *   greater than its own `issuedAt` (so a signer cannot raise the mark beyond
 *   the clock), and no lower than the highest this device has accepted FROM
 *   THE SAME SIGNING KEY (rollback). Marks are kept per key, so a rotation to
 *   a new key is not held hostage by anything the old key ever signed.
 * - The marks and the last verified document are persisted under a lock
 *   (re-read, merge, atomic write), so concurrent processes never lower each
 *   other's marks. A state file that exists but cannot be read is a refusal,
 *   never a silent reset of the marks.
 * - When a fetch fails or is refused, the cached copy is used if it still
 *   verifies; it is verified data, so this is not an unverified fallback.
 *   Otherwise there is no directory, and no relay is selectable.
 */

import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { type SignedRelayDirectory, toHex, type VerifiedRelayDirectory } from '@tnp/crypto';
import {
  describeDirectoryRejection,
  normalizeRelayEndpoint,
  RelayCapability,
  type RelayDirectoryFailure,
  relayDirectorySigningKeys,
  verifySignedRelayDirectory,
} from '@tnp/shared-types';
import type { OverlayStore } from './overlay/store';

export type { VerifiedRelayDirectory } from '@tnp/crypto';

/** No verified directory is available, so no relay may be selected. */
export class RelayDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayDirectoryError';
  }
}

export interface DirectoryState {
  /** Highest serial accepted on this device, per signing key (hex). */
  marks: Record<string, number>;
  /** The last verified document, for use while the API is unreachable. */
  document: SignedRelayDirectory | null;
}

export interface DirectoryStateStore {
  /** The state, null when there is none yet. THROWS when it exists but is unreadable. */
  load(): DirectoryState | null;
  /** Merge `state` in: marks only ever rise; the newer document wins. */
  merge(state: DirectoryState): void;
}

function mergeStates(current: DirectoryState | null, next: DirectoryState): DirectoryState {
  const marks: Record<string, number> = { ...(current?.marks ?? {}) };
  for (const [key, serial] of Object.entries(next.marks)) {
    marks[key] = Math.max(marks[key] ?? 0, serial);
  }
  const a = current?.document ?? null;
  const b = next.document;
  const document = a && (!b || a.issuedAt > b.issuedAt) ? a : b;
  return { marks, document };
}

/** Process-local state (tests, and callers that must not touch disk). */
export class MemoryDirectoryStateStore implements DirectoryStateStore {
  private state: DirectoryState | null = null;
  load(): DirectoryState | null {
    return this.state ? { marks: { ...this.state.marks }, document: this.state.document } : null;
  }
  merge(state: DirectoryState): void {
    this.state = mergeStates(this.state, state);
  }
}

const HEX_KEY = /^[0-9a-f]{64}$/;

/** `<overlay dir>/relay-directory.json`, 0600, changed only under its lock. */
export class FileDirectoryStateStore implements DirectoryStateStore {
  readonly path: string;

  constructor(private readonly store: OverlayStore) {
    this.path = join(store.root, 'relay-directory.json');
  }

  private corrupt(why: string): Error {
    return new RelayDirectoryError(
      `the relay directory state ${this.path} ${why}; refusing to continue without its rollback ` +
        'marks. Check the file (someone may have replaced it), then delete it to start over.',
    );
  }

  load(): DirectoryState | null {
    let isFile: boolean;
    try {
      isFile = lstatSync(this.path).isFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw this.corrupt('cannot be read');
    }
    if (!isFile) throw this.corrupt('is not a regular file');
    let value: unknown;
    try {
      value = JSON.parse(this.store.readPrivate(this.path) ?? '');
    } catch {
      throw this.corrupt('is corrupt');
    }
    const v = value as { version?: unknown; marks?: unknown; document?: unknown };
    if (
      typeof v !== 'object' ||
      v === null ||
      v.version !== 2 ||
      typeof v.marks !== 'object' ||
      v.marks === null ||
      Array.isArray(v.marks)
    ) {
      throw this.corrupt('has an unknown format');
    }
    const marks: Record<string, number> = {};
    for (const [key, serial] of Object.entries(v.marks)) {
      if (!HEX_KEY.test(key) || !Number.isSafeInteger(serial) || (serial as number) < 0) {
        throw this.corrupt('has a malformed mark');
      }
      marks[key] = serial as number;
    }
    const document = (v.document ?? null) as SignedRelayDirectory | null;
    if (document !== null && (typeof document !== 'object' || Array.isArray(document))) {
      throw this.corrupt('has a malformed document');
    }
    return { marks, document };
  }

  merge(state: DirectoryState): void {
    this.store.withLock(this.path, () => {
      const next = mergeStates(this.load(), state);
      this.store.writePrivate(this.path, `${JSON.stringify({ version: 2, ...next })}\n`);
    });
  }
}

export interface RelayDirectoryClientOptions {
  /** Fetch the raw `GET /relays/directory` body. Throws on network or HTTP failure. */
  fetchDocument: () => Promise<unknown>;
  store: DirectoryStateStore;
  /** Defaults to the keys pinned in `@tnp/shared-types`. */
  trustedKeys?: readonly Uint8Array[];
  /** Unix seconds. */
  now?: () => number;
  /** Tests over loopback only. */
  allowNonPublicEndpoints?: boolean;
  /** Refetch after this many seconds even while the held document is valid. */
  refreshAfterSeconds?: number;
  log?: (message: string) => void;
}

const DEFAULT_REFRESH_SECONDS = 10 * 60;

/** What the directory says about one endpoint. */
export interface DirectoryRelayEntry {
  key: Uint8Array;
  operator: 'oxy' | 'community';
}

type Verdict =
  | { ok: true; directory: VerifiedRelayDirectory }
  | { ok: false; reason: RelayDirectoryFailure };

export class RelayDirectoryClient {
  private held: { directory: VerifiedRelayDirectory; fetchedAt: number } | null = null;
  private refreshing: Promise<VerifiedRelayDirectory> | null = null;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: RelayDirectoryClientOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = options.log ?? ((m) => console.warn(`[tnp] ${m}`));
  }

  /** The directory client `tnp serve` and `tnp connect` use: the API, persisted per user. */
  static forUser(fetchDocument: () => Promise<unknown>, store: OverlayStore): RelayDirectoryClient {
    return new RelayDirectoryClient({ fetchDocument, store: new FileDirectoryStateStore(store) });
  }

  /** A verified, unexpired directory, or `RelayDirectoryError`. */
  async get(): Promise<VerifiedRelayDirectory> {
    const now = this.now();
    const held = this.held;
    if (
      held &&
      now < held.directory.expiresAt &&
      now - held.fetchedAt < (this.options.refreshAfterSeconds ?? DEFAULT_REFRESH_SECONDS)
    ) {
      return held.directory;
    }
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  /**
   * What the directory lists for `endpoint` (a relay with `capability`), or
   * null when it is not listed. Throws `RelayDirectoryError` when there is no
   * verified directory at all.
   */
  async entryFor(
    endpoint: string,
    capability: string = RelayCapability.TUNNEL,
  ): Promise<DirectoryRelayEntry | null> {
    const normalized = normalizeRelayEndpoint(endpoint);
    if (!normalized) return null;
    const directory = await this.get();
    const entry = directory.relays.find(
      (r) => r.endpoint === normalized && r.capabilities.includes(capability),
    );
    return entry ? { key: entry.key, operator: entry.operator } : null;
  }

  /** The listed key for `endpoint`, or null. See {@link entryFor}. */
  async relayKeyFor(
    endpoint: string,
    capability: string = RelayCapability.TUNNEL,
  ): Promise<Uint8Array | null> {
    return (await this.entryFor(endpoint, capability))?.key ?? null;
  }

  private verify(body: unknown, marks: Record<string, number>): Verdict {
    const result = verifySignedRelayDirectory(body, {
      now: this.now(),
      trustedKeys: this.options.trustedKeys ?? relayDirectorySigningKeys(),
      allowNonPublicEndpoints: this.options.allowNonPublicEndpoints,
    });
    if (!result.ok) return result;
    // Rollback is judged against what THIS key has signed before.
    const mark = marks[toHex(result.directory.signedBy)] ?? 0;
    if (result.directory.serial < mark) return { ok: false, reason: 'rolled-back' };
    return result;
  }

  private async refresh(): Promise<VerifiedRelayDirectory> {
    let state: DirectoryState | null;
    try {
      state = this.options.store.load();
    } catch (err) {
      // Fail closed: an unreadable state file must not reset the marks to 0.
      throw err instanceof RelayDirectoryError
        ? err
        : new RelayDirectoryError(`the relay directory state cannot be read: ${String(err)}`);
    }
    const marks: Record<string, number> = { ...(state?.marks ?? {}) };
    if (this.held) {
      const key = toHex(this.held.directory.signedBy);
      marks[key] = Math.max(marks[key] ?? 0, this.held.directory.serial);
    }

    let problem: string;
    try {
      const body = await this.options.fetchDocument();
      const result = this.verify(body, marks);
      if (result.ok) {
        this.accept(result.directory);
        return result.directory;
      }
      problem = describeDirectoryRejection(result.reason);
    } catch (err) {
      problem = `could not fetch the relay directory: ${err instanceof Error ? err.message : String(err)}`;
    }

    // The newest verified document we hold, re-verified now (it may have expired).
    for (const cached of [this.held?.directory.document ?? null, state?.document ?? null]) {
      if (!cached) continue;
      const result = this.verify(cached, marks);
      if (result.ok) {
        this.log(
          `${problem}; using the cached signed directory (serial ${result.directory.serial})`,
        );
        this.held = { directory: result.directory, fetchedAt: this.now() };
        return result.directory;
      }
    }
    throw new RelayDirectoryError(`no verified relay directory: ${problem}`);
  }

  private accept(directory: VerifiedRelayDirectory): void {
    this.held = { directory, fetchedAt: this.now() };
    try {
      this.options.store.merge({
        marks: { [toHex(directory.signedBy)]: directory.serial },
        document: directory.document,
      });
    } catch (err) {
      // Still usable now; only rollback protection across restarts is lost.
      this.log(
        `could not persist the relay directory: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
