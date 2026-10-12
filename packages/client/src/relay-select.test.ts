import { describe, expect, test } from 'bun:test';
import type { RelayDirectoryEntry } from '@tnp/shared-types';
import { NO_AUTOMATIC_RELAY_MESSAGE, selectAutomaticRelay } from './relay-select';

function entry(endpoint: string, operator: 'oxy' | 'community'): RelayDirectoryEntry {
  return {
    endpoint,
    publicKey: 'Zm9vYmFyLXB1YmxpYy1rZXk=',
    operator,
    location: '',
    status: 'active',
  };
}

describe('selectAutomaticRelay', () => {
  test('never picks a community relay, even when it is listed first', () => {
    expect(
      selectAutomaticRelay([
        entry('wss://attacker.example.test', 'community'),
        entry('wss://oxy.example.test', 'oxy'),
      ]),
    ).toEqual({ ok: true, endpoint: 'wss://oxy.example.test' });
  });

  test('refuses rather than falling back when only community relays exist', () => {
    expect(selectAutomaticRelay([entry('wss://community.example.test', 'community')])).toEqual({
      ok: false,
      message: NO_AUTOMATIC_RELAY_MESSAGE,
    });
    expect(selectAutomaticRelay([])).toEqual({ ok: false, message: NO_AUTOMATIC_RELAY_MESSAGE });
  });

  test('skips an Oxy entry an older registry would still have listed: ws:// or a private host', () => {
    expect(
      selectAutomaticRelay([
        entry('ws://oxy.example.test', 'oxy'),
        entry('wss://127.0.0.1', 'oxy'),
        entry('wss://oxy2.example.test', 'oxy'),
      ]),
    ).toEqual({ ok: true, endpoint: 'wss://oxy2.example.test' });
  });

  test('the refusal says why and what to do', () => {
    expect(NO_AUTOMATIC_RELAY_MESSAGE).toContain('--relay');
    expect(NO_AUTOMATIC_RELAY_MESSAGE).toContain('Community relays are never selected');
  });
});
