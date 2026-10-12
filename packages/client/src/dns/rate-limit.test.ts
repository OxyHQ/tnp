import { describe, expect, test } from 'bun:test';
import { readRateLimitExempt } from '../config';
import { admitUdpSource, parseSourceList, SourceRateLimiter, SourceSet } from './rate-limit';

describe('parseSourceList', () => {
  test('accepts addresses and CIDR prefixes, IPv4 and IPv6, comma or space separated', () => {
    const parsed = parseSourceList(' 203.0.113.7, 198.51.100.0/24 2600:1f14::/32,2001:db8::1 ');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.prefixes.length).toBe(4);
    expect(parseSourceList('')).toEqual({ ok: true, prefixes: [] });
    expect(parseSourceList(undefined)).toEqual({ ok: true, prefixes: [] });
  });

  test('refuses anything ambiguous or malformed, and names every bad entry', () => {
    expect(
      parseSourceList(
        '10.0.0.5/24,203.0.113.7,256.0.0.1,1.2.3,10.0.0.0/33,::/129,fe80::1%eth0,10.0.0.0/08,exit.example,10.0.0.0/,/8',
      ),
    ).toEqual({
      ok: false,
      invalid: [
        '10.0.0.5/24',
        '256.0.0.1',
        '1.2.3',
        '10.0.0.0/33',
        '::/129',
        'fe80::1%eth0',
        '10.0.0.0/08',
        'exit.example',
        '10.0.0.0/',
        '/8',
      ],
    });
  });
});

describe('SourceSet', () => {
  const set = new SourceSet(['203.0.113.7', '198.51.100.0/24', '2600:1f14:abc::/48']);

  test('matches exact addresses, prefixes and IPv4-mapped IPv6', () => {
    expect(set.has('203.0.113.7')).toBe(true);
    expect(set.has('::ffff:203.0.113.7')).toBe(true);
    expect(set.has('198.51.100.200')).toBe(true);
    expect(set.has('2600:1f14:abc:1::5')).toBe(true);
  });

  test('matches nothing else', () => {
    for (const other of ['203.0.113.8', '198.51.101.1', '2600:1f14:abd::1', '::1', 'garbage', '']) {
      expect(set.has(other)).toBe(false);
    }
    expect(new SourceSet().has('203.0.113.7')).toBe(false);
  });

  test('refuses invalid entries outright', () => {
    expect(() => new SourceSet(['10.0.0.5/24'])).toThrow('invalid source entries: 10.0.0.5/24');
  });
});

describe('admitUdpSource', () => {
  test('an exempt source is never throttled while others are', () => {
    const limiter = new SourceRateLimiter({ perSecond: 1, burst: 2, now: () => 0 });
    const exempt = new SourceSet(['203.0.113.7']);
    const exemptAnswers = Array.from({ length: 50 }, () =>
      admitUdpSource('203.0.113.7', limiter, exempt),
    );
    const otherAnswers = Array.from({ length: 5 }, () =>
      admitUdpSource('203.0.113.8', limiter, exempt),
    );
    expect(exemptAnswers.every(Boolean)).toBe(true);
    expect(otherAnswers).toEqual([true, true, false, false, false]);
    // Exempt queries spend no tokens and create no bucket.
    expect(limiter.size).toBe(1);
  });

  test('loopback is exempt; no limiter means no limit', () => {
    const limiter = new SourceRateLimiter({ perSecond: 1, burst: 1, now: () => 0 });
    const none = new SourceSet();
    expect([1, 2, 3].map(() => admitUdpSource('127.0.0.1', limiter, none))).toEqual([
      true,
      true,
      true,
    ]);
    expect([1, 2].map(() => admitUdpSource('203.0.113.9', null, none))).toEqual([true, true]);
  });
});

describe('readRateLimitExempt (TNP_DNS_RATE_LIMIT_EXEMPT)', () => {
  test('valid lists pass through in every environment', () => {
    expect(readRateLimitExempt('203.0.113.7, 198.51.100.0/24', true)).toEqual({
      ok: true,
      entries: ['203.0.113.7', '198.51.100.0/24'],
    });
    expect(readRateLimitExempt(undefined, true)).toEqual({ ok: true, entries: [] });
  });

  test('an invalid entry refuses startup in production', () => {
    const result = readRateLimitExempt('203.0.113.7,10.0.0.5/24', true);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('10.0.0.5/24');
  });

  test('outside production, invalid entries are dropped with a warning naming them', () => {
    const result = readRateLimitExempt('203.0.113.7,nonsense', false);
    expect(result).toEqual({
      ok: true,
      entries: ['203.0.113.7'],
      warning: expect.stringContaining('nonsense'),
    });
  });
});
