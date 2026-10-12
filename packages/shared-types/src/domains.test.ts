import { describe, expect, test } from 'bun:test';
import { parseUpdateDomainSettingsRequest, type UpdateDomainSettingsRequest } from './domains.js';

describe('parseUpdateDomainSettingsRequest', () => {
  test('accepts both values of unlisted', () => {
    for (const unlisted of [true, false]) {
      const request: UpdateDomainSettingsRequest = { unlisted };
      expect(parseUpdateDomainSettingsRequest(request)).toEqual({ ok: true, value: request });
    }
  });

  test('refuses anything that is not a boolean, rather than coercing it', () => {
    // `"false"` is truthy: coercing it would unlist a name whose owner asked
    // for the opposite.
    for (const unlisted of ['false', 'true', 0, 1, null, undefined]) {
      expect(parseUpdateDomainSettingsRequest({ unlisted })).toEqual({
        ok: false,
        error: 'unlisted must be a boolean',
      });
    }
  });

  test('drops fields outside the contract', () => {
    const parsed = parseUpdateDomainSettingsRequest({ unlisted: true, oxyUserId: 'someone' });
    expect(parsed).toEqual({ ok: true, value: { unlisted: true } });
  });

  test('rejects bodies that are not objects', () => {
    for (const body of [null, 'unlisted', [true]]) {
      expect(parseUpdateDomainSettingsRequest(body).ok).toBe(false);
    }
  });
});
