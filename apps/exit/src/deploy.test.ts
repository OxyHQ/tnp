/**
 * Drift guards for `deploy/`: the shell and unit files repeat a few facts the
 * TypeScript owns (tunnel addresses, port, Bun version, install paths). A
 * change on one side without the other is a test failure here, not a broken
 * exit after the next deploy.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VPN_EXIT_TUNNEL_IPV4, VPN_EXIT_TUNNEL_IPV6, VPN_WIREGUARD_PORT } from '@tnp/shared-types';

const deploy = join(import.meta.dir, '..', 'deploy');
const read = (name: string) => readFileSync(join(deploy, name), 'utf8');
const wgUp = read('wg-up.sh');
const bootstrap = read('bootstrap.sh');
const agentUnit = read('tnp-exit-agent.service');
const wgUnit = read('tnp-exit-wg.service');

describe('deploy files agree with the code', () => {
  test('wg-up.sh uses the exit tunnel addresses and port from @tnp/shared-types', () => {
    expect(wgUp).toContain(`ADDR4=${VPN_EXIT_TUNNEL_IPV4}/16`);
    expect(wgUp).toContain(`ADDR6=${VPN_EXIT_TUNNEL_IPV6}/64`);
    expect(wgUp).toContain(`PORT=${VPN_WIREGUARD_PORT}`);
  });

  test('bootstrap pins the same Bun as the repository, with a checksum', () => {
    const root = JSON.parse(
      readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf8'),
    ) as {
      packageManager: string;
    };
    expect(bootstrap).toContain(`BUN_VERSION=${root.packageManager.replace('bun@', '')}`);
    expect(bootstrap).toMatch(/BUN_SHA256=[0-9a-f]{64}\n/);
    expect(bootstrap).toContain('sha256sum -c -');
  });

  test('units run what bootstrap installs, the agent unprivileged with CAP_NET_ADMIN only', () => {
    expect(bootstrap).toContain('ROOT=/opt/tnp-exit');
    expect(agentUnit).toContain(
      'ExecStart=/opt/tnp-exit/bin/bun --no-install /opt/tnp-exit/src/apps/exit/src/index.ts',
    );
    expect(agentUnit).toContain('User=tnp-exit');
    expect(agentUnit).toContain('CapabilityBoundingSet=CAP_NET_ADMIN\n');
    expect(agentUnit).toContain('LoadCredential=exit-token:/run/tnp-exit/agent-token');
    expect(wgUnit).toContain('ExecStart=/opt/tnp-exit/src/apps/exit/deploy/wg-up.sh');
    expect(wgUnit).toContain('Requires=nftables.service');
  });

  test('secrets come from SSM at boot and are never written outside /run', () => {
    expect(wgUp).toContain('--with-decryption');
    expect(wgUp).toContain('RUN=/run/tnp-exit');
    expect(wgUp).toMatch(/rm -f "\$KEY"\n/);
    expect(bootstrap).not.toMatch(/get-parameter/);
    expect(bootstrap).toContain('Storage=volatile');
  });

  test('the ruleset is checked before it is loaded, and before forwarding is on', () => {
    expect(bootstrap.indexOf('nft -c -f')).toBeLessThan(
      bootstrap.indexOf('systemctl restart nftables'),
    );
    expect(bootstrap.indexOf('systemctl restart nftables')).toBeLessThan(
      bootstrap.indexOf('sysctl --system'),
    );
  });

  test('the shell scripts parse', () => {
    expect(spawnSync('bash', ['-n', join(deploy, 'bootstrap.sh')]).status).toBe(0);
    expect(spawnSync('sh', ['-n', join(deploy, 'wg-up.sh')]).status).toBe(0);
  });
});
