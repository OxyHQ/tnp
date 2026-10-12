/**
 * Drift guards for `deploy/`: the shell and unit files repeat a few facts the
 * TypeScript owns (tunnel addresses, port, Bun version, install paths). A
 * change on one side without the other is a test failure here, not a broken
 * exit after the next deploy. The shell functions (distribution detection,
 * uplink discovery, the on-disk secrets check) are run for real, sourced into
 * a fresh shell.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VPN_EXIT_TUNNEL_IPV4, VPN_EXIT_TUNNEL_IPV6, VPN_WIREGUARD_PORT } from '@tnp/shared-types';

const deploy = join(import.meta.dir, '..', 'deploy');
const read = (name: string) => readFileSync(join(deploy, name), 'utf8');
const wgUp = read('wg-up.sh');
const bootstrap = read('bootstrap.sh');
const agentUnit = read('tnp-exit-agent.service');
const wgUnit = read('tnp-exit-wg.service');
const dnsUnit = read('tnp-exit-dns.service');

/** Run a function defined in a deploy script, sourced into a fresh shell. */
function call(shell: 'bash' | 'sh', script: string, fn: string, args: string[], input?: string) {
  return spawnSync(shell, ['-c', `. "$0"; ${fn} "$@"`, join(deploy, script), ...args], {
    encoding: 'utf8',
    input,
  });
}

describe('deploy files agree with the code', () => {
  test('wg-up.sh uses the exit tunnel addresses and port from @tnp/shared-types', () => {
    expect(wgUp).toContain(`ADDR4=${VPN_EXIT_TUNNEL_IPV4}/16`);
    expect(wgUp).toContain(`ADDR6=${VPN_EXIT_TUNNEL_IPV6}/64`);
    expect(wgUp).toContain(`PORT=${VPN_WIREGUARD_PORT}`);
  });

  test('bootstrap pins the same Bun as the repository, with a checksum per architecture', () => {
    const root = JSON.parse(
      readFileSync(join(import.meta.dir, '..', '..', '..', 'package.json'), 'utf8'),
    ) as {
      packageManager: string;
    };
    expect(bootstrap).toContain(`BUN_VERSION=${root.packageManager.replace('bun@', '')}`);
    expect(bootstrap).toMatch(/BUN_SHA256_AARCH64=[0-9a-f]{64}\n/);
    expect(bootstrap).toMatch(/BUN_SHA256_X64=[0-9a-f]{64}\n/);
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

  test('secrets come from SSM (or the checked secrets directory) and pass through /run only', () => {
    expect(wgUp).toContain('--with-decryption');
    expect(wgUp).toContain('RUN=/run/tnp-exit');
    expect(wgUp).toMatch(/rm -f "\$KEY"\n/);
    expect(bootstrap).not.toMatch(/get-parameter/);
    expect(bootstrap).toContain('Storage=volatile');
    // File mode: checked before a byte is read; the key reaches wg via the /run copy.
    const check = wgUp.indexOf('check_file_secrets "$TNP_EXIT_SECRETS_DIR" 0');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(wgUp.indexOf('cat "$TNP_EXIT_SECRETS_DIR/wg-private-key" >"$KEY"'));
    expect(wgUp).toContain('wg set "$IFACE" listen-port "$PORT" private-key "$KEY"');
    expect(bootstrap).toContain('check_file_secrets "$TNP_EXIT_SECRETS_DIR" 0');
  });

  test('the ruleset is checked before it is loaded', () => {
    expect(bootstrap.indexOf('nft -c -f')).toBeLessThan(
      bootstrap.indexOf('systemctl restart nftables'),
    );
  });

  test('forwarding is never enabled at boot by sysctl.d, only by wg-up.sh after the filter check', () => {
    expect(bootstrap).not.toMatch(/ip_forward\s*=\s*1/);
    expect(bootstrap).not.toMatch(/all\.forwarding\s*=\s*1/);
    const check = wgUp.indexOf('nft list table inet tnp_exit');
    const on = wgUp.indexOf('forwarding 1');
    expect(check).toBeGreaterThan(-1);
    expect(wgUp.indexOf('forwarding 0')).toBeLessThan(check);
    expect(check).toBeLessThan(on);
    expect(wgUp.indexOf('wg set')).toBeLessThan(on);
    // Turned off again on failure and on stop.
    expect(wgUp).toMatch(/cleanup\(\) \{[\s\S]*forwarding 0/);
    expect(wgUnit).toContain('ExecStop=/usr/sbin/sysctl -q -w net.ipv4.ip_forward=0');
  });

  test('conntrack state is short-lived and removable', () => {
    expect(bootstrap).toContain('conntrack-tools');
    expect(bootstrap).toMatch(/apt-get install .* conntrack /);
    expect(wgUp).toContain('nf_conntrack_tcp_timeout_established=3600');
  });

  test('the agent cannot reach the metadata service and runs under a syscall filter', () => {
    expect(agentUnit).toContain('IPAddressDeny=169.254.169.254/32 fd00:ec2::254/128');
    expect(agentUnit).toContain('SystemCallFilter=@system-service');
    // The traffic count survives restarts, writable by the agent only.
    expect(agentUnit).toContain('StateDirectory=tnp-exit\nStateDirectoryMode=0700\n');
    expect(bootstrap).toContain('TNP_EXIT_UPLINK=$UPLINK');
    expect(bootstrap).toContain('TNP_EXIT_MONTHLY_CAP_GB=$TNP_EXIT_MONTHLY_CAP_GB');
  });

  test('with SSM, bootstrap refuses an instance where IMDSv1 still answers', () => {
    const probe = bootstrap.indexOf(
      'curl -fsS -m 3 -o /dev/null http://169.254.169.254/latest/meta-data/',
    );
    expect(probe).toBeGreaterThan(-1);
    const refusal = bootstrap.indexOf('die "IMDSv1 answers on this instance');
    expect(probe).toBeLessThan(refusal);
    expect(refusal).toBeLessThan(bootstrap.indexOf('AWS_REGION=$(imds'));
    // ... inside the ssm branch only: without an instance role (file) it is a note.
    const ssm = bootstrap.indexOf('if [ "$TNP_EXIT_SECRETS" = ssm ]; then\n  # IMDSv2');
    expect(ssm).toBeGreaterThan(-1);
    expect(ssm).toBeLessThan(refusal);
  });

  test('the agent token must be at least 43 base64url characters at boot', () => {
    expect(wgUp).toContain("grep -Eqx '[A-Za-z0-9_-]{43,512}'");
  });

  test('the shell scripts parse', () => {
    expect(spawnSync('bash', ['-n', join(deploy, 'bootstrap.sh')]).status).toBe(0);
    expect(spawnSync('sh', ['-n', join(deploy, 'wg-up.sh')]).status).toBe(0);
    expect(spawnSync('sh', ['-n', join(deploy, 'secrets.sh')]).status).toBe(0);
  });
});

describe('the exit resolver (tnp-exit-dns)', () => {
  test('binds the tunnel gateway address on port 53, and nothing else', () => {
    expect(dnsUnit).toContain(`Environment=TNP_LISTEN_ADDR=${VPN_EXIT_TUNNEL_IPV4}\n`);
    expect(dnsUnit).toContain('Environment=TNP_LISTEN_PORT=53\n');
    expect(bootstrap).toContain(`GATEWAY4=${VPN_EXIT_TUNNEL_IPV4}\n`);
    expect(bootstrap).toContain('--local-dns "$GATEWAY4"');
  });

  test('runs the public resolver code, unprivileged, with CAP_NET_BIND_SERVICE only', () => {
    expect(dnsUnit).toContain(
      'ExecStart=/opt/tnp-exit/bin/bun --no-install /opt/tnp-exit/src/apps/dns-server/src/index.ts',
    );
    expect(dnsUnit).toContain('User=tnp-exit-dns\n');
    expect(dnsUnit).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE\n');
    expect(dnsUnit).toContain('CapabilityBoundingSet=CAP_NET_BIND_SERVICE\n');
    expect(dnsUnit).toContain('NoNewPrivileges=yes');
    expect(dnsUnit).toContain('ProtectSystem=strict');
    expect(dnsUnit).toContain('IPAddressDeny=169.254.169.254/32 fd00:ec2::254/128');
    expect(dnsUnit).toContain('SystemCallFilter=@system-service');
    expect(dnsUnit).toContain('StateDirectory=tnp-exit-dns\n');
    expect(dnsUnit).toContain('Environment=TNP_TLD_CACHE_PATH=/var/lib/tnp-exit-dns/tlds.json');
    expect(dnsUnit).toContain('Environment=NODE_ENV=production');
    expect(bootstrap).toContain(
      'useradd --system --no-create-home --shell /usr/sbin/nologin tnp-exit-dns',
    );
    // Its dependencies are installed with the agent's.
    expect(bootstrap).toContain('--filter @tnp/exit --filter @tnp/dns-server --filter @tnp/client');
  });

  test('starts after wg0 is up and goes down with it', () => {
    expect(dnsUnit).toContain('Requires=tnp-exit-wg.service\n');
    expect(dnsUnit).toMatch(/After=tnp-exit-wg\.service/);
    const wg = bootstrap.indexOf('systemctl restart tnp-exit-wg.service');
    expect(wg).toBeGreaterThan(-1);
    expect(wg).toBeLessThan(bootstrap.indexOf('systemctl restart tnp-exit-dns.service'));
    expect(bootstrap).toContain(
      'systemctl enable tnp-exit-wg.service tnp-exit-agent.service tnp-exit-dns.service',
    );
  });

  test('DoH upstreams by default, configurable, https only', () => {
    expect(bootstrap).toContain(
      'DEFAULT_DNS_UPSTREAM=https://1.1.1.1/dns-query,https://8.8.8.8/dns-query\n',
    );
    expect(bootstrap).toContain('TNP_UPSTREAM_DNS=$TNP_EXIT_DNS_UPSTREAM');
    const valid = (value: string) =>
      call('bash', 'bootstrap.sh', 'valid_doh_list', [value]).status === 0;
    expect(valid('https://1.1.1.1/dns-query,https://8.8.8.8/dns-query')).toBe(true);
    expect(valid('https://dns.quad9.net/dns-query')).toBe(true);
    expect(valid('1.1.1.1:53')).toBe(false);
    expect(valid('https://1.1.1.1/dns-query;reboot')).toBe(false);
    expect(valid('https://x/dns-query\nTNP_API_URL=http://evil')).toBe(false);
  });
});

describe('bootstrap on Lightsail and EC2 images', () => {
  const work = mkdtempSync(join(tmpdir(), 'tnp-exit-deploy-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const osRelease = (id: string, version: string) => {
    const path = join(work, `os-release-${id}-${version}`);
    writeFileSync(path, `NAME="x"\nID=${id}\nVERSION_ID="${version}"\nPRETTY_NAME="x"\n`);
    return path;
  };

  test('detects the supported distributions and refuses the rest', () => {
    const detect = (id: string, version: string) =>
      call('bash', 'bootstrap.sh', 'detect_distro', [osRelease(id, version)]);
    expect(detect('amzn', '2023').stdout).toBe('dnf\n');
    expect(detect('debian', '12').stdout).toBe('apt\n');
    expect(detect('ubuntu', '22.04').stdout).toBe('apt\n');
    expect(detect('ubuntu', '24.04').stdout).toBe('apt\n');
    for (const [id, version] of [
      ['amzn', '2'],
      ['debian', '11'],
      ['ubuntu', '20.04'],
      ['centos', '9'],
    ] as const) {
      expect({ id, version, status: detect(id, version).status === 0 }).toEqual({
        id,
        version,
        status: false,
      });
    }
    expect(call('bash', 'bootstrap.sh', 'nftables_conf', ['apt']).stdout).toBe(
      '/etc/nftables.conf\n',
    );
    expect(call('bash', 'bootstrap.sh', 'nftables_conf', ['dnf']).stdout).toBe(
      '/etc/sysconfig/nftables.conf\n',
    );
  });

  test('finds the uplink and its networks, whether it is ens5 or eth0', () => {
    const uplink = (routes: string) =>
      call('bash', 'bootstrap.sh', 'uplink_from_routes', [], routes).stdout;
    expect(uplink('default via 172.26.0.1 dev ens5 proto dhcp src 172.26.5.10 metric 100\n')).toBe(
      'ens5\n',
    );
    expect(uplink('default via 172.26.0.1 dev eth0 proto dhcp metric 100\n')).toBe('eth0\n');
    const addresses = call(
      'bash',
      'bootstrap.sh',
      'addresses_from_ip',
      [],
      [
        '2: eth0    inet 172.26.5.10/20 metric 100 brd 172.26.15.255 scope global dynamic eth0\\       valid_lft 3000sec',
        '2: eth0    inet6 2600:1f18:abc:de00::5/128 scope global dynamic noprefixroute \\       valid_lft 400sec',
        '',
      ].join('\n'),
    ).stdout;
    expect(addresses).toBe('172.26.5.10/20,2600:1f18:abc:de00::5/128\n');
    // ... and the ruleset refuses the instance's own networks from them.
    expect(bootstrap).toContain('--uplink-address "$UPLINK_ADDRS"');
  });

  test('without SSM no metadata is required: the VPC CIDR is added only when there is one', () => {
    expect(bootstrap).toContain('[ -n "$VPC_CIDRS" ] && nft_args+=(--operator-cidr "$VPC_CIDRS")');
    expect(bootstrap).toContain('die "TNP_EXIT_SECRETS=ssm needs EC2 instance metadata');
  });
});

describe('on-disk secrets (TNP_EXIT_SECRETS=file)', () => {
  const work = mkdtempSync(join(tmpdir(), 'tnp-exit-secrets-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));
  const uid = String(process.getuid?.() ?? 0);
  let n = 0;
  /** A secrets directory laid out as the operator should, then `mutate`d. */
  function layout(mutate: (dir: string) => void = () => {}): string {
    const dir = join(work, `s${n++}`);
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    for (const name of ['wg-private-key', 'agent-token']) {
      writeFileSync(join(dir, name), 'x\n', { mode: 0o600 });
      chmodSync(join(dir, name), 0o600);
    }
    mutate(dir);
    return dir;
  }
  const check = (dir: string, owner = uid) =>
    call('sh', 'secrets.sh', 'check_file_secrets', [dir, owner]);

  test('accepts a root-only directory with root-only files', () => {
    expect(check(layout()).status).toBe(0);
    expect(check(layout((d) => chmodSync(join(d, 'agent-token'), 0o400))).status).toBe(0);
  });

  test('refuses looser permissions, another owner, symlinks and hard links', () => {
    const refused: Array<[string, (dir: string) => void]> = [
      ['group-readable directory', (d) => chmodSync(d, 0o750)],
      ['world-readable key', (d) => chmodSync(join(d, 'wg-private-key'), 0o644)],
      ['group-readable token', (d) => chmodSync(join(d, 'agent-token'), 0o640)],
      ['missing token', (d) => rmSync(join(d, 'agent-token'))],
      [
        'symlinked key',
        (d) => {
          const target = join(work, `elsewhere${n}`);
          writeFileSync(target, 'x\n', { mode: 0o600 });
          chmodSync(target, 0o600);
          rmSync(join(d, 'wg-private-key'));
          symlinkSync(target, join(d, 'wg-private-key'));
        },
      ],
      ['hard-linked token', (d) => linkSync(join(d, 'agent-token'), join(work, `link${n}`))],
    ];
    for (const [what, mutate] of refused) {
      const result = check(layout(mutate));
      expect({ what, refused: result.status !== 0 }).toEqual({ what, refused: true });
      expect(result.stderr).toContain('tnp-exit:');
    }
    // A symlinked directory.
    const linked = join(work, `linked${n++}`);
    symlinkSync(layout(), linked);
    expect(check(linked).status).not.toBe(0);
    // The right modes, but not owned by the expected user (root, in wg-up.sh).
    expect(check(layout(), String(Number(uid) + 1)).status).not.toBe(0);
  });
});
