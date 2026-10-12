import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateWireGuardKeyPair } from '@tnp/crypto/wireguard';
import type { VpnDeviceResponse } from '@tnp/shared-types';
import { type VpnCliApi, vpnAdd } from './vpn-cli';

const dir = mkdtempSync(join(tmpdir(), 'tnp-vpn-cli-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function api(): VpnCliApi {
  return {
    async registerVpnDevice(request): Promise<VpnDeviceResponse> {
      return {
        device: {
          id: crypto.randomUUID(),
          name: request.name,
          publicKey: request.publicKey,
          ipv4: '10.77.1.2',
          ipv6: 'fd85:d596:af02::a4d:102',
          createdAt: new Date().toISOString(),
        },
        network: {
          exits: [
            {
              id: 'usw2-1',
              region: 'us-west-2',
              endpoint: 'usw2-1.exit.example:51820',
              publicKey: generateWireGuardKeyPair().publicKey,
            },
          ],
          dns: ['198.51.100.53'],
          allowedIPs: ['0.0.0.0/0', '::/0'],
          maxDevices: 10,
        },
      };
    },
    async listVpnDevices() {
      throw new Error('unused');
    },
    async revokeVpnDevice() {},
  };
}

describe('tnp vpn add', () => {
  test('writes the config with mode 0600, never over an existing file, and does not print the key', async () => {
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

    await expect(
      vpnAdd(['phone'], { api: api(), token: 't', log: () => {}, cwd: dir }),
    ).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toContain(keys.privateKey);
  });

  test('--print shows the config; --exit picks an exit; an unknown exit is refused', async () => {
    const lines: string[] = [];
    await vpnAdd(['laptop', '--print', '--out', 'custom.conf'], {
      api: api(),
      token: 't',
      log: (line) => lines.push(line),
      cwd: dir,
    });
    expect(lines.join('\n')).toContain('[Interface]');
    await expect(
      vpnAdd(['desk', '--exit', 'nowhere'], { api: api(), token: 't', log: () => {}, cwd: dir }),
    ).rejects.toThrow('no exit named nowhere');
    await expect(vpnAdd([], { api: api(), token: 't', log: () => {}, cwd: dir })).rejects.toThrow(
      'usage',
    );
  });
});
