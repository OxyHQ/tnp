import { describe, expect, test } from 'bun:test';
import { AgentConfigError, readAgentConfig } from './config';

const TOKEN = 'Q3Jx9vT0bWk2LpZy8sNfA1cR7uHeGmYd4KoJiV5qXzB6wE_-tUaS0nlrPMDhCgIF';

describe('readAgentConfig', () => {
  test('defaults', () => {
    expect(readAgentConfig({ TNP_EXIT_TOKEN: TOKEN })).toEqual({
      apiUrl: 'https://api.tnp.network',
      token: TOKEN,
      iface: 'wg0',
      intervalMs: 20_000,
      healthPort: 9817,
      wgBin: '/usr/bin/wg',
      conntrackBin: '/usr/sbin/conntrack',
      maxStaleMs: 600_000,
    });
  });

  test('reads the token from the systemd credential when the env has none', () => {
    const paths: string[] = [];
    const config = readAgentConfig(
      { CREDENTIALS_DIRECTORY: '/run/credentials/tnp-exit-agent.service' },
      (path) => {
        paths.push(path);
        return `${TOKEN}\n`;
      },
    );
    expect(config.token).toBe(TOKEN);
    expect(paths).toEqual(['/run/credentials/tnp-exit-agent.service/exit-token']);
  });

  test('clamps the poll interval', () => {
    expect(readAgentConfig({ TNP_EXIT_TOKEN: TOKEN, TNP_EXIT_POLL_SECONDS: '1' }).intervalMs).toBe(
      5000,
    );
    expect(
      readAgentConfig({ TNP_EXIT_TOKEN: TOKEN, TNP_EXIT_POLL_SECONDS: '9999' }).intervalMs,
    ).toBe(300_000);
  });

  test('refuses what would weaken it', () => {
    const cases: Array<Record<string, string>> = [
      {},
      { TNP_EXIT_TOKEN: 'short' },
      { TNP_EXIT_TOKEN: 'k'.repeat(64) },
      { TNP_EXIT_TOKEN: TOKEN, TNP_EXIT_WG_BIN: 'wg' },
      { TNP_EXIT_TOKEN: TOKEN, TNP_EXIT_CONNTRACK_BIN: '../conntrack' },
      { TNP_EXIT_TOKEN: TOKEN, TNP_API_URL: 'http://api.tnp.network' },
      { TNP_EXIT_TOKEN: TOKEN, TNP_API_URL: 'https://user:pw@api.tnp.network' },
      { TNP_EXIT_TOKEN: TOKEN, TNP_API_URL: 'not a url' },
      { TNP_EXIT_TOKEN: TOKEN, TNP_EXIT_INTERFACE: '-wg0' },
      { TNP_EXIT_TOKEN: TOKEN, TNP_EXIT_HEALTH_PORT: '70000' },
      { TNP_EXIT_TOKEN: TOKEN, TNP_EXIT_WG_BIN: 'wg; reboot' },
    ];
    for (const env of cases) expect(() => readAgentConfig(env)).toThrow(AgentConfigError);
    expect(
      readAgentConfig({ TNP_EXIT_TOKEN: TOKEN, TNP_API_URL: 'http://127.0.0.1:4170' }).apiUrl,
    ).toBe('http://127.0.0.1:4170');
  });

  test('a token is never part of an error message', () => {
    try {
      readAgentConfig({ TNP_EXIT_TOKEN: 'tooshort-but-secret' });
    } catch (err) {
      expect((err as Error).message).not.toContain('tooshort-but-secret');
    }
  });
});
