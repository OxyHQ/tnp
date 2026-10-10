import { describe, expect, test } from 'bun:test';
import { parseDecimalInt, parseLocalTarget, parsePort } from './parse-input';

describe('parseDecimalInt', () => {
  test('accepts digits only, trimmed', () => {
    expect(parseDecimalInt('0')).toBe(0);
    expect(parseDecimalInt(' 8080 ')).toBe(8080);
  });

  test('rejects what parseInt would have truncated or coerced', () => {
    for (const bad of [
      '8O80',
      '3000abc',
      '8.5',
      '1e3',
      '0x50',
      '-1',
      '+5',
      '',
      ' ',
      '9'.repeat(20),
    ]) {
      expect(parseDecimalInt(bad)).toBeNull();
    }
  });
});

describe('parsePort', () => {
  test('bounds', () => {
    expect(parsePort('1')).toBe(1);
    expect(parsePort('65535')).toBe(65535);
    expect(parsePort('0')).toBeNull();
    expect(parsePort('65536')).toBeNull();
  });
});

describe('parseLocalTarget', () => {
  test('host only defaults to port 80', () => {
    expect(parseLocalTarget('localhost')).toEqual({ host: 'localhost', port: 80 });
  });

  test('host:port', () => {
    expect(parseLocalTarget('127.0.0.1:3000')).toEqual({ host: '127.0.0.1', port: 3000 });
  });

  test('bracketed IPv6, with and without a port, unbracketed for net.connect', () => {
    expect(parseLocalTarget('[::1]:8080')).toEqual({ host: '::1', port: 8080 });
    expect(parseLocalTarget('[::1]')).toEqual({ host: '::1', port: 80 });
  });

  test('an invalid explicit port throws instead of falling back to 80', () => {
    // These used to forward to port 8, 80, 80 and 3000 respectively.
    for (const bad of ['localhost:8O80', 'localhost:abc', 'localhost:', 'localhost:3000abc']) {
      expect(() => parseLocalTarget(bad)).toThrow(/port must be 1-65535/);
    }
    expect(() => parseLocalTarget('localhost:70000')).toThrow(/port must be 1-65535/);
  });

  test('malformed targets throw', () => {
    expect(() => parseLocalTarget('')).toThrow(/empty/);
    expect(() => parseLocalTarget(':8080')).toThrow(/missing host/);
    expect(() => parseLocalTarget('::1')).toThrow(/brackets/);
    expect(() => parseLocalTarget('[::1')).toThrow(/missing "]"/);
    expect(() => parseLocalTarget('[::1]8080')).toThrow(/":port"/);
  });
});
