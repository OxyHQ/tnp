/**
 * The exit agent: keep `wg0`'s peers equal to the API's device list.
 *
 * Every round: fetch `GET /exit/peers`, read the interface's peers, apply the
 * difference. Failure is conservative — if the API cannot be reached, answers
 * anything but a well-formed 200, or `wg` prints something unexpected, the
 * round changes NOTHING and the peers already configured keep working. A
 * device is cut off only by the API saying so (its owner revoked it).
 *
 * Logs carry counts only — never a key, an address or anything else that
 * could tie a line to a device (privacy-model.md §4: exits keep aggregates).
 */

import { execFile } from 'node:child_process';
import { parseExitPeersResponse } from '@tnp/shared-types';
import { parseWgAllowedIps, planPeerChanges, wgSetCommands } from './reconcile.js';

export interface SyncDeps {
  /** The `/exit/peers` body, as parsed JSON. Throws on any transport or HTTP failure. */
  fetchPeers: () => Promise<unknown>;
  /** Run `wg` with an argument array; resolves to stdout. */
  runWg: (args: string[]) => Promise<string>;
  iface: string;
}

export interface SyncStats {
  peers: number;
  set: number;
  removed: number;
  rejected: number;
}

export async function syncOnce(deps: SyncDeps): Promise<SyncStats> {
  const parsed = parseExitPeersResponse(await deps.fetchPeers());
  if (!parsed.ok) throw new Error(`peer list refused: ${parsed.error}`);
  const actual = parseWgAllowedIps(await deps.runWg(['show', deps.iface, 'allowed-ips']));
  const changes = planPeerChanges(parsed.value.peers, actual);
  for (const args of wgSetCommands(deps.iface, changes)) await deps.runWg(args);
  return {
    peers: parsed.value.peers.length,
    set: changes.filter((c) => c.kind === 'set').length,
    removed: changes.filter((c) => c.kind === 'remove').length,
    rejected: parsed.value.rejected,
  };
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

/** `wg` through `execFile`: an argument array, no shell, bounded time and output. */
export function createWgRunner(bin: string): (args: string[]) => Promise<string> {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        {
          timeout: 15_000,
          maxBuffer: 32 * 1024 * 1024,
          env: { PATH: process.env.PATH ?? '/usr/bin:/usr/sbin' },
        },
        (err, stdout) => {
          // stderr is not included: it can echo a key back.
          if (err)
            reject(
              new Error(`wg ${args[0]} failed (${(err as NodeJS.ErrnoException).code ?? 'error'})`),
            );
          else resolve(stdout);
        },
      );
    });
}

export interface AgentHealth {
  status: 'ok' | 'starting' | 'stale';
  peers: number | null;
  lastSyncAgeSeconds: number | null;
  consecutiveFailures: number;
}

export interface AgentOptions extends SyncDeps {
  intervalMs: number;
  log?: (line: string) => void;
  now?: () => number;
}

/** Runs `syncOnce` on an interval (never overlapping) and remembers how it went. */
export class ExitAgent {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private lastSuccessAt: number | null = null;
  private lastPeers: number | null = null;
  private failures = 0;
  private readonly log: (line: string) => void;
  private readonly now: () => number;

  constructor(private readonly options: AgentOptions) {
    this.log = options.log ?? ((line) => console.log(`[tnp-exit] ${line}`));
    this.now = options.now ?? Date.now;
  }

  async tick(): Promise<void> {
    try {
      const stats = await syncOnce(this.options);
      this.lastSuccessAt = this.now();
      this.lastPeers = stats.peers;
      if (this.failures > 0 || stats.set > 0 || stats.removed > 0 || stats.rejected > 0) {
        this.log(
          `synced: ${stats.peers} peers, ${stats.set} set, ${stats.removed} removed, ${stats.rejected} rejected`,
        );
      }
      this.failures = 0;
    } catch (err) {
      this.failures++;
      // The message is ours (HTTP status, parse refusal, wg exit code), never a body or stderr.
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
    const status =
      age === null
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
