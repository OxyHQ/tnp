/**
 * The client's view of the signed relay directory (docs/architecture/discovery.md
 * §2–§3): fetched from the API, verified against the pinned directory key(s),
 * cached on disk with its validity window, and never replaced by an older one.
 *
 * - A document is used only after `verifySignedRelayDirectory` accepts it:
 *   pinned signature, not expired, endpoints canonical and public, and a
 *   serial no lower than the highest this device has accepted (rollback).
 * - The highest serial and the last verified document are persisted, so the
 *   rollback mark survives restarts and the cached copy is usable while the
 *   API is unreachable — until it expires.
 * - When a fetch fails or is refused, the cached copy is used if it still
 *   verifies; it is verified data, so this is not an unverified fallback.
 *   Otherwise there is no directory, and no relay is selectable.
 *
 * A fetched document whose serial is lower than the cached one (another API
 * task signed it a moment earlier, or a cache served it) is "rolled back":
 * the cached one, which is newer, is kept.
 */

import { join } from 'node:path';
import type { SignedRelayDirectory, VerifiedRelayDirectory } from '@tnp/crypto';
import {
  describeDirectoryRejection,
  normalizeRelayEndpoint,
  RelayCapability,
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
  /** Highest serial ever accepted on this device. */
  highestSerial: number;
  /** The last verified document, for use while the API is unreachable. */
  document: SignedRelayDirectory | null;
}

export interface DirectoryStateStore {
  load(): DirectoryState | null;
  save(state: DirectoryState): void;
}

/** Process-local state (tests, and callers that must not touch disk). */
export class MemoryDirectoryStateStore implements DirectoryStateStore {
  private state: DirectoryState | null = null;
  load(): DirectoryState | null {
    return this.state ? { ...this.state } : null;
  }
  save(state: DirectoryState): void {
    this.state = { ...state };
  }
}

/**
 * `<overlay dir>/relay-directory.json`, 0600, written atomically. Several
 * processes may share it; each save re-reads and keeps the higher serial, so
 * one process cannot lower another's mark.
 */
export class FileDirectoryStateStore implements DirectoryStateStore {
  readonly path: string;

  constructor(private readonly store: OverlayStore) {
    this.path = join(store.root, 'relay-directory.json');
  }

  load(): DirectoryState | null {
    let raw: string | null;
    try {
      raw = this.store.readPrivate(this.path);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw) as Partial<DirectoryState> & { version?: unknown };
      if (value.version !== 1 || !Number.isSafeInteger(value.highestSerial)) return null;
      return {
        highestSerial: value.highestSerial as number,
        document: (value.document as SignedRelayDirectory | null) ?? null,
      };
    } catch {
      return null;
    }
  }

  save(state: DirectoryState): void {
    const current = this.load();
    const highestSerial = Math.max(state.highestSerial, current?.highestSerial ?? 0);
    const document =
      current?.document && current.document.serial > (state.document?.serial ?? 0)
        ? current.document
        : state.document;
    this.store.writePrivate(
      this.path,
      `${JSON.stringify({ version: 1, highestSerial, document })}\n`,
    );
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

export class RelayDirectoryClient {
  private held: { directory: VerifiedRelayDirectory; fetchedAt: number } | null = null;
  private refreshing: Promise<VerifiedRelayDirectory> | null = null;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly options: RelayDirectoryClientOptions) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = options.log ?? ((m) => console.warn(`[tnp] ${m}`));
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
   * The key the directory lists for `endpoint` (a relay that accepts client
   * circuits), or null when it is not listed. Throws `RelayDirectoryError`
   * when there is no verified directory at all.
   */
  async relayKeyFor(
    endpoint: string,
    capability: string = RelayCapability.TUNNEL,
  ): Promise<Uint8Array | null> {
    const normalized = normalizeRelayEndpoint(endpoint);
    if (!normalized) return null;
    const directory = await this.get();
    const entry = directory.relays.find(
      (r) => r.endpoint === normalized && r.capabilities.includes(capability),
    );
    return entry ? entry.key : null;
  }

  private verify(body: unknown, minSerial: number) {
    return verifySignedRelayDirectory(body, {
      now: this.now(),
      minSerial,
      trustedKeys: this.options.trustedKeys ?? relayDirectorySigningKeys(),
      allowNonPublicEndpoints: this.options.allowNonPublicEndpoints,
    });
  }

  private async refresh(): Promise<VerifiedRelayDirectory> {
    let state: DirectoryState | null = null;
    try {
      state = this.options.store.load();
    } catch {
      state = null;
    }
    const highest = Math.max(state?.highestSerial ?? 0, this.held?.directory.serial ?? 0);

    let problem: string;
    try {
      const body = await this.options.fetchDocument();
      const result = this.verify(body, highest);
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
      const result = this.verify(cached, highest);
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

  /** The directory client `tnp serve` and `tnp connect` use: the API, persisted per user. */
  static forUser(fetchDocument: () => Promise<unknown>, store: OverlayStore): RelayDirectoryClient {
    return new RelayDirectoryClient({ fetchDocument, store: new FileDirectoryStateStore(store) });
  }

  private accept(directory: VerifiedRelayDirectory): void {
    this.held = { directory, fetchedAt: this.now() };
    try {
      this.options.store.save({ highestSerial: directory.serial, document: directory.document });
    } catch (err) {
      // Still usable now; only rollback protection across restarts is lost.
      this.log(
        `could not persist the relay directory: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
