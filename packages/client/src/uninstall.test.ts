import { describe, expect, test } from 'bun:test';
import { formatUninstallReport, tnpTraces } from './uninstall';

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

  test('Windows covers ProgramData, LocalAppData and the Program Files copy', () => {
    const traces = tnpTraces({
      platform: 'win32',
      homes: [],
      env: { PROGRAMDATA: 'C:\\ProgramData', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' },
      serviceBinary: 'C:\\Program Files\\TNP\\tnp.exe',
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
