/**
 * The exit's monthly traffic cap (docs/architecture/exit-nodes.md §9.9): the
 * cost of an exit must never grow with its use.
 *
 * Lightsail bundles include a monthly data-transfer allowance that counts
 * bytes IN and OUT of the instance; beyond it, every GB is billed. So the
 * agent counts every byte on the uplink, both directions, per calendar month
 * (UTC), persisted across agent restarts and reboots, and when the month's
 * total reaches `TNP_EXIT_MONTHLY_CAP_GB` it throttles all forwarding through
 * `wg0` to `TNP_EXIT_THROTTLE_MBIT` until the month rolls over. At 80% it logs
 * a warning, once a month.
 *
 * The count is a total for the whole host — no per-peer, per-destination or
 * per-anything figure exists here (privacy-model.md: exits keep aggregates).
 *
 * Everything that decides is a pure function of (state, reading, time); the
 * class at the bottom only reads counters, persists and runs `nft`.
 */

import { execFile } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Decimal gigabytes, as AWS bills transfer. */
export const BYTES_PER_GB = 1_000_000_000;
/** The share of the cap at which a warning is logged. */
export const CAP_WARN_FRACTION = 0.8;
/** The nftables table the throttle lives in, apart from the packet filter's own. */
export const CAP_TABLE = 'tnp_exit_cap';

export interface CapSettings {
  /** Monthly total, in and out, in bytes. */
  capBytes: number;
  /** The forwarding rate once capped, in megabits per second, each direction. */
  throttleMbit: number;
}

/** What the agent keeps in `$STATE_DIRECTORY/traffic.json`. Counts only. */
export interface CapState {
  /** `YYYY-MM`, UTC. */
  month: string;
  /** Bytes counted this month, in + out. */
  bytes: number;
  /** The uplink counters at the last reading, to take the next difference from. */
  lastRx: number;
  lastTx: number;
  /** The kernel boot the counters belong to: after a reboot they restart at zero. */
  bootId: string;
  /** Whether this month's 80% warning was logged. */
  warned: boolean;
}

export interface CounterReading {
  rx: number;
  tx: number;
  bootId: string;
}

export type CapLevel = 'ok' | 'warn' | 'capped';

/** `YYYY-MM` of an instant, in UTC. */
export function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** A persisted state, or null when the file is absent, corrupt or from another shape. */
export function parseCapState(text: string | null): CapState | null {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (
    typeof r.month !== 'string' ||
    !MONTH_RE.test(r.month) ||
    !isCount(r.bytes) ||
    !isCount(r.lastRx) ||
    !isCount(r.lastTx) ||
    typeof r.bootId !== 'string' ||
    r.bootId.length > 64 ||
    typeof r.warned !== 'boolean'
  ) {
    return null;
  }
  return {
    month: r.month,
    bytes: r.bytes,
    lastRx: r.lastRx,
    lastTx: r.lastTx,
    bootId: r.bootId,
    warned: r.warned,
  };
}

/**
 * Fold one counter reading into the month's total.
 *
 * - Same boot, counters not lower: add the difference since the last reading.
 * - New boot, or counters lower (the interface was recreated): the counters
 *   restarted from zero, so everything they show now is new.
 * - A new month: start from zero, then add this reading's difference — bytes
 *   that straddle midnight are charged to the new month, which only ever
 *   errs towards counting more.
 * - No state (first run, or a corrupt file): start counting from now.
 *
 * Never loses a byte it saw: an agent restart resumes from the persisted
 * `lastRx`/`lastTx`, so traffic while it was down is counted at the next reading.
 */
export function advanceCap(state: CapState | null, reading: CounterReading, now: Date): CapState {
  const month = monthKey(now);
  if (state === null) {
    return {
      month,
      bytes: 0,
      lastRx: reading.rx,
      lastTx: reading.tx,
      bootId: reading.bootId,
      warned: false,
    };
  }
  const restarted =
    reading.bootId !== state.bootId || reading.rx < state.lastRx || reading.tx < state.lastTx;
  const delta = restarted
    ? reading.rx + reading.tx
    : reading.rx - state.lastRx + (reading.tx - state.lastTx);
  const sameMonth = state.month === month;
  return {
    month,
    bytes: (sameMonth ? state.bytes : 0) + delta,
    lastRx: reading.rx,
    lastTx: reading.tx,
    bootId: reading.bootId,
    warned: sameMonth ? state.warned : false,
  };
}

export function capLevel(state: CapState, settings: Pick<CapSettings, 'capBytes'>): CapLevel {
  if (state.bytes >= settings.capBytes) return 'capped';
  if (state.bytes >= settings.capBytes * CAP_WARN_FRACTION) return 'warn';
  return 'ok';
}

const IFACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$/;

/**
 * The throttle, as an `nft -f -` script: its own table, so applying or lifting
 * it never touches the packet filter. A policer on everything forwarded into
 * and out of `wg0`, all peers together — the exit's whole forwarding rate,
 * each direction, is held to `throttleMbit`. Idempotent (the table is
 * replaced whole).
 */
export function throttleRuleset(wgInterface: string, throttleMbit: number): string {
  if (!IFACE_RE.test(wgInterface)) throw new RangeError('invalid interface');
  if (!Number.isInteger(throttleMbit) || throttleMbit < 1 || throttleMbit > 10_000) {
    throw new RangeError('invalid throttle rate');
  }
  const kbytes = throttleMbit * 125; // 1 Mbit/s = 125 kbytes/s
  const wg = JSON.stringify(wgInterface);
  return [
    `table inet ${CAP_TABLE}`,
    `delete table inet ${CAP_TABLE}`,
    `table inet ${CAP_TABLE} {`,
    '  counter throttled {}',
    '  chain forward {',
    '    type filter hook forward priority filter + 10; policy accept;',
    `    iifname ${wg} limit rate over ${kbytes} kbytes/second burst ${kbytes} kbytes counter name throttled drop`,
    `    oifname ${wg} limit rate over ${kbytes} kbytes/second burst ${kbytes} kbytes counter name throttled drop`,
    '  }',
    '}',
    '',
  ].join('\n');
}

/** Lift the throttle: remove its table (and only it), whether or not it exists. */
export function unthrottleRuleset(): string {
  return [`table inet ${CAP_TABLE}`, `delete table inet ${CAP_TABLE}`, ''].join('\n');
}

/** Megabytes-free summary for logs: a share of the cap, never a per-anything figure. */
function share(state: CapState, capBytes: number): string {
  return `${Math.floor((state.bytes / capBytes) * 100)}% of the monthly cap (${(state.bytes / BYTES_PER_GB).toFixed(1)} of ${capBytes / BYTES_PER_GB} GB)`;
}

export interface TrafficCapDeps {
  settings: CapSettings;
  wgInterface: string;
  readCounters: () => CounterReading;
  load: () => string | null;
  save: (text: string) => void;
  /** Run `nft -f -` with this script on stdin. */
  runNft: (script: string) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
}

/** The loop: read, fold, persist, then throttle or lift on a change of level. */
export class TrafficCap {
  private state: CapState | null;
  /** What the kernel was last told; null until the first tick decides. */
  private throttled: boolean | null = null;

  constructor(private readonly deps: TrafficCapDeps) {
    this.state = parseCapState(deps.load());
  }

  get current(): CapState | null {
    return this.state;
  }

  async tick(): Promise<CapLevel> {
    const { settings, log = console.log } = this.deps;
    const now = (this.deps.now ?? (() => new Date()))();
    const next = advanceCap(this.state, this.deps.readCounters(), now);
    const level = capLevel(next, settings);
    if (level !== 'ok' && !next.warned) {
      log(`[tnp-exit] warning: uplink traffic is at ${share(next, settings.capBytes)}`);
      next.warned = true;
    }
    this.state = next;
    // Persisted before anything else can fail, so a crash never forgets bytes.
    this.deps.save(`${JSON.stringify(next)}\n`);

    const throttle = level === 'capped';
    if (throttle !== this.throttled) {
      await this.deps.runNft(
        throttle
          ? throttleRuleset(this.deps.wgInterface, settings.throttleMbit)
          : unthrottleRuleset(),
      );
      if (throttle) {
        log(
          `[tnp-exit] monthly cap reached (${share(next, settings.capBytes)}): forwarding throttled to ${settings.throttleMbit} Mbit/s until ${nextMonthStart(now).toISOString()}`,
        );
      } else if (this.throttled) {
        log('[tnp-exit] new month: throttle lifted');
      }
      this.throttled = throttle;
    }
    return level;
  }
}

/** The first instant of the next UTC month. */
export function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** The uplink's byte counters and the boot they belong to, from sysfs and procfs. */
export function sysfsCounters(uplink: string): () => CounterReading {
  if (!IFACE_RE.test(uplink)) throw new RangeError('invalid uplink interface');
  const read = (path: string) => readFileSync(path, 'utf8').trim();
  return () => {
    const rx = Number(read(`/sys/class/net/${uplink}/statistics/rx_bytes`));
    const tx = Number(read(`/sys/class/net/${uplink}/statistics/tx_bytes`));
    if (!isCount(rx) || !isCount(tx)) throw new Error('unreadable uplink counters');
    return { rx, tx, bootId: read('/proc/sys/kernel/random/boot_id') };
  };
}

/** Load and atomically save the state file in `dir`. */
export function stateFile(dir: string): Pick<TrafficCapDeps, 'load' | 'save'> {
  const path = join(dir, 'traffic.json');
  return {
    load: () => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return null;
      }
    },
    save: (text) => {
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

/** `nft -f -` with an argument array (no shell), the script on stdin. */
export function createNftRunner(nftBin: string): (script: string) => Promise<void> {
  return (script) =>
    new Promise((resolve, reject) => {
      const child = execFile(nftBin, ['-f', '-'], { timeout: 10_000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`nft failed: ${String(stderr).trim() || err.message}`));
        else resolve();
      });
      child.stdin?.end(script);
    });
}
