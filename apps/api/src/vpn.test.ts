import { describe, expect, test } from 'bun:test';
import { timingSafeEqual } from 'node:crypto';
import { generateWireGuardKeyPair } from '@tnp/crypto/wireguard';
import { digestToken, exitTokenMatches, readVpnConfig, vpnAllowsUser, vpnNetwork } from './vpn';

const EXIT = {
  id: 'usw2-1',
  region: 'us-west-2',
  endpoint: 'usw2-1.exit.example:51820',
  endpointIp: '203.0.113.10',
  publicKey: generateWireGuardKeyPair().publicKey,
};
const TOKEN_A = 'Q3Jx9vT0bWk2LpZy8sNfA1cR7uHeGmYd4KoJiV5qXzB6wE_-tUaS0nlrPMDhCgIF';
const TOKEN_B = 'zR8kP2mWq5Xv0LtYb7NcHs3Jd9GfE1aUo6Ki4ZyTe_-wQrBnMxVpSgCjDlhAIOuF';

const env = (over: Record<string, string | undefined> = {}) => ({
  TNP_VPN_EXITS: JSON.stringify([EXIT]),
  TNP_VPN_DNS: '198.51.100.53',
  TNP_EXIT_TOKENS: `${TOKEN_A},${TOKEN_B}`,
  ...over,
});

describe('readVpnConfig', () => {
  test('off, silently, when TNP_VPN_EXITS is unset', () => {
    expect(readVpnConfig({})).toEqual({ config: null, warnings: [] });
    expect(readVpnConfig({ TNP_VPN_EXITS: '  ' })).toEqual({ config: null, warnings: [] });
  });

  test('on with exits, resolvers and token digests', () => {
    const { config, warnings } = readVpnConfig(env());
    expect(warnings).toEqual([]);
    expect(config?.exits).toEqual([EXIT]);
    expect(config?.dns).toEqual(['198.51.100.53']);
    expect(config?.exitTokenDigests).toEqual([digestToken(TOKEN_A), digestToken(TOKEN_B)]);
    expect(config?.maxDevices).toBe(10);
    expect(config && vpnNetwork(config)).toEqual({
      exits: [EXIT],
      dns: ['198.51.100.53'],
      allowedIPs: ['0.0.0.0/0', '::/0'],
      maxDevices: 10,
    });
  });

  test("an exit's own dns is served with it; the network list stays the fallback", () => {
    const euc1 = {
      ...EXIT,
      id: 'euc1-1',
      region: 'eu-central-1',
      endpoint: 'euc1-1.exit.example:51820',
      endpointIp: '203.0.113.20',
      publicKey: generateWireGuardKeyPair().publicKey,
      dns: '10.77.0.1',
    };
    const { config, warnings } = readVpnConfig(
      env({ TNP_VPN_EXITS: JSON.stringify([EXIT, euc1]) }),
    );
    expect(warnings).toEqual([]);
    const network = config && vpnNetwork(config);
    expect(network?.exits).toEqual([EXIT, { ...euc1, dns: ['10.77.0.1'] }]);
    expect(network?.dns).toEqual(['198.51.100.53']);
    expect(network?.exits[0]).not.toHaveProperty('dns');
    const bad = readVpnConfig(
      env({ TNP_VPN_EXITS: JSON.stringify([{ ...euc1, dns: 'resolver.example' }]) }),
    );
    expect(bad.config).toBeNull();
    expect(bad.warnings[0]).toContain('TNP_VPN_EXITS[0].dns');
  });

  test('TNP_VPN_ALLOWED_USERS: who may use it; unset in production means off for everyone', () => {
    expect(readVpnConfig(env()).config?.allowedUsers).toBeNull();
    expect(
      readVpnConfig(env({ TNP_VPN_ALLOWED_USERS: 'u1, 65f0c0ffee0123456789abcd,u1' })).config
        ?.allowedUsers,
    ).toEqual(['u1', '65f0c0ffee0123456789abcd']);
    const prod = readVpnConfig(env({ NODE_ENV: 'production' }));
    expect(prod.config).toBeNull();
    expect(prod.warnings[0]).toContain('TNP_VPN_ALLOWED_USERS is not set');
    expect(
      readVpnConfig(env({ NODE_ENV: 'production', TNP_VPN_ALLOWED_USERS: 'u1' })).config
        ?.allowedUsers,
    ).toEqual(['u1']);
    const bad = readVpnConfig(env({ TNP_VPN_ALLOWED_USERS: 'u1,not an id;' }));
    expect(bad.config).toBeNull();
    const config = readVpnConfig(env({ TNP_VPN_ALLOWED_USERS: 'u1' })).config;
    if (!config) throw new Error('off');
    expect(vpnAllowsUser(config, 'u1')).toBe(true);
    expect(vpnAllowsUser(config, 'u2')).toBe(false);
    expect(vpnAllowsUser({ allowedUsers: null }, 'anyone')).toBe(true);
  });

  test('the resolver defaults to TNP_PARKING_IP, and without one the VPN stays off', () => {
    expect(
      readVpnConfig(env({ TNP_VPN_DNS: undefined, TNP_PARKING_IP: '203.0.113.53' })).config?.dns,
    ).toEqual(['203.0.113.53']);
    const none = readVpnConfig(env({ TNP_VPN_DNS: undefined }));
    expect(none.config).toBeNull();
    expect(none.warnings[0]).toContain('names a resolver');
  });

  test('any malformed value turns the VPN off with a warning, never a throw', () => {
    const cases: Array<Record<string, string | undefined>> = [
      { TNP_VPN_EXITS: '{not json' },
      { TNP_VPN_EXITS: '[]' },
      { TNP_VPN_EXITS: JSON.stringify({ ...EXIT }) },
      { TNP_VPN_EXITS: JSON.stringify([{ ...EXIT, publicKey: 'AAAA' }]) },
      { TNP_VPN_EXITS: JSON.stringify([{ ...EXIT, endpoint: 'exit.example' }]) },
      { TNP_VPN_EXITS: JSON.stringify([EXIT, EXIT]) },
      { TNP_VPN_DNS: 'resolver.example' },
    ];
    for (const over of cases) {
      const result = readVpnConfig(env(over));
      expect(result.config).toBeNull();
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toStartWith('VPN disabled: ');
    }
  });

  test('weak tokens are ignored and counted, and their text is never echoed', () => {
    const { config, warnings } = readVpnConfig(
      env({ TNP_EXIT_TOKENS: `short-secret,${'a'.repeat(64)},${TOKEN_A}` }),
    );
    expect(config?.exitTokenDigests).toEqual([digestToken(TOKEN_A)]);
    expect(warnings.join(' ')).toContain('ignored 2 TNP_EXIT_TOKENS entries');
    expect(warnings.join(' ')).not.toContain('short-secret');
    const none = readVpnConfig(env({ TNP_EXIT_TOKENS: '' }));
    expect(none.config?.exitTokenDigests).toEqual([]);
    expect(none.warnings.join(' ')).toContain('no exit can fetch its peers');
  });
});

describe('exitTokenMatches', () => {
  const digests = [digestToken(TOKEN_A), digestToken(TOKEN_B)];

  test('accepts each configured token and nothing else', () => {
    expect(exitTokenMatches(`Bearer ${TOKEN_A}`, digests)).toBe(true);
    expect(exitTokenMatches(`Bearer ${TOKEN_B}`, digests)).toBe(true);
    for (const header of [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      TOKEN_A,
      `bearer ${TOKEN_A}`,
      `Basic ${TOKEN_A}`,
      `Bearer ${TOKEN_A.slice(1)}`,
      `Bearer ${TOKEN_A}a`,
      `Bearer ${TOKEN_A} `,
      `Bearer ${'c'.repeat(64)}`,
    ]) {
      expect(exitTokenMatches(header, digests)).toBe(false);
    }
  });

  test('with no configured token, nobody is accepted — not even an empty one', () => {
    expect(exitTokenMatches('Bearer ', [])).toBe(false);
    expect(exitTokenMatches(`Bearer ${TOKEN_A}`, [])).toBe(false);
  });

  test('compares against every digest, equal-length, whichever matches or none', () => {
    for (const header of [`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_B}`, 'Bearer wrong', undefined]) {
      const calls: Array<[number, number]> = [];
      exitTokenMatches(header, digests, (a, b) => {
        calls.push([a.length, b.length]);
        return timingSafeEqual(a, b);
      });
      expect(calls).toEqual([
        [32, 32],
        [32, 32],
      ]);
    }
  });
});
