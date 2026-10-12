/**
 * OS DNS routing: only TNP-native names may be sent to TNP, on every platform,
 * and teardown removes exactly what was added.
 *
 * Commands and files are captured through injected deps; nothing here touches
 * the machine. What these tests cannot show is how each OS actually behaves
 * with the generated configuration — that is verified by hand per platform
 * (see the PR). The resolved routing model below encodes the algorithm in
 * systemd-resolved.service(8), "Protocols and Routing", to show why the
 * global section cannot be used.
 */

import { describe, expect, test } from 'bun:test';
import {
  applyNativeRouting,
  dnsDelegateFile,
  LEGACY_RESOLVED_DROPIN,
  legacyCapturedLinks,
  macResolverFile,
  ownerNames,
  parseSystemdVersion,
  removeNativeRouting,
  repairLegacyWindowsAdapters,
  resolvedLinkCommands,
  resolvedServerSpec,
  type RoutingDeps,
  windowsLegacyAdapterRepairScript,
  windowsNrptAddScript,
  windowsNrptRemoveScript,
} from './dns-routing';
import { buildSystemdUnit } from './service';

// ---------------------------------------------------------------------------
// A model of systemd-resolved's unicast routing
// ---------------------------------------------------------------------------

interface Scope {
  name: string;
  servers: string[];
  /** `~x` route-only, `x` search+route. */
  domains: string[];
  /** undefined = resolved's implicit rule. Global scope: always a default route. */
  defaultRoute?: boolean;
  global?: boolean;
}

function labels(name: string): string[] {
  return name.replace(/\.$/, '').split('.').filter(Boolean);
}

function matches(name: string, domain: string): number {
  const d = labels(domain.replace(/^~/, ''));
  if (d.length === 0) return 0; // `~.` matches everything with zero labels
  const n = labels(name);
  if (n.length < d.length) return -1;
  return n.slice(-d.length).join('.').toLowerCase() === d.join('.').toLowerCase() ? d.length : -1;
}

/**
 * Which scopes resolved sends `name` to:
 * 1. the scopes whose matching routing domain has the most labels; else
 * 2. every default-route scope with servers, plus the global servers.
 * Implicit default route: false iff the link has a route-only domain other
 * than `~.`.
 */
function route(name: string, scopes: Scope[]): string[] {
  const withServers = scopes.filter((s) => s.servers.length > 0);
  let best = -1;
  for (const scope of withServers) {
    for (const domain of scope.domains) best = Math.max(best, matches(name, domain));
  }
  if (best >= 0) {
    return withServers
      .filter((s) => s.domains.some((d) => matches(name, d) === best))
      .map((s) => s.name);
  }
  return withServers
    .filter((s) => {
      if (s.global) return true;
      if (s.defaultRoute !== undefined) return s.defaultRoute;
      return !s.domains.some((d) => d.startsWith('~') && d !== '~.');
    })
    .map((s) => s.name);
}

const userLink: Scope = { name: 'wlan0', servers: ['192.168.1.1'], domains: ['home.example'] };

describe('systemd-resolved routing model', () => {
  test('the old global drop-in (DNS=127.0.0.1, Domains=~ox) sent public names to TNP', () => {
    const legacyGlobal: Scope = {
      name: 'global(TNP)',
      servers: ['127.0.0.1'],
      domains: ['~ox'],
      global: true,
    };
    expect(route('hello.ox', [legacyGlobal, userLink])).toEqual(['global(TNP)']);
    // google.com matches no routing domain, so it goes to the default routes
    // AND the global servers — TNP sees it.
    expect(route('google.com', [legacyGlobal, userLink])).toContain('global(TNP)');
  });

  test('a delegate with DefaultRoute=no receives .ox and nothing else', () => {
    const delegate: Scope = {
      name: 'delegate(TNP)',
      servers: ['127.0.0.1'],
      domains: ['~ox'],
      defaultRoute: false,
    };
    expect(route('hello.ox', [delegate, userLink])).toEqual(['delegate(TNP)']);
    expect(route('a.b.hello.ox', [delegate, userLink])).toEqual(['delegate(TNP)']);
    for (const name of ['google.com', 'oxford.ac.uk', 'box', 'nas.home.example', 'ox.com']) {
      expect(route(name, [delegate, userLink])).not.toContain('delegate(TNP)');
    }
  });

  test('the tnp0 link (route-only ~ox, default-route off) receives .ox and nothing else', () => {
    const link: Scope = {
      name: 'tnp0',
      servers: ['127.0.0.1'],
      domains: ['~ox'],
      defaultRoute: false,
    };
    expect(route('hello.ox', [link, userLink])).toEqual(['tnp0']);
    expect(route('google.com', [link, userLink])).toEqual(['wlan0']);
  });
});

// ---------------------------------------------------------------------------
// Generated configuration
// ---------------------------------------------------------------------------

const LOCAL = { address: '127.0.0.1', port: 53 };
const LOCAL_5354 = { address: '127.0.0.1', port: 5354 };

describe('generated configuration', () => {
  test('systemd version parsing', () => {
    expect(parseSystemdVersion('systemd 257 (257.13-1~deb13u1)\n+PAM +AUDIT')).toBe(257);
    expect(parseSystemdVersion('systemd 258 (258.1)')).toBe(258);
    expect(parseSystemdVersion('nonsense')).toBeNull();
  });

  test('server spec carries a port only when it is not 53', () => {
    expect(resolvedServerSpec(LOCAL)).toBe('127.0.0.1');
    expect(resolvedServerSpec(LOCAL_5354)).toBe('127.0.0.1:5354');
    expect(resolvedServerSpec({ address: '::1', port: 5354 })).toBe('[::1]:5354');
  });

  test('the delegate file routes .ox only, route-only, never a default route', () => {
    const file = dnsDelegateFile(LOCAL_5354);
    expect(file).toContain('[Delegate]\nDNS=127.0.0.1:5354\nDomains=~ox\nDefaultRoute=no\n');
    // Every domain is route-only: a search domain would turn `printer` into
    // `printer.ox` and send single-label lookups to TNP.
    const domains = /^Domains=(.*)$/m.exec(file)?.[1].split(' ') ?? [];
    expect(domains.every((d) => d.startsWith('~') && d !== '~.')).toBe(true);
  });

  test('refuses to route a public or private-use TLD', () => {
    expect(() => dnsDelegateFile(LOCAL, ['com'])).toThrow(/not a TNP-native TLD/);
    expect(() => resolvedLinkCommands(LOCAL, ['lan'])).toThrow(/not a TNP-native TLD/);
    expect(() => windowsNrptAddScript('127.0.0.1', ['home'])).toThrow(/not a TNP-native TLD/);
  });

  test('the tnp0 link disables default-route and sets ~ox before it gets a server', () => {
    const { up, down } = resolvedLinkCommands(LOCAL);
    const idx = (prefix: string) => up.findIndex((c) => c.startsWith(prefix));
    expect(idx('resolvectl default-route tnp0 false')).toBeGreaterThanOrEqual(0);
    expect(idx('resolvectl default-route')).toBeLessThan(idx('resolvectl dns'));
    expect(idx('resolvectl domain tnp0 "~ox"')).toBeLessThan(idx('resolvectl dns'));
    expect(idx('ip address replace 192.0.2.53/32 dev tnp0')).toBeLessThan(idx('resolvectl dns'));
    // Only TNP's own link is ever named.
    for (const cmd of [...up, ...down]) expect(cmd).toMatch(/\btnp0\b/);
    expect(down).toEqual(['resolvectl revert tnp0', 'ip link delete tnp0']);
    expect(resolvedLinkCommands(LOCAL, undefined, 'connect').up.join(';')).toContain('tnp1');
  });

  test('the systemd unit runs the link commands around the resolver, non-fatally', () => {
    const plain = buildSystemdUnit('/usr/local/bin/tnp');
    expect(plain).not.toContain('ExecStartPost');
    expect(plain).not.toContain('Before=systemd-resolved');
    expect(plain).toContain('After=network.target systemd-resolved.service');

    const withLink = buildSystemdUnit('/usr/local/bin/tnp', resolvedLinkCommands(LOCAL));
    expect(withLink).toMatch(/^ExecStartPost=-\/bin\/sh -c '.*resolvectl dns tnp0 127\.0\.0\.1'$/m);
    expect(withLink).toMatch(
      /^ExecStopPost=-\/bin\/sh -c 'resolvectl revert tnp0; ip link delete tnp0'$/m,
    );
  });

  test('Windows uses an NRPT rule for .ox and never rewrites adapter servers', () => {
    const add = windowsNrptAddScript('127.0.0.1');
    expect(add).toContain(
      "Add-DnsClientNrptRule -Namespace '.ox' -NameServers '127.0.0.1' -Comment 'Managed by TNP'",
    );
    expect(add).not.toContain('Set-DnsClientServerAddress');
    const remove = windowsNrptRemoveScript();
    expect(remove).toContain("$_.Comment -eq 'Managed by TNP'");
    expect(remove).not.toContain('ResetServerAddresses');
    expect(windowsNrptRemoveScript('connect')).toContain("'Managed by TNP (connect)'");
  });

  test('the Windows legacy repair removes only the entry an old install added', () => {
    const script = windowsLegacyAdapterRepairScript('127.0.0.1');
    expect(script).toContain("Where-Object { $_ -ne '127.0.0.1' }");
    // Reset only when nothing of the user's is left (it was DHCP before).
    expect(script).toMatch(/if \(\$rest\.Count -gt 0\).*-ServerAddresses \$rest/);
    expect(() => windowsLegacyAdapterRepairScript("1.1.1.1'; evil")).toThrow();
  });

  test('legacy captured links are found from resolvectl dns output', () => {
    const output = [
      'Global:',
      'Link 2 (eth0): 127.0.0.1',
      'Link 3 (wlan0): 192.168.1.1 fe80::1',
      'Link 9 (tnp0): 127.0.0.1',
    ].join('\n');
    expect(legacyCapturedLinks(output)).toEqual(['eth0']);
  });
});

// ---------------------------------------------------------------------------
// Apply / remove against fake deps
// ---------------------------------------------------------------------------

interface Fake {
  deps: RoutingDeps;
  files: Map<string, string>;
  commands: string[];
  warnings: string[];
}

function fake(
  platform: NodeJS.Platform,
  options: { files?: Record<string, string>; systemd?: string; resolved?: boolean } = {},
): Fake {
  const files = new Map(Object.entries(options.files ?? {}));
  if (options.resolved !== false && platform === 'linux') files.set('/run/systemd/resolve', '');
  const commands: string[] = [];
  const warnings: string[] = [];
  const deps: RoutingDeps = {
    platform,
    run: (cmd) => {
      commands.push(cmd);
      if (cmd === 'systemctl --version') return options.systemd ?? 'systemd 258 (258.1)';
      if (cmd === 'resolvectl dns') return 'Global:\nLink 2 (eth0): 192.168.1.1\n';
      return '';
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
  return { deps, files, commands, warnings };
}

function decodePowershell(cmd: string): string {
  const encoded = /-EncodedCommand (\S+)$/.exec(cmd)?.[1];
  return encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : cmd;
}

describe('applyNativeRouting / removeNativeRouting', () => {
  test('Linux, systemd 258+: one delegate file, nothing global, removed on teardown', () => {
    const f = fake('linux', { files: { [LEGACY_RESOLVED_DROPIN]: '[Resolve]\nDNS=127.0.0.1\n' } });
    const { state } = applyNativeRouting({ owner: 'install', target: LOCAL }, f.deps);

    expect(state.mechanism).toBe('dns-delegate');
    const delegate = ownerNames('install').delegate;
    expect(f.files.get(delegate)).toBe(dnsDelegateFile(LOCAL));
    // The old global drop-in is gone, and nothing replaced it.
    expect(f.files.has(LEGACY_RESOLVED_DROPIN)).toBe(false);
    expect([...f.files.keys()].some((p) => p.includes('resolved.conf'))).toBe(false);
    // No interface's servers were set.
    expect(f.commands.some((c) => /resolvectl (dns|domain) \S+ /.test(c))).toBe(false);

    removeNativeRouting(state, f.deps);
    expect(f.files.has(delegate)).toBe(false);
  });

  test('Linux, older systemd, install: link commands go to the unit; nothing run now', () => {
    const f = fake('linux', { systemd: 'systemd 255 (255.4)' });
    const result = applyNativeRouting(
      { owner: 'install', target: LOCAL, linkCommandsInUnit: true },
      f.deps,
    );
    expect(result.state.mechanism).toBe('resolved-link');
    expect(result.unitLink).toEqual(resolvedLinkCommands(LOCAL));
    expect(f.commands.filter((c) => c.includes('tnp0'))).toEqual([]);
  });

  test('Linux, older systemd, connect: tnp1 brought up now and down on teardown', () => {
    const f = fake('linux', { systemd: 'systemd 252' });
    const { state } = applyNativeRouting({ owner: 'connect', target: LOCAL_5354 }, f.deps);
    const run = f.commands.filter((c) => c.includes('tnp1'));
    expect(run).toHaveLength(6);
    expect(run.at(-1)).toContain('resolvectl dns tnp1 127.0.0.1:5354');
    removeNativeRouting(state, f.deps);
    expect(f.commands.slice(-2)).toEqual(['resolvectl revert tnp1', 'ip link delete tnp1']);
  });

  test('Linux without systemd-resolved: nothing changed, the user is told', () => {
    const f = fake('linux', {
      resolved: false,
      files: { '/etc/resolv.conf': 'nameserver 9.9.9.9\n' },
    });
    const { state } = applyNativeRouting({ owner: 'connect', target: LOCAL_5354 }, f.deps);
    expect(state.mechanism).toBe('none');
    expect(f.files.get('/etc/resolv.conf')).toBe('nameserver 9.9.9.9\n');
    expect(f.warnings.join(' ')).toContain('server=/ox/127.0.0.1#5354');
  });

  test('macOS: /etc/resolver/ox only; a foreign file is backed up and restored', () => {
    const foreign = 'nameserver 10.0.0.53\n';
    const f = fake('darwin', {
      files: {
        '/etc/resolver/ox': foreign,
        '/etc/resolver/com': 'nameserver 127.0.0.1\nport 5354\n', // an old TNP install
        '/etc/resolver/test': 'nameserver 127.0.0.1\n', // Laravel Valet: not ours
      },
    });
    const { state } = applyNativeRouting({ owner: 'install', target: LOCAL_5354 }, f.deps);
    expect(f.files.get('/etc/resolver/ox')).toBe(macResolverFile(LOCAL_5354));
    expect(f.files.has('/etc/resolver/com')).toBe(false);
    expect(f.files.get('/etc/resolver/test')).toBe('nameserver 127.0.0.1\n');

    removeNativeRouting(state, f.deps);
    expect(f.files.get('/etc/resolver/ox')).toBe(foreign);
    expect(f.files.get('/etc/resolver/test')).toBe('nameserver 127.0.0.1\n');
  });

  test('macOS: install and connect share /etc/resolver/ox without tearing down each other', () => {
    const f = fake('darwin');
    const install = applyNativeRouting({ owner: 'install', target: LOCAL }, f.deps).state;
    const connect = applyNativeRouting({ owner: 'connect', target: LOCAL_5354 }, f.deps).state;
    expect(f.files.get('/etc/resolver/ox')).toBe(macResolverFile(LOCAL_5354));

    // Uninstalling while the session runs must not cut the session off.
    removeNativeRouting(install, f.deps);
    expect(f.files.get('/etc/resolver/ox')).toBe(macResolverFile(LOCAL_5354));

    // Ending the session restores what was there before it. (Install is gone
    // by now, so this points at a loopback port nothing listens on: `.ox`
    // fails closed until the next install or connect — it never leaks.)
    removeNativeRouting(connect, f.deps);
    expect(f.files.get('/etc/resolver/ox')).toBe(macResolverFile(LOCAL));
  });

  test('Windows: an NRPT rule and nothing else; teardown removes only NRPT', () => {
    const f = fake('win32');
    const { state } = applyNativeRouting({ owner: 'install', target: LOCAL }, f.deps);
    const scripts = f.commands.map(decodePowershell);
    // Adapters are not even read: 127.0.0.1 on an adapter may be the user's
    // own dnscrypt-proxy or Acrylic, and is not TNP's to touch.
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("Add-DnsClientNrptRule -Namespace '.ox' -NameServers '127.0.0.1'");
    expect(scripts[0]).not.toContain('Set-DnsClientServerAddress');
    expect(state.mechanism).toBe('windows-nrpt');

    f.commands.length = 0;
    removeNativeRouting(state, f.deps);
    const teardown = f.commands.map(decodePowershell).join('\n');
    expect(teardown).toContain('Remove-DnsClientNrptRule');
    expect(teardown).not.toContain('Set-DnsClientServerAddress');
  });

  test('the Windows legacy repair snapshots adapters before removing only 127.0.0.1', () => {
    const f = fake('win32');
    repairLegacyWindowsAdapters(f.deps);
    const scripts = f.commands.map(decodePowershell);
    expect(scripts[0]).toContain('Get-DnsClientServerAddress');
    expect(scripts[0]).toContain('ConvertTo-Json');
    expect(scripts[1]).toContain("Where-Object { $_ -ne '127.0.0.1' }");
  });

  test('Windows warns when the resolver is not on port 53', () => {
    const f = fake('win32');
    applyNativeRouting({ owner: 'connect', target: LOCAL_5354 }, f.deps);
    expect(f.warnings.join(' ')).toContain('cannot use port 5354');
  });
});
