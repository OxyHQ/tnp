import { describe, expect, test } from 'bun:test';
import { resolveToken, TOKEN_FLAG_DEPRECATION } from './token';

const noStdin = async () => {
  throw new Error('stdin must not be read');
};

describe('resolveToken', () => {
  test('reads TNP_TOKEN without a warning', async () => {
    const r = await resolveToken({
      argv: ['serve'],
      env: { TNP_TOKEN: ' abc ' },
      readStdin: noStdin,
    });
    expect(r).toEqual({ ok: true, token: 'abc', source: 'env' });
  });

  test('--token-stdin wins over the environment', async () => {
    const r = await resolveToken({
      argv: ['serve', '--token-stdin'],
      env: { TNP_TOKEN: 'env' },
      readStdin: async () => 'from-stdin\n',
    });
    expect(r).toEqual({ ok: true, token: 'from-stdin', source: 'stdin' });
  });

  test('--token still works but always warns', async () => {
    const r = await resolveToken({
      argv: ['serve', '--token', 'xyz'],
      env: {},
      readStdin: noStdin,
    });
    expect(r).toEqual({ ok: true, token: 'xyz', source: 'flag', warning: TOKEN_FLAG_DEPRECATION });
    expect(TOKEN_FLAG_DEPRECATION).toContain('process list');
  });

  test('rejects an empty stdin and a flag without a value', async () => {
    const empty = await resolveToken({
      argv: ['--token-stdin'],
      env: {},
      readStdin: async () => '\n',
    });
    expect(empty.ok).toBe(false);
    const dangling = await resolveToken({
      argv: ['--token', '--domain'],
      env: {},
      readStdin: noStdin,
    });
    expect(dangling.ok).toBe(false);
  });

  test('reports no token when none is given', async () => {
    expect(await resolveToken({ argv: [], env: {}, readStdin: noStdin })).toEqual({
      ok: true,
      token: null,
    });
  });
});
