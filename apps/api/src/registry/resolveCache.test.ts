import { describe, expect, test } from 'bun:test';
import type { DnsResolveResponse } from '@tnp/shared-types';
import { ResolveCache } from './resolveCache.js';

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const answer = (ttl: number): DnsResolveResponse => ({
  name: 'nate.ox',
  type: 'A',
  answers: [{ name: 'nate.ox', type: 'A', value: '192.0.2.1', ttl }],
  rcode: 'NOERROR',
});
const nxdomain: DnsResolveResponse = { name: 'nope.ox', type: 'A', answers: [], rcode: 'NXDOMAIN' };

function cache(c = clock(), maxEntries = 100) {
  return new ResolveCache({ maxEntries, maxTtlSeconds: 30, negativeTtlSeconds: 10, now: c.now });
}

describe('ResolveCache', () => {
  test('serves an answer for its record TTL when that is under the cap', () => {
    const c = clock();
    const rc = cache(c);
    rc.set('nate.ox', 'A', answer(5));
    expect(rc.get('nate.ox', 'A')).toEqual(answer(5));
    c.advance(5001);
    expect(rc.get('nate.ox', 'A')).toBeUndefined();
  });

  test('never holds an answer longer than the cap, whatever its TTL', () => {
    const c = clock();
    const rc = cache(c);
    rc.set('nate.ox', 'A', answer(86_400));
    c.advance(29_000);
    expect(rc.get('nate.ox', 'A')).toBeDefined();
    c.advance(1_001);
    expect(rc.get('nate.ox', 'A')).toBeUndefined();
  });

  test('negative answers expire quickly, so a new registration resolves soon', () => {
    const c = clock();
    const rc = cache(c);
    rc.set('nope.ox', 'A', nxdomain);
    expect(rc.get('nope.ox', 'A')).toEqual(nxdomain);
    c.advance(10_001);
    expect(rc.get('nope.ox', 'A')).toBeUndefined();
  });

  test('answer TTLs count down while cached, never up', () => {
    const c = clock();
    const rc = cache(c);
    rc.set('nate.ox', 'A', answer(60));
    c.advance(12_300);
    expect(rc.get('nate.ox', 'A')?.answers[0]?.ttl).toBe(47);
    // The stored answer is not mutated.
    c.advance(1);
    expect(rc.get('nate.ox', 'A')?.answers[0]?.ttl).toBe(47);
  });

  test('an answer advertising a live node expires with that node', () => {
    const c = clock();
    const rc = cache(c);
    const withOverlay: DnsResolveResponse = {
      ...answer(3600),
      overlay: { serviceNodePubKey: 'k', relay: 'wss://relay.example.test', available: true },
    };
    // The node's heartbeat goes stale 5 s from now.
    rc.set('nate.ox', 'A', withOverlay, c.now() + 5_000);
    c.advance(4_999);
    expect(rc.get('nate.ox', 'A')?.overlay?.available).toBe(true);
    c.advance(2);
    expect(rc.get('nate.ox', 'A')).toBeUndefined();

    // Already stale: not cached at all.
    rc.set('nate.ox', 'A', withOverlay, c.now() - 1);
    expect(rc.get('nate.ox', 'A')).toBeUndefined();
  });

  test('keys by type as well as name', () => {
    const rc = cache();
    rc.set('nate.ox', 'A', answer(60));
    expect(rc.get('nate.ox', 'AAAA')).toBeUndefined();
  });

  test('is size-capped', () => {
    const rc = cache(clock(), 3);
    for (let i = 0; i < 50; i++) rc.set(`n${i}.ox`, 'A', answer(60));
    expect(rc.size).toBe(3);
    expect(rc.get('n49.ox', 'A')).toBeDefined();
    expect(rc.get('n0.ox', 'A')).toBeUndefined();
  });

  test('does not cache input that is not a DNS question', () => {
    const rc = cache();
    rc.set('x'.repeat(300), 'A', answer(60));
    rc.set('nate.ox', 'NOT A REAL TYPE', answer(60));
    expect(rc.size).toBe(0);
  });
});
