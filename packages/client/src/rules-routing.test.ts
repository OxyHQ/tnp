/**
 * Per-name OS routing for personal DNS rules: exactly the public names the
 * active rules cover go to the installed TNP resolver, nothing is clobbered,
 * and teardown removes exactly what was written. Files and commands go
 * through injected deps; nothing touches the machine.
 */

import { describe, expect, test } from 'bun:test';
import type { DnsRule } from '@tnp/shared-types';
import {
  applyRuleRouting,
  macResolverFile,
  normalizeRuleRoutes,
  type RoutingDeps,
  type RoutingState,
  rulesDelegateFile,
  rulesLinkCommands,
  windowsNrptRulesAddScript,
} from './dns-routing';
import { removeRulesRouting, routesForRules, syncRulesRouting } from './rules-routing';

const TARGET = { address: '127.0.0.1', port: 53 };
const PATHS = {
  state: '/var/lib/tnp/dns-routing-rules.json',
  install: '/var/lib/tnp/dns-routing-install.json',
};
const DELEGATE = '/etc/systemd/dns-delegate.d/tnp-rules.dns-delegate';
const INSTALL_DELEGATE = '/etc/systemd/dns-delegate.d/tnp.dns-delegate';
const isNative = (name: string) => name.endsWith('.ox');

function installState(platform: NodeJS.Platform): string {
  const state: RoutingState = {
    version: 1,
    owner: 'install',
    mechanism:
      platform === 'darwin'
        ? 'macos-resolver'
        : platform === 'win32'
          ? 'windows-nrpt'
          : 'dns-delegate',
    target: TARGET,
    tlds: ['ox'],
    files: [],
    backups: {},
    down: [],
  };
  return JSON.stringify(state);
}

function fake(
  platform: NodeJS.Platform,
  options: { files?: Record<string, string>; systemd?: string; installed?: boolean } = {},
) {
  const files = new Map(Object.entries(options.files ?? {}));
  if (platform === 'linux') files.set('/run/systemd/resolve', '');
  if (options.installed !== false) files.set(PATHS.install, installState(platform));
  const commands: string[] = [];
  const warnings: string[] = [];
  const deps: RoutingDeps = {
    platform,
    run: (cmd) => {
      commands.push(cmd);
      return cmd === 'systemctl --version' ? (options.systemd ?? 'systemd 258 (258.1)') : '';
    },
    exists: (path) => files.has(path),
    read: (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
    write: (path, content) => {
      files.set(path, content);
    },
    remove: (path) => {
      files.delete(path);
    },
    log: () => {},
    warn: (message) => warnings.push(message),
  };
  const writeState = (path: string, body: string) => files.set(path, body);
  const sync = (rules: DnsRule[]) =>
    syncRulesRouting(routesForRules(rules, isNative), PATHS, deps, writeState);
  return { deps, files, commands, warnings, sync };
}

const decode = (cmd: string) => {
  const encoded = /-EncodedCommand (\S+)$/.exec(cmd)?.[1];
  return encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : cmd;
};

const ACTIVE: DnsRule[] = [
  { type: 'redirect', name: 'google.com', target: { kind: 'ipv4', value: '192.168.1.10' } },
  { type: 'block', name: 'ads.example.com', subdomains: true },
  { type: 'block', name: 'tracker.example.net', subdomains: false },
  { type: 'block', name: 'spam.ox', subdomains: true },
];

describe('routesForRules', () => {
  test('public names only, subtree only for a block with subdomains, in a stable order', () => {
    expect(routesForRules(ACTIVE, isNative)).toEqual([
      { name: 'ads.example.com', subtree: true },
      { name: 'google.com', subtree: false },
      { name: 'tracker.example.net', subtree: false },
    ]);
  });

  test('a duplicate name keeps the wider route', () => {
    expect(
      normalizeRuleRoutes([
        { name: 'a.example', subtree: false },
        { name: 'a.example', subtree: true },
      ]),
    ).toEqual([{ name: 'a.example', subtree: true }]);
  });
});

describe('generated configuration', () => {
  const routes = routesForRules(ACTIVE, isNative);

  test('systemd delegate: route-only domains for exactly those names, never a default route', () => {
    const file = rulesDelegateFile(TARGET, routes);
    expect(file).toContain('Domains=~ads.example.com ~google.com ~tracker.example.net\n');
    expect(file).toContain('DNS=127.0.0.1\n');
    expect(file).toContain('DefaultRoute=no\n');
    expect(file).not.toMatch(/~ox\b|~com\b|~\./);
  });

  test('old systemd: its own tnp2 link, default route off before the server is added', () => {
    const { up, down } = rulesLinkCommands({ address: '127.0.0.1', port: 5354 }, routes);
    const at = (needle: string) => up.findIndex((c) => c.includes(needle));
    expect(at('default-route tnp2 false')).toBeLessThan(at('resolvectl dns tnp2'));
    expect(at('resolvectl domain tnp2 "~ads.example.com" "~google.com"')).toBeLessThan(
      at('resolvectl dns tnp2 127.0.0.1:5354'),
    );
    expect(down).toEqual(['resolvectl revert tnp2', 'ip link delete tnp2']);
  });

  test("Windows NRPT: exact names as FQDN rules, a subtree as name plus suffix, tagged with TNP's comment", () => {
    const script = windowsNrptRulesAddScript('127.0.0.1', routes);
    expect(script).toContain(
      "-Namespace 'ads.example.com' -NameServers '127.0.0.1' -Comment 'Managed by TNP (personal rules)'",
    );
    expect(script).toContain("-Namespace '.ads.example.com'");
    expect(script).toContain("-Namespace 'google.com'");
    expect(script).not.toContain("-Namespace '.google.com'");
    expect(script).toContain("Where-Object { $_.Comment -eq 'Managed by TNP (personal rules)' }");
    expect(script).not.toContain("-eq 'Managed by TNP' }");
  });

  test('refuses anything that is not a multi-label public domain name', () => {
    for (const name of ['com', 'a.ox', "x.com' ; rm -rf /", '1.2.3.4', '-a.com', 'A.com']) {
      expect(() => rulesDelegateFile(TARGET, [{ name, subtree: false }])).toThrow('refusing');
    }
  });
});

describe('syncRulesRouting', () => {
  test('Linux: writes one delegate, leaves the install delegate alone, and is idempotent', () => {
    const f = fake('linux', { files: { [INSTALL_DELEGATE]: '# Written by TNP install' } });
    const outcome = f.sync(ACTIVE);
    expect(outcome.kind).toBe('applied');
    expect(f.files.get(DELEGATE)).toBe(rulesDelegateFile(TARGET, routesForRules(ACTIVE, isNative)));
    expect(f.files.get(INSTALL_DELEGATE)).toBe('# Written by TNP install');
    const recorded = JSON.parse(f.files.get(PATHS.state) ?? '{}') as RoutingState;
    expect(recorded.owner).toBe('rules');
    expect(recorded.files).toEqual([DELEGATE]);

    const before = f.commands.length;
    expect(f.sync(ACTIVE).kind).toBe('unchanged');
    expect(f.commands.length).toBe(before);
  });

  test('a revoked redirect drops its name; no rules left removes everything it wrote', () => {
    const f = fake('linux');
    f.sync(ACTIVE);
    f.sync(ACTIVE.filter((r) => r.name !== 'google.com'));
    expect(f.files.get(DELEGATE)).not.toContain('google.com');
    expect(f.sync([]).kind).toBe('removed');
    expect(f.files.has(DELEGATE)).toBe(false);
    expect(f.files.has(PATHS.state)).toBe(false);
  });

  test('no installed resolver: nothing is routed (a name pointed at nothing would stop resolving)', () => {
    const f = fake('linux', { installed: false });
    expect(f.sync(ACTIVE)).toEqual({ kind: 'no-resolver', pending: 3 });
    expect(f.files.has(DELEGATE)).toBe(false);
    expect(f.files.has(PATHS.state)).toBe(false);
  });

  test("a foreign delegate file at TNP's path is never overwritten", () => {
    const f = fake('linux', { files: { [DELEGATE]: '[Delegate]\nDNS=10.0.0.1\n' } });
    const outcome = f.sync(ACTIVE);
    expect(outcome.kind === 'applied' && outcome.routes).toEqual([]);
    expect(f.files.get(DELEGATE)).toBe('[Delegate]\nDNS=10.0.0.1\n');
  });

  test('old systemd: link commands run, and teardown runs the recorded down commands', () => {
    const f = fake('linux', { systemd: 'systemd 255 (255.4)' });
    f.sync(ACTIVE);
    expect(f.commands.some((c) => c.includes('resolvectl domain tnp2'))).toBe(true);
    expect(f.warnings.some((w) => w.includes('does not survive a reboot'))).toBe(true);
    expect(removeRulesRouting(PATHS, f.deps)).toBe(true);
    expect(f.commands.slice(-2)).toEqual(['resolvectl revert tnp2', 'ip link delete tnp2']);
  });

  test('macOS: one /etc/resolver file per name, pre-existing files never clobbered, exact teardown', () => {
    const valet = 'nameserver 127.0.0.1\nport 5300\n';
    const f = fake('darwin', { files: { '/etc/resolver/google.com': valet } });
    const outcome = f.sync(ACTIVE);
    expect(outcome).toEqual({
      kind: 'applied',
      routes: [
        { name: 'ads.example.com', subtree: true },
        { name: 'tracker.example.net', subtree: false },
      ],
      skipped: ['google.com'],
    });
    expect(f.files.get('/etc/resolver/ads.example.com')).toBe(macResolverFile(TARGET));
    expect(f.files.get('/etc/resolver/google.com')).toBe(valet);
    expect(f.files.has('/etc/resolver/spam.ox')).toBe(false);

    // A file of ours that someone changed since is left alone on teardown.
    f.files.set('/etc/resolver/tracker.example.net', 'nameserver 9.9.9.9\n');
    expect(removeRulesRouting(PATHS, f.deps)).toBe(true);
    expect(f.files.has('/etc/resolver/ads.example.com')).toBe(false);
    expect(f.files.get('/etc/resolver/tracker.example.net')).toBe('nameserver 9.9.9.9\n');
    expect(f.files.get('/etc/resolver/google.com')).toBe(valet);
  });

  test('Windows: NRPT rules tagged with the rules comment, removed by that comment only', () => {
    const f = fake('win32');
    f.sync(ACTIVE);
    const added = decode(f.commands.at(-1) ?? '');
    expect(added).toContain("-Namespace 'google.com'");
    expect(added).toContain("-Comment 'Managed by TNP (personal rules)'");
    removeRulesRouting(PATHS, f.deps);
    const removed = decode(f.commands.at(-1) ?? '');
    expect(removed).toContain("$_.Comment -eq 'Managed by TNP (personal rules)'");
    expect(removed).not.toContain('Add-DnsClientNrptRule');
  });

  test('applyRuleRouting with no routes writes nothing', () => {
    const f = fake('linux');
    expect(applyRuleRouting({ target: TARGET, routes: [] }, f.deps).mechanism).toBe('none');
    expect(f.commands).toEqual([]);
  });
});
