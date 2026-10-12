import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  advanceCap,
  BYTES_PER_GB,
  type CapState,
  capLevel,
  monthKey,
  nextMonthStart,
  parseCapState,
  TrafficCap,
  throttleRuleset,
  unthrottleRuleset,
} from './traffic-cap';

const OCT = new Date('2026-10-12T10:00:00Z');
const BOOT = 'a1b2c3d4-0000-4000-8000-000000000001';
const state = (over: Partial<CapState> = {}): CapState => ({
  month: '2026-10',
  bytes: 1000,
  lastRx: 500,
  lastTx: 300,
  bootId: BOOT,
  warned: false,
  ...over,
});

describe('accounting', () => {
  test('months are UTC calendar months', () => {
    expect(monthKey(new Date('2026-10-31T23:59:59Z'))).toBe('2026-10');
    expect(monthKey(new Date('2026-11-01T00:00:00Z'))).toBe('2026-11');
    expect(nextMonthStart(new Date('2026-12-15T00:00:00Z')).toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  test('adds both directions since the last reading', () => {
    const next = advanceCap(state(), { rx: 800, tx: 1300, bootId: BOOT }, OCT);
    expect(next).toEqual(state({ bytes: 1000 + 300 + 1000, lastRx: 800, lastTx: 1300 }));
  });

  test('after a reboot or a recreated interface the counters restart: all they show is new', () => {
    expect(advanceCap(state(), { rx: 40, tx: 60, bootId: 'other-boot' }, OCT).bytes).toBe(1100);
    expect(advanceCap(state(), { rx: 10, tx: 900, bootId: BOOT }, OCT).bytes).toBe(1910);
  });

  test('a new month starts from zero, keeping the counters, and re-arms the warning', () => {
    const next = advanceCap(
      state({ bytes: 5 * BYTES_PER_GB, warned: true }),
      { rx: 600, tx: 400, bootId: BOOT },
      new Date('2026-11-01T00:00:30Z'),
    );
    expect(next).toEqual({
      month: '2026-11',
      bytes: 200,
      lastRx: 600,
      lastTx: 400,
      bootId: BOOT,
      warned: false,
    });
  });

  test('first run counts from now; a corrupt state file starts again rather than throwing', () => {
    expect(advanceCap(null, { rx: 9e9, tx: 9e9, bootId: BOOT }, OCT).bytes).toBe(0);
    expect(parseCapState(null)).toBeNull();
    expect(parseCapState('{not json')).toBeNull();
    expect(parseCapState(JSON.stringify({ ...state(), bytes: -1 }))).toBeNull();
    expect(parseCapState(JSON.stringify({ ...state(), month: '2026-13' }))).toBeNull();
    expect(parseCapState(JSON.stringify(state()))).toEqual(state());
  });

  test('levels: ok below 80%, warn from 80%, capped at the cap', () => {
    const settings = { capBytes: 1000 };
    expect(capLevel(state({ bytes: 799 }), settings)).toBe('ok');
    expect(capLevel(state({ bytes: 800 }), settings)).toBe('warn');
    expect(capLevel(state({ bytes: 1000 }), settings)).toBe('capped');
  });
});

describe('the throttle', () => {
  test('is its own table, policing wg0 both ways to the configured rate', () => {
    expect(throttleRuleset('wg0', 2)).toBe(
      [
        'table inet tnp_exit_cap',
        'delete table inet tnp_exit_cap',
        'table inet tnp_exit_cap {',
        '  counter throttled {}',
        '  chain forward {',
        '    type filter hook forward priority filter + 10; policy accept;',
        '    iifname "wg0" limit rate over 250 kbytes/second burst 250 kbytes counter name throttled drop',
        '    oifname "wg0" limit rate over 250 kbytes/second burst 250 kbytes counter name throttled drop',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    expect(unthrottleRuleset()).toBe('table inet tnp_exit_cap\ndelete table inet tnp_exit_cap\n');
    expect(throttleRuleset('wg0', 2)).not.toContain('tnp_exit ');
    expect(() => throttleRuleset('wg0"; flush ruleset', 2)).toThrow();
    expect(() => throttleRuleset('wg0', 0)).toThrow();
    expect(() => throttleRuleset('wg0', 1.5)).toThrow();
  });
});

describe('TrafficCap', () => {
  function harness(initial: CapState | null, capBytes = 1000) {
    let saved: string | null = initial ? JSON.stringify(initial) : null;
    const scripts: string[] = [];
    const lines: string[] = [];
    let reading = { rx: initial?.lastRx ?? 0, tx: initial?.lastTx ?? 0, bootId: BOOT };
    let now = OCT;
    const make = () =>
      new TrafficCap({
        settings: { capBytes, throttleMbit: 2 },
        wgInterface: 'wg0',
        readCounters: () => reading,
        load: () => saved,
        save: (text) => {
          saved = text;
        },
        runNft: async (script) => {
          scripts.push(script);
        },
        now: () => now,
        log: (line) => lines.push(line),
      });
    return {
      make,
      scripts,
      lines,
      saved: () => parseCapState(saved),
      set: (rx: number, tx: number, at = now) => {
        reading = { rx, tx, bootId: BOOT };
        now = at;
      },
    };
  }

  test('warns once at 80%, throttles at the cap, lifts it when the month rolls over', async () => {
    const h = harness(state({ bytes: 0, lastRx: 0, lastTx: 0 }));
    const cap = h.make();
    expect(await cap.tick()).toBe('ok');
    expect(h.scripts).toEqual([unthrottleRuleset()]); // a stale throttle is never left behind
    h.set(500, 350);
    expect(await cap.tick()).toBe('warn');
    h.set(510, 360);
    expect(await cap.tick()).toBe('warn');
    expect(h.lines.filter((l) => l.includes('warning'))).toHaveLength(1);
    h.set(600, 400);
    expect(await cap.tick()).toBe('capped');
    expect(h.scripts.at(-1)).toBe(throttleRuleset('wg0', 2));
    h.set(700, 500);
    await cap.tick();
    expect(h.scripts).toHaveLength(2); // applied once, not every minute
    h.set(710, 500, new Date('2026-11-01T00:01:00Z'));
    expect(await cap.tick()).toBe('ok');
    expect(h.scripts.at(-1)).toBe(unthrottleRuleset());
    expect(h.saved()?.month).toBe('2026-11');
  });

  test('a restarted agent keeps counting from the persisted state and re-applies the throttle', async () => {
    const h = harness(state({ bytes: 990, lastRx: 100, lastTx: 100, warned: true }));
    h.set(105, 106); // 11 bytes while the agent was down
    const cap = h.make();
    expect(await cap.tick()).toBe('capped');
    expect(h.saved()?.bytes).toBe(1001);
    expect(h.scripts).toEqual([throttleRuleset('wg0', 2)]);
  });

  test('the state is saved before nft runs, so a failing nft never loses bytes', async () => {
    const h = harness(state({ bytes: 0, lastRx: 0, lastTx: 0 }));
    const cap = new TrafficCap({
      settings: { capBytes: 1000, throttleMbit: 2 },
      wgInterface: 'wg0',
      readCounters: () => ({ rx: 2000, tx: 0, bootId: BOOT }),
      load: () => JSON.stringify(state({ bytes: 0, lastRx: 0, lastTx: 0 })),
      save: (text) => h.lines.push(text),
      runNft: async () => {
        throw new Error('nft failed');
      },
      now: () => OCT,
      log: () => {},
    });
    await expect(cap.tick()).rejects.toThrow('nft failed');
    expect(parseCapState(h.lines[0] ?? null)?.bytes).toBe(2000);
  });
});

const probe = spawnSync('unshare', ['-rn', 'nft', '--version'], { encoding: 'utf8' });
describe.if(probe.status === 0)('nft accepts the throttle', () => {
  test('nft -c', () => {
    for (const script of [throttleRuleset('wg0', 2), unthrottleRuleset()]) {
      const check = spawnSync('unshare', ['-rn', 'nft', '-c', '-f', '-'], {
        input: script,
        encoding: 'utf8',
      });
      expect({ status: check.status, stderr: check.stderr }).toEqual({ status: 0, stderr: '' });
    }
  });
});
