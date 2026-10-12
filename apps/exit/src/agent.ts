/**
 * The exit agent: keep `wg0`'s peers equal to the API's device list.
 *
 * Every round: fetch `GET /exit/peers`, read the interface's peers, apply the
 * difference, and delete the connection-tracking entries of every peer it
 * removes (so a revoked device's flows end now, and a later holder of the
 * address inherits nothing).
 *
 * Failure, briefly, is conservative: if the API cannot be reached, answers
 * something malformed, or `wg` prints something unexpected, the round changes
 * nothing and the peers already configured keep working. But not for long,
 * and not when the API says so — revocation must keep its promise:
 *
 * - **Stop serving at once** when the API answers 401/403 (this exit's token
 *   was revoked) or 503 `vpn_not_configured` (the VPN was switched off): every
 *   peer is removed.
 * - **Fail closed after `maxStaleMs`** (default 10 minutes) without a
 *   successful sync: every peer is removed, because a device revoked in the
 *   meantime would otherwise keep working for as long as the outage lasts.
 *   Peers return on the next successful sync.
 *
 * Logs carry counts only — never a key, an address or anything else that
 * could tie a line to a device (privacy-model.md §4: exits keep aggregates).
 */

import { execFile } from 'node:child_process';
import { parseExitPeersResponse } from '@tnp/shared-types';
import {
  type ActualPeers,
  type PeerChange,
  parseWgAllowedIps,
  planPeerChanges,
  wgSetCommands,
} from './reconcile.js';

/** The API refused this exit: stop serving everyone now, do not wait for staleness. */
export class StopServingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StopServingError';
  }
}

export interface SyncDeps {
  /** The `/exit/peers` body, as parsed JSON. Throws on any transport or HTTP failure. */
  fetchPeers: () => Promise<unknown>;
  /** Run `wg` with an argument array; resolves to stdout. */
  runWg: (args: string[]) => Promise<string>;
  /** Run `conntrack` with an argument array; resolves when done (no match is not an error). */
  runConntrack: (args: string[]) => Promise<void>;
  iface: string;
}

export interface SyncStats {
  peers: number;
  set: number;
  removed: number;
  rejected: number;
}

const HOST_V4 = /^(\d{1,3}(?:\.\d{1,3}){3})\/32$/;
const HOST_V6 = /^([0-9a-f:]+)\/128$/;

/**
 * `conntrack -D` argument lists for the host addresses of removed peers: the
 * flows they originated (before NAT, a peer's flows have it as source).
 */
export function conntrackCommands(actual: ActualPeers, changes: readonly PeerChange[]): string[][] {
  const commands: string[][] = [];
  for (const change of changes) {
    if (change.kind !== 'remove') continue;
    for (const prefix of actual.get(change.publicKey) ?? []) {
      const v4 = HOST_V4.exec(prefix);
      const v6 = HOST_V6.exec(prefix);
      if (v4) commands.push(['-D', '-f', 'ipv4', '-s', v4[1]]);
      else if (v6) commands.push(['-D', '-f', 'ipv6', '-s', v6[1]]);
    }
  }
  return commands;
}

async function apply(
  deps: SyncDeps,
  actual: ActualPeers,
  changes: readonly PeerChange[],
): Promise<void> {
  for (const args of wgSetCommands(deps.iface, changes)) await deps.runWg(args);
  // After the peer is gone from wg0, so no new packet can recreate an entry.
  for (const args of conntrackCommands(actual, changes)) await deps.runConntrack(args);
}

export async function syncOnce(deps: SyncDeps): Promise<SyncStats> {
  const parsed = parseExitPeersResponse(await deps.fetchPeers());
  if (!parsed.ok) throw new Error(`peer list refused: ${parsed.error}`);
  const actual = parseWgAllowedIps(await deps.runWg(['show', deps.iface, 'allowed-ips']));
  const changes = planPeerChanges(parsed.value.peers, actual);
  await apply(deps, actual, changes);
  return {
    peers: parsed.value.peers.length,
    set: changes.filter((c) => c.kind === 'set').length,
    removed: changes.filter((c) => c.kind === 'remove').length,
    rejected: parsed.value.rejected,
  };
}

/** Remove every peer (and its flows). Returns how many there were. */
export async function flushPeers(deps: SyncDeps): Promise<number> {
  const actual = parseWgAllowedIps(await deps.runWg(['show', deps.iface, 'allowed-ips']));
  const changes = planPeerChanges([], actual);
  await apply(deps, actual, changes);
  return changes.length;
}

/** Largest `/exit/peers` body accepted: the whole pool at a generous size per entry. */
export const MAX_PEERS_BODY_BYTES = 16 * 1024 * 1024;

export interface PeerFetcherOptions {
  apiUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function createPeerFetcher(options: PeerFetcherOptions): () => Promise<unknown> {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.apiUrl.replace(/\/+$/, '')}/exit/peers`;
  return async () => {
    const res = await doFetch(url, {
      headers: { Authorization: `Bearer ${options.token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      throw new StopServingError(`the API refused this exit's token (HTTP ${res.status})`);
    }
    if (res.status === 503) {
      const code = await res
        .json()
        .then((b) => (b as { code?: unknown })?.code)
        .catch(() => undefined);
      if (code === 'vpn_not_configured') {
        throw new StopServingError('the API says the VPN is switched off');
      }
      throw new Error('peer list request failed with HTTP 503');
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new Error(`peer list request failed with HTTP ${res.status}`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_PEERS_BODY_BYTES) {
      await res.body?.cancel();
      throw new Error('peer list is too large');
    }
    const text = await res.text();
    if (text.length > MAX_PEERS_BODY_BYTES) throw new Error('peer list is too large');
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Not the parser's message: it can quote the body.
      throw new Error('peer list is not JSON');
    }
  };
}

function run(
  bin: string,
  args: string[],
  okCodes: readonly number[],
  label: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: 15_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { PATH: process.env.PATH ?? '/usr/bin:/usr/sbin' },
      },
      (err, stdout) => {
        if (!err) return resolve(stdout);
        const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === 'number' && okCodes.includes(code)) return resolve(stdout);
        // stderr is never included: it can echo a key or an address back.
        reject(new Error(`${label} ${args[0]} failed (${code ?? 'error'})`));
      },
    );
  });
}

/** `wg` through `execFile`: an argument array, no shell, bounded time and output. */
export function createWgRunner(bin: string): (args: string[]) => Promise<string> {
  return (args) => run(bin, args, [], 'wg');
}

/** `conntrack` through `execFile`. Exit status 1 means "no matching entry", which is fine. */
export function createConntrackRunner(bin: string): (args: string[]) => Promise<void> {
  return async (args) => {
    await run(bin, args, [1], 'conntrack');
  };
}

export interface AgentHealth {
  status: 'ok' | 'starting' | 'stale' | 'flushed';
  peers: number | null;
  lastSyncAgeSeconds: number | null;
  consecutiveFailures: number;
}

/** Default: drop every peer after 10 minutes without a successful sync. */
export const DEFAULT_MAX_STALE_MS = 10 * 60 * 1000;

export interface AgentOptions extends SyncDeps {
  intervalMs: number;
  maxStaleMs?: number;
  log?: (line: string) => void;
  now?: () => number;
}

/** Runs `syncOnce` on an interval (never overlapping) and remembers how it went. */
export class ExitAgent {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private readonly startedAt: number;
  private lastSuccessAt: number | null = null;
  private lastPeers: number | null = null;
  private failures = 0;
  private flushed = false;
  private readonly maxStaleMs: number;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(private readonly options: AgentOptions) {
    this.log = options.log ?? ((line) => console.log(`[tnp-exit] ${line}`));
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.maxStaleMs = options.maxStaleMs ?? DEFAULT_MAX_STALE_MS;
  }

  async tick(): Promise<void> {
    try {
      const stats = await syncOnce(this.options);
      this.lastSuccessAt = this.now();
      this.lastPeers = stats.peers;
      if (
        this.failures > 0 ||
        this.flushed ||
        stats.set > 0 ||
        stats.removed > 0 ||
        stats.rejected > 0
      ) {
        this.log(
          `synced: ${stats.peers} peers, ${stats.set} set, ${stats.removed} removed, ${stats.rejected} rejected`,
        );
      }
      this.failures = 0;
      this.flushed = false;
    } catch (err) {
      this.failures++;
      const since = this.lastSuccessAt ?? this.startedAt;
      const stopNow = err instanceof StopServingError;
      const stale = this.now() - since > this.maxStaleMs;
      if (stopNow || stale) {
        const why = stopNow
          ? (err as Error).message
          : `no successful sync for ${Math.round((this.now() - since) / 1000)} s`;
        try {
          const removed = await flushPeers(this.options);
          if (!this.flushed || removed > 0) {
            this.log(`stopped serving (${why}): removed ${removed} peers`);
          }
          this.flushed = true;
          this.lastPeers = 0;
        } catch (flushErr) {
          this.log(`could not remove peers (${why}): ${(flushErr as Error).message}`);
        }
        return;
      }
      // The message is ours (HTTP status, parse refusal, exit code), never a body or stderr.
      this.log(
        `sync failed (${this.failures} in a row), peers unchanged: ${(err as Error).message}`,
      );
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = async () => {
      await this.tick();
      if (!this.stopped) this.timer = setTimeout(loop, this.options.intervalMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  health(): AgentHealth {
    const age = this.lastSuccessAt === null ? null : (this.now() - this.lastSuccessAt) / 1000;
    const status = this.flushed
      ? 'flushed'
      : age === null
        ? 'starting'
        : age * 1000 <= this.options.intervalMs * 3 + 15_000
          ? 'ok'
          : 'stale';
    return {
      status,
      peers: this.lastPeers,
      lastSyncAgeSeconds: age === null ? null : Math.round(age),
      consecutiveFailures: this.failures,
    };
  }
}
