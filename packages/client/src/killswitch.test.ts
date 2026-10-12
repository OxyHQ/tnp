import { describe, expect, test } from 'bun:test';
import {
  buildPlan,
  describeKillSwitch,
  disableKillSwitch,
  enableKillSwitch,
  ipv4BlockRanges,
  ipv6BlockRanges,
  type KillSwitchHost,
  type KillSwitchRecord,
  type KillSwitchStore,
  killSwitchAllow,
  NETSH_RULES,
  nftRuleset,
  PF_ANCHOR,
  parsePfToken,
  pfRules,
  selectBackend,
  teardownCommands,
  upstreamsBlockedByKillSwitch,
} from './killswitch';
import type { Cmd, CmdResult } from './system-cmd';

const ok = (stdout = ''): CmdResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr = 'boom'): CmdResult => ({ status: 1, stdout: '', stderr });

/** A machine that records every command and answers from `respond`. */
function fakeHost(
  platform: NodeJS.Platform,
  respond: (cmd: Cmd) => CmdResult,
  opts: { root?: boolean; bins?: string[]; ipv6?: boolean } = {},
): KillSwitchHost & { log: Cmd[] } {
  const bins = new Set(
    opts.bins ?? ['nft', 'iptables', 'ip6tables', 'pfctl', 'netsh', 'powershell'],
  );
  const log: Cmd[] = [];
  return {
    platform,
    isRoot: opts.root ?? true,
    ipv6Present: opts.ipv6 ?? true,
    findBinary: (name) => (bins.has(name) ? `/sbin/${name}` : null),
    run: (cmd) => {
      log.push(cmd);
      return respond(cmd);
    },
    log,
  };
}

function memoryStore(): KillSwitchStore & { record: KillSwitchRecord | null } {
  const store = {
    record: null as KillSwitchRecord | null,
    read: () => ({ present: store.record !== null, record: store.record }),
    write: (r: KillSwitchRecord) => {
      store.record = r;
    },
    clear: () => {
      store.record = null;
    },
    legacyPresent: () => false,
    clearLegacy: () => {},
  };
  return store;
}

const line = (cmd: Cmd) => [cmd.file, ...cmd.args].join(' ');

describe('policy', () => {
  test('describes exactly what is blocked and disclaims the rest', () => {
    const text = describeKillSwitch(killSwitchAllow('203.0.113.7'));
    expect(text).toContain('port 53');
    expect(text).toContain('IPv4 and IPv6');
    expect(text).toContain('203.0.113.7');
    expect(text).toContain('not a full-traffic kill switch');
    expect(text.toLowerCase()).not.toContain('vpn');
  });

  test('refuses a resolver address that is not an IP literal', () => {
    expect(() => killSwitchAllow('1.1.1.1; rm -rf /')).toThrow('not an IP address');
    expect(() => killSwitchAllow('fe80::1%eth0')).toThrow('not an IP address');
  });

  test('sorts the resolver into its address family', () => {
    expect(killSwitchAllow('2001:db8::53')).toEqual({ v4: [], v6: ['2001:db8::53'] });
    expect(killSwitchAllow('')).toEqual({ v4: [], v6: [] });
  });

  test('names the plain-DNS upstreams the kill switch will cut off', () => {
    const allow = killSwitchAllow('203.0.113.7');
    expect(
      upstreamsBlockedByKillSwitch(
        '1.1.1.1, https://dns.example/dns-query, 203.0.113.7, 127.0.0.1, 9.9.9.9:5353, [2606:4700::1111], [2606:4700::1001]:53',
        allow,
      ),
    ).toEqual(['1.1.1.1', '[2606:4700::1111]', '[2606:4700::1001]:53']);
  });
});

describe('Linux plans', () => {
  test('nftables uses one inet table so IPv4 and IPv6 are both covered', () => {
    const rules = nftRuleset(killSwitchAllow('203.0.113.7'));
    expect(rules).toContain('table inet tnp_killswitch {');
    expect(rules).toContain('ip daddr 127.0.0.0/8 udp dport 53 accept');
    expect(rules).toContain('ip6 daddr ::1 tcp dport 53 accept');
    expect(rules).toContain('ip daddr 203.0.113.7 udp dport 53 accept');
    // Accepts must precede the drops, which close both protocols.
    expect(rules.indexOf('accept')).toBeLessThan(rules.indexOf('udp dport 53 drop'));
    expect(rules).toContain('tcp dport 53 drop');
  });

  test('nftables is loaded from stdin, not a file', () => {
    const plan = buildPlan({ backend: 'nft', nft: '/usr/sbin/nft' }, killSwitchAllow(''));
    expect(plan.apply).toHaveLength(1);
    expect(plan.apply[0].args).toEqual(['-f', '-']);
    expect(plan.apply[0].input).toContain('table inet tnp_killswitch');
  });

  test('iptables fallback mirrors every rule into ip6tables', () => {
    const plan = buildPlan(
      { backend: 'iptables', iptables: '/sbin/iptables', ip6tables: '/sbin/ip6tables' },
      killSwitchAllow(''),
    );
    const v4 = plan.apply.filter((c) => c.file === '/sbin/iptables').map(line);
    const v6 = plan.apply.filter((c) => c.file === '/sbin/ip6tables').map(line);
    expect(v4.length).toBe(v6.length);
    expect(v4.some((l) => l.includes('-d 127.0.0.0/8'))).toBe(true);
    expect(v6.some((l) => l.includes('-d ::1/128'))).toBe(true);
    for (const rules of [v4, v6]) {
      expect(rules.some((l) => l.includes('-p udp --dport 53 -j DROP'))).toBe(true);
      expect(rules.some((l) => l.includes('-p tcp --dport 53 -j DROP'))).toBe(true);
      expect(rules.at(-1)).toContain('-I OUTPUT 1 -j TNP_KILLSWITCH');
    }
    expect(plan.verify).toHaveLength(2);
  });

  test('prefers nftables, and refuses IPv4-only protection on an IPv6 host', () => {
    expect(selectBackend(fakeHost('linux', () => ok())).backend).toBe('nft');
    expect(() =>
      selectBackend(fakeHost('linux', () => ok(), { bins: ['iptables'], ipv6: true })),
    ).toThrow('ip6tables');
    expect(
      selectBackend(fakeHost('linux', () => ok(), { bins: ['iptables'], ipv6: false })).backend,
    ).toBe('iptables');
  });

  test('needs root instead of shelling out to sudo', () => {
    expect(() => selectBackend(fakeHost('linux', () => ok(), { root: false }))).toThrow('root');
  });
});

describe('macOS plan', () => {
  const plan = buildPlan({ backend: 'pf', pfctl: '/sbin/pfctl' }, killSwitchAllow('203.0.113.7'));

  test('loads into an anchor the stock ruleset evaluates, from stdin', () => {
    expect(plan.apply[0].args).toEqual(['-a', PF_ANCHOR, '-f', '-']);
    expect(PF_ANCHOR.startsWith('com.apple/')).toBe(true);
    expect(plan.apply[0].input).toBe(pfRules(killSwitchAllow('203.0.113.7')));
  });

  test('passes come before the block, all quick', () => {
    const rules = pfRules(killSwitchAllow('203.0.113.7')).trim().split('\n');
    expect(rules.at(-1)).toBe('block drop out quick proto { tcp, udp } from any to any port 53');
    for (const rule of rules.slice(0, -1)) expect(rule.startsWith('pass out quick')).toBe(true);
    expect(rules.some((r) => r.includes('to 203.0.113.7 port 53'))).toBe(true);
  });

  test('enables pf with a reference token', () => {
    expect(plan.enable?.args).toEqual(['-E']);
    expect(parsePfToken('No ALTQ support in kernel\npf enabled\nToken : 1844674407')).toBe(
      '1844674407',
    );
  });

  test('rejects a ruleset that never evaluates com.apple/*', () => {
    const anchorCheck = plan.verify[0];
    expect(anchorCheck.check(ok('scrub-anchor "com.apple/*" all fragment reassemble\n'))).toContain(
      'never be evaluated',
    );
    expect(anchorCheck.check(ok('anchor "com.apple/*" all\n'))).toBeNull();
  });
});

describe('Windows plan', () => {
  test('blocks the complement of loopback and the resolver', () => {
    expect(ipv4BlockRanges([])).toEqual(['0.0.0.0-126.255.255.255', '128.0.0.0-255.255.255.255']);
    expect(ipv4BlockRanges(['203.0.113.7'])).toEqual([
      '0.0.0.0-126.255.255.255',
      '128.0.0.0-203.0.113.6',
      '203.0.113.8-255.255.255.255',
    ]);
    expect(ipv4BlockRanges(['0.0.0.0'])[0]).toBe('0.0.0.1-126.255.255.255');
  });

  test('IPv6 complement excludes ::1 and the resolver', () => {
    expect(ipv6BlockRanges([])).toEqual([
      '0:0:0:0:0:0:0:0',
      '0:0:0:0:0:0:0:2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    ]);
    const ranges = ipv6BlockRanges(['2001:db8::53']);
    expect(ranges).toContain('0:0:0:0:0:0:0:2-2001:db8:0:0:0:0:0:52');
    expect(ranges).toContain('2001:db8:0:0:0:0:0:54-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff');
  });

  test('one block rule per protocol and family, and no allow rules', () => {
    const plan = buildPlan(
      { backend: 'netsh', netsh: 'C:\\Windows\\System32\\netsh.exe', powershell: 'ps' },
      killSwitchAllow(''),
    );
    expect(plan.apply).toHaveLength(NETSH_RULES.length);
    for (const cmd of plan.apply) {
      expect(cmd.args).toContain('action=block');
      expect(cmd.args).toContain('remoteport=53');
      expect(cmd.args.join(' ')).not.toContain('action=allow');
    }
  });

  test('refuses when a firewall profile is off', () => {
    const plan = buildPlan(
      { backend: 'netsh', netsh: 'netsh', powershell: 'ps' },
      killSwitchAllow(''),
    );
    expect(plan.verify[0].check(ok('1\r\n'))).toContain('disabled');
    expect(plan.verify[0].check(ok('0\r\n'))).toBeNull();
  });
});

describe('enableKillSwitch', () => {
  test('records the backend once every rule is applied and verified', () => {
    const host = fakeHost('linux', (cmd) =>
      cmd.args[0] === 'list' ? ok('udp dport 53 drop') : ok(),
    );
    const store = memoryStore();
    const record = enableKillSwitch('', host, store);
    expect(record.backend).toBe('nft');
    expect(store.record?.backend).toBe('nft');
  });

  test('rolls back and records nothing when a rule fails part-way', () => {
    let applied = 0;
    const host = fakeHost(
      'linux',
      (cmd) => {
        if (cmd.args.includes('-N') || cmd.args.includes('-A') || cmd.args.includes('-I')) {
          applied++;
          return applied === 5 ? fail('iptables: Resource temporarily unavailable') : ok();
        }
        return ok();
      },
      { bins: ['iptables', 'ip6tables'] },
    );
    const store = memoryStore();
    expect(() => enableKillSwitch('', host, store)).toThrow('Resource temporarily unavailable');
    expect(store.record).toBeNull();
    const after = host.log.slice(host.log.findIndex((c) => c.args.includes('-A')));
    const lines = after.map(line);
    expect(lines.some((l) => l.includes('-D OUTPUT -j TNP_KILLSWITCH'))).toBe(true);
    expect(lines.some((l) => l.includes('/sbin/ip6tables -w -X TNP_KILLSWITCH'))).toBe(true);
  });

  test('macOS: a ruleset without the com.apple anchor rolls back and releases the token', () => {
    const host = fakeHost('darwin', (cmd) => {
      if (cmd.args[0] === '-E')
        return { status: 0, stdout: '', stderr: 'pf enabled\nToken : 42\n' };
      if (cmd.args.join(' ') === '-s rules') return ok('block drop all\n');
      return ok();
    });
    const store = memoryStore();
    expect(() => enableKillSwitch('', host, store)).toThrow('never be evaluated');
    expect(store.record).toBeNull();
    const lines = host.log.map(line);
    expect(lines).toContain('/sbin/pfctl -X 42');
    expect(lines).toContain(`/sbin/pfctl -a ${PF_ANCHOR} -F all`);
  });

  test('macOS: success keeps the token for teardown', () => {
    const host = fakeHost('darwin', (cmd) => {
      const args = cmd.args.join(' ');
      if (args === '-E') return { status: 0, stdout: '', stderr: 'Token : 7' };
      if (args === '-s rules') return ok('anchor "com.apple/*" all\n');
      if (args === `-a ${PF_ANCHOR} -s rules`) return ok('block drop out quick proto ...');
      if (args === '-s info') return ok('Status: Enabled for 0 days');
      return ok();
    });
    const store = memoryStore();
    expect(enableKillSwitch('', host, store).pfToken).toBe('7');
  });

  test('never writes a file for pfctl to read', () => {
    const cmds = teardownCommands(
      fakeHost('darwin', () => ok()),
      {},
    );
    const plan = buildPlan({ backend: 'pf', pfctl: '/sbin/pfctl' }, killSwitchAllow(''));
    for (const cmd of [...cmds, ...plan.apply]) {
      expect(cmd.args.join(' ')).not.toContain('/tmp');
    }
  });
});

describe('disableKillSwitch', () => {
  test('keeps the record while any rule survives', () => {
    const host = fakeHost('linux', (cmd) =>
      cmd.args[0] === 'list' ? ok('table inet tnp_killswitch') : ok(),
    );
    const store = memoryStore();
    store.record = { version: 1, backend: 'nft', pid: 1, enabledAt: '' };
    const { residual } = disableKillSwitch('', host, store);
    expect(residual.length).toBeGreaterThan(0);
    expect(store.record).not.toBeNull();
  });

  test('clears the record when nothing remains', () => {
    const host = fakeHost('linux', (cmd) =>
      cmd.args[0] === 'list' || cmd.args.includes('-L') ? fail('No such file') : ok(),
    );
    const store = memoryStore();
    store.record = { version: 1, backend: 'nft', pid: 1, enabledAt: '' };
    expect(disableKillSwitch('', host, store).residual).toEqual([]);
    expect(store.record).toBeNull();
  });

  test('keeps the record when the recorded backend can no longer be inspected', () => {
    // Kernel rules outlive the binary that loaded them; no probe is not proof.
    const host = fakeHost('linux', () => fail('No such file'), { bins: ['iptables', 'ip6tables'] });
    const store = memoryStore();
    store.record = { version: 1, backend: 'nft', pid: 1, enabledAt: '' };
    const { residual } = disableKillSwitch('', host, store);
    expect(residual.join(' ')).toContain('nft is missing');
    expect(store.record).not.toBeNull();
  });

  test('removes the legacy 0.2.0 Windows rule names too', () => {
    const names = teardownCommands(
      fakeHost('win32', () => ok()),
      {},
    ).map((c) => c.args.at(-1));
    expect(names).toContain('name=TNP-KillSwitch-Block-DNS');
    expect(names).toContain('name=TNP-KillSwitch-DNS-UDP-v6');
  });
});
