import { describe, expect, test } from 'bun:test';
import type { DnsRule } from '@tnp/shared-types';
import {
  formatActiveRulesFile,
  matchPersonalRule,
  parseActiveRulesFile,
  PersonalRulesFile,
  type PersonalRulesFileOptions,
} from './dns-rules';

const isNative = (name: string) => name.endsWith('.ox');

const RULES: DnsRule[] = [
  { type: 'block', name: 'tracker.example.net', subdomains: false },
  { type: 'block', name: 'ads.example.com', subdomains: true },
  { type: 'redirect', name: 'google.com', target: { kind: 'ipv4', value: '192.168.1.10' } },
  { type: 'redirect', name: 'v6.example.org', target: { kind: 'ipv6', value: '2001:db8::10' } },
  { type: 'redirect', name: 'media.example.org', target: { kind: 'name', value: 'nas.home.arpa' } },
];

function snapshotOf(rules: DnsRule[] = RULES) {
  const parsed = parseActiveRulesFile(formatActiveRulesFile({ version: 3, pending: 1, rules }));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.snapshot;
}

describe('the active rules file', () => {
  test('is one readable line per rule and round-trips', () => {
    const text = formatActiveRulesFile({ version: 3, pending: 1, rules: RULES });
    const lines = text.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines).toEqual([
      'version 3',
      'pending 1',
      'block-subdomains ads.example.com',
      'block tracker.example.net',
      'redirect google.com ipv4 192.168.1.10',
      'redirect media.example.org name nas.home.arpa',
      'redirect v6.example.org ipv6 2001:db8::10',
    ]);
    const snapshot = snapshotOf();
    expect(snapshot.version).toBe(3);
    expect(snapshot.pending).toBe(1);
    expect(snapshot.blocks.get('ads.example.com')).toBe(true);
    expect(snapshot.blocks.get('tracker.example.net')).toBe(false);
    expect(snapshot.redirects.get('google.com')).toEqual({ kind: 'ipv4', value: '192.168.1.10' });
  });

  test('one line it did not write refuses the whole file', () => {
    for (const bad of [
      'allow google.com',
      'block com',
      'block GOOGLE.com',
      'block 1.2.3.4',
      'redirect google.com ipv4 not-an-ip',
      'redirect google.com ipv6 192.168.1.10',
      'redirect google.com name google.com',
      'redirect google.com',
      'block a.example extra',
      'version x',
      'block a.example\nblock a.example',
      'block a.example\nredirect a.example ipv4 10.0.0.1',
    ]) {
      expect(parseActiveRulesFile(`version 1\n${bad}\n`).ok).toBe(false);
    }
  });
});

describe('matchPersonalRule', () => {
  const snapshot = snapshotOf();

  test('exact blocks, subtree blocks, and nothing beyond', () => {
    expect(matchPersonalRule(snapshot, 'tracker.example.net', isNative)).toEqual({ kind: 'block' });
    expect(matchPersonalRule(snapshot, 'sub.tracker.example.net', isNative)).toBeNull();
    expect(matchPersonalRule(snapshot, 'ads.example.com', isNative)).toEqual({ kind: 'block' });
    expect(matchPersonalRule(snapshot, 'x.y.ads.example.com', isNative)).toEqual({ kind: 'block' });
    expect(matchPersonalRule(snapshot, 'example.com', isNative)).toBeNull();
    expect(matchPersonalRule(snapshot, 'notads.example.com', isNative)).toBeNull();
  });

  test('redirects are exact-name only', () => {
    expect(matchPersonalRule(snapshot, 'google.com', isNative)).toEqual({
      kind: 'redirect',
      target: { kind: 'ipv4', value: '192.168.1.10' },
    });
    expect(matchPersonalRule(snapshot, 'www.google.com', isNative)).toBeNull();
  });

  test('an exact redirect wins over a parent block', () => {
    const s = snapshotOf([
      { type: 'block', name: 'example.com', subdomains: true },
      { type: 'redirect', name: 'www.example.com', target: { kind: 'ipv4', value: '10.0.0.1' } },
    ]);
    expect(matchPersonalRule(s, 'www.example.com', isNative)?.kind).toBe('redirect');
    expect(matchPersonalRule(s, 'mail.example.com', isNative)?.kind).toBe('block');
  });

  test('a redirect of a native name is ignored, but a block still applies to it', () => {
    const s = snapshotOf([
      { type: 'redirect', name: 'nate.ox', target: { kind: 'ipv4', value: '10.0.0.1' } },
      { type: 'block', name: 'ads.ox', subdomains: true },
    ]);
    expect(matchPersonalRule(s, 'nate.ox', isNative)).toBeNull();
    expect(matchPersonalRule(s, 'x.ads.ox', isNative)).toEqual({ kind: 'block' });
  });
});

describe('PersonalRulesFile', () => {
  const GOOD = formatActiveRulesFile({ version: 1, pending: 0, rules: RULES });

  function fileWith(
    stat: Partial<{ uid: number; mode: number; symlink: boolean; size: number }>,
    extra: PersonalRulesFileOptions = {},
  ) {
    const warnings: string[] = [];
    const file = new PersonalRulesFile('/etc/tnp/dns-rules.conf', {
      euid: 1000,
      platform: 'linux',
      lstat: () => ({
        uid: stat.uid ?? 0,
        mode: stat.mode ?? 0o100640,
        size: stat.size ?? GOOD.length,
        mtimeMs: 1,
        ino: 1,
        isFile: () => !stat.symlink,
        isSymbolicLink: () => stat.symlink === true,
      }),
      readFile: () => GOOD,
      warn: (m) => warnings.push(m),
      ...extra,
    });
    return { file, warnings };
  }

  test('a root-owned 0640 file applies', () => {
    expect(fileWith({}).file.current()?.blocks.size).toBe(2);
  });

  test('a file owned by the resolver itself applies', () => {
    expect(fileWith({ uid: 1000 }).file.current()).not.toBeNull();
  });

  test('a file another user owns, a writable file or a symlink applies nothing, and says why', () => {
    for (const stat of [{ uid: 1001 }, { mode: 0o100662 }, { mode: 0o100620 }, { symlink: true }]) {
      const { file, warnings } = fileWith(stat);
      expect(file.current()).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).not.toContain('google.com');
    }
  });

  test('a malformed file applies nothing, and the warning never quotes a rule', () => {
    const { file, warnings } = fileWith(
      {},
      { readFile: () => 'block google.com\nallow secret.example\n' },
    );
    expect(file.current()).toBeNull();
    expect(warnings[0]).toContain('line 2');
    expect(warnings[0]).not.toContain('secret.example');
  });

  test('a missing file applies nothing, silently', () => {
    const warnings: string[] = [];
    const file = new PersonalRulesFile('/nope', {
      lstat: () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      warn: (m) => warnings.push(m),
    });
    expect(file.current()).toBeNull();
    expect(warnings).toEqual([]);
  });

  test('is re-read only when it changes, and at most every interval', () => {
    let reads = 0;
    let mtime = 1;
    let clock = 0;
    const file = new PersonalRulesFile('/etc/tnp/dns-rules.conf', {
      euid: 0,
      platform: 'linux',
      checkIntervalMs: 1000,
      now: () => clock,
      lstat: () => ({
        uid: 0,
        mode: 0o100600,
        size: GOOD.length,
        mtimeMs: mtime,
        ino: 1,
        isFile: () => true,
        isSymbolicLink: () => false,
      }),
      readFile: () => {
        reads++;
        return GOOD;
      },
    });
    file.current();
    clock = 500;
    mtime = 2;
    file.current();
    expect(reads).toBe(1);
    clock = 1500;
    file.current();
    expect(reads).toBe(2);
    clock = 3000;
    file.current();
    expect(reads).toBe(2);
  });
});
