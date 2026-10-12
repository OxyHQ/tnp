import { describe, expect, test } from 'bun:test';
import { TokenBucketLimiter } from './rateLimit.js';

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('TokenBucketLimiter', () => {
  test('allows a burst of `capacity`, then refuses with a Retry-After', () => {
    const c = clock();
    const limiter = new TokenBucketLimiter({
      capacity: 3,
      refillPerSecond: 1,
      maxKeys: 10,
      now: c.now,
    });
    for (let i = 0; i < 3; i++) expect(limiter.take('a')).toEqual({ ok: true });
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterSeconds: 1 });
  });

  test('refills at the sustained rate and never above capacity', () => {
    const c = clock();
    const limiter = new TokenBucketLimiter({
      capacity: 2,
      refillPerSecond: 0.5,
      maxKeys: 10,
      now: c.now,
    });
    limiter.take('a');
    limiter.take('a');
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterSeconds: 2 });
    c.advance(2000);
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);

    // A long idle period refills to capacity, not beyond it.
    c.advance(3_600_000);
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);
  });

  test('keys are independent', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSecond: 1, maxKeys: 10 });
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);
    expect(limiter.take('b').ok).toBe(true);
  });

  test('holds at most maxKeys buckets, evicting the least recently used', () => {
    const c = clock();
    const limiter = new TokenBucketLimiter({
      capacity: 1,
      refillPerSecond: 0.001,
      maxKeys: 3,
      now: c.now,
    });
    for (const key of ['a', 'b', 'c']) limiter.take(key);
    // Touch `a`, so `b` is now the least recently used.
    expect(limiter.take('a').ok).toBe(false);
    for (let i = 0; i < 1000; i++) limiter.take(`flood-${i}`);
    expect(limiter.size).toBe(3);
  });

  test('rejects a configuration that would never allow anything', () => {
    expect(() => new TokenBucketLimiter({ capacity: 0, refillPerSecond: 1, maxKeys: 1 })).toThrow();
    expect(() => new TokenBucketLimiter({ capacity: 1, refillPerSecond: 0, maxKeys: 1 })).toThrow();
  });
});
