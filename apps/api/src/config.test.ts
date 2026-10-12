import { describe, expect, test } from 'bun:test';
import { spyOn } from 'bun:test';
import {
  parseExpiryEnforced,
  parseFlag,
  parseList,
  parseNonNegativeInt,
  relayDirectoryConfig,
} from './config.js';

describe('TNP_NATIVE_EXPIRY_ENFORCED', () => {
  test('is off unless explicitly true', () => {
    for (const value of [undefined, '', 'false', '0', '1', 'yes', 'on', 'enabled']) {
      expect(parseExpiryEnforced(value)).toBe(false);
    }
    for (const value of ['true', 'TRUE', ' true ']) {
      expect(parseExpiryEnforced(value)).toBe(true);
    }
  });
});

describe('list and number settings', () => {
  test('parseList splits on commas and whitespace and drops empties', () => {
    expect(parseList(undefined)).toEqual([]);
    expect(parseList('')).toEqual([]);
    expect(parseList(' a, b ,,c\nd ')).toEqual(['a', 'b', 'c', 'd']);
  });

  test('parseNonNegativeInt falls back on anything malformed', () => {
    expect(parseNonNegativeInt(undefined, 7)).toBe(7);
    expect(parseNonNegativeInt('', 7)).toBe(7);
    expect(parseNonNegativeInt('-1', 7)).toBe(7);
    expect(parseNonNegativeInt('1.5', 7)).toBe(7);
    expect(parseNonNegativeInt('abc', 7)).toBe(7);
    expect(parseNonNegativeInt('0', 7)).toBe(0);
    expect(parseNonNegativeInt(' 2 ', 7)).toBe(2);
  });
});

describe('parseFlag', () => {
  test('honours an explicit true or false and otherwise keeps the default', () => {
    expect(parseFlag('TRUE', false)).toBe(true);
    expect(parseFlag(' false ', true)).toBe(false);
    expect(parseFlag(undefined, true)).toBe(true);
    expect(parseFlag('yes', false)).toBe(false);
    expect(parseFlag('', true)).toBe(true);
  });
});

describe('relay directory configuration', () => {
  test('a malformed TNP_OXY_RELAYS refuses to start in production', () => {
    const quiet = spyOn(console, 'warn').mockImplementation(() => {});
    const loud = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        relayDirectoryConfig({ TNP_OXY_RELAYS: '[{"endpoint":"ws://x"}]' }, true),
      ).toThrow('refusing to start');
      // Outside production it is logged and lists no Oxy relay.
      expect(relayDirectoryConfig({ TNP_OXY_RELAYS: '{' }, false).oxyRelays).toEqual([]);
      // Unset is fine everywhere.
      expect(relayDirectoryConfig({}, true)).toEqual({ signer: null, oxyRelays: [] });
    } finally {
      quiet.mockRestore();
      loud.mockRestore();
    }
  });
});
