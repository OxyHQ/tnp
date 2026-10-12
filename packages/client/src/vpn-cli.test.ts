import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateWireGuardKeyPair } from '@tnp/crypto/wireguard';
import type { VpnDeviceResponse, VpnNetwork } from '@tnp/shared-types';
import { describeExits, type VpnCliApi, vpnAdd } from './vpn-cli';

const dir = mkdtempSync(join(tmpdir(), 'tnp-vpn-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NETWORK: VpnNetwork = {
  exits: [
    {
      id: 'usw2-1',
      region: 'us-west-2',
      endpoint: 'usw2-1.exit.example:51820',
      endpointIp: '203.0.113.10',
      publicKey: generateWireGuardKeyPair().publicKey,
    },
  ],
  dns: ['198.51.100.53'],
  allowedIPs: ['0.0.0.0/0', '::/0'],
  maxDevices: 10,
};

const TWO_EXITS: VpnNetwork = {
  ...NETWORK,
  exits: [
    ...NETWORK.exits,
    {
      id: 'euc1-1',
      region: 'eu-central-1',
      endpoint: 'euc1-1.exit.example:51820',
      endpointIp: '203.0.113.20',
      publicKey: generateWireGuardKeyPair().publicKey,
      dns: ['10.77.0.1'],
    },
  ],
};

function api(registered: string[] = [], network: VpnNetwork = NETWORK): VpnCliApi {
  return {
    async registerVpnDevice(request): Promise<VpnDeviceResponse> {
      registered.push(request.name);
      return {
        device: {
          id: crypto.randomUUID(),
          name: request.name,
          publicKey: request.publicKey,
          ipv4: '10.77.1.2',
          ipv6: 'fd85:d596:af02::a4d:102',
          createdAt: new Date().toISOString(),
        },
        network,
      };
    },
    async listVpnDevices() {
      return { devices: [], network };
    },
    async revokeVpnDevice() {},
  };
}

describe('tnp vpn add', () => {
  test('writes the config with mode 0600 and does not print the key', async () => {
    const keys = generateWireGuardKeyPair();
    const lines: string[] = [];
    const file = await vpnAdd(['phone'], {
      api: api(),
      token: 't',
      generate: () => keys,
      log: (line) => lines.push(line),
      cwd: dir,
    });
    expect(file).toBe(join(dir, 'tnp-phone.conf'));
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain(`PrivateKey = ${keys.privateKey}`);
    expect(lines.join('\n')).not.toContain(keys.privateKey);
    expect(lines.join('\n')).toContain('This is not anonymity');
  });

  test('an existing file or an unknown exit is refused BEFORE anything is registered', async () => {
    const registered: string[] = [];
    writeFileSync(join(dir, 'tnp-taken.conf'), 'mine');
    await expect(
      vpnAdd(['taken'], { api: api(registered), token: 't', log: () => {}, cwd: dir }),
    ).rejects.toThrow('already exists');
    expect(readFileSync(join(dir, 'tnp-taken.conf'), 'utf8')).toBe('mine');
    await expect(
      vpnAdd(['desk', '--exit', 'nowhere'], {
        api: api(registered),
        token: 't',
        log: () => {},
        cwd: dir,
      }),
    ).rejects.toThrow('no exit named nowhere (exits: usw2-1)');
    expect(registered).toEqual([]);
  });

  test('--print shows the config; --out names the file; a name is required', async () => {
    const lines: string[] = [];
    await vpnAdd(['laptop', '--print', '--out', 'custom.conf', '--exit', 'usw2-1'], {
      api: api(),
      token: 't',
      log: (line) => lines.push(line),
      cwd: dir,
    });
    expect(lines.join('\n')).toContain('[Interface]');
    expect(readFileSync(join(dir, 'custom.conf'), 'utf8')).toContain('[Peer]');
    await expect(vpnAdd([], { api: api(), token: 't', log: () => {}, cwd: dir })).rejects.toThrow(
      'usage',
    );
  });

  test("the config is for one exit and names that exit's resolver", async () => {
    const lines: string[] = [];
    const file = await vpnAdd(['eu', '--exit', 'euc1-1'], {
      api: api([], TWO_EXITS),
      token: 't',
      log: (line) => lines.push(line),
      cwd: dir,
    });
    const config = readFileSync(file, 'utf8');
    expect(config).toContain('DNS = 10.77.0.1\n');
    expect(config).toContain('Endpoint = euc1-1.exit.example:51820\n');
    expect(config).toContain('# TNP exit euc1-1 (eu-central-1)');
    expect(lines.join('\n')).toContain('exit euc1-1 (eu-central-1), DNS 10.77.0.1');

    // An exit without its own falls back to the network resolver.
    const us = readFileSync(
      await vpnAdd(['us', '--exit', 'usw2-1'], {
        api: api([], TWO_EXITS),
        token: 't',
        log: () => {},
        cwd: dir,
      }),
      'utf8',
    );
    expect(us).toContain('DNS = 198.51.100.53\n');
  });

  test('without --exit, the exit nearest the time zone, and the others are named', async () => {
    const lines: string[] = [];
    const file = await vpnAdd(['madrid'], {
      api: api([], TWO_EXITS),
      token: 't',
      log: (line) => lines.push(line),
      cwd: dir,
      timeZone: 'Europe/Madrid',
    });
    expect(readFileSync(file, 'utf8')).toContain('# TNP exit euc1-1 (eu-central-1)');
    expect(lines.join('\n')).toContain('other exits: usw2-1 (us-west-2)');
  });
});

describe('tnp vpn exits', () => {
  test('lists every exit with its region and resolver, marking the nearest', () => {
    const lines = describeExits(TWO_EXITS, 'Europe/Berlin');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^usw2-1 +us-west-2 +usw2-1\.exit\.example:51820 {2}DNS 198\.51\.100\.53$/,
    );
    expect(lines[1]).toContain('euc1-1');
    expect(lines[1]).toContain('eu-central-1');
    expect(lines[1]).toContain('DNS 10.77.0.1  (nearest your time zone)');
  });
});
