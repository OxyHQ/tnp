import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findUntrustedComponent,
  type PathStat,
  WIN_SID,
  windowsAclCommands,
  writeFileAtomic,
} from './secure-fs';

function fakeStat(entries: Record<string, Partial<PathStat> & { link?: boolean }>) {
  return (path: string): PathStat => {
    const e = entries[path];
    if (!e) throw new Error(`ENOENT ${path}`);
    return { uid: e.uid ?? 0, mode: e.mode ?? 0o40755, isSymbolicLink: () => e.link ?? false };
  };
}

describe('findUntrustedComponent', () => {
  const rootChain = { '/': {}, '/usr': {}, '/usr/local': {}, '/usr/local/bin': {} };

  test('accepts a chain that only root can modify', () => {
    const stat = fakeStat({ ...rootChain, '/usr/local/bin/tnp': { mode: 0o100755 } });
    expect(findUntrustedComponent('/usr/local/bin/tnp', stat)).toBeNull();
  });

  test('flags a user-owned directory (a Homebrew /usr/local/bin)', () => {
    const stat = fakeStat({
      ...rootChain,
      '/usr/local/bin': { uid: 501 },
      '/usr/local/bin/tnp': {},
    });
    expect(findUntrustedComponent('/usr/local/bin/tnp', stat)).toBe('/usr/local/bin');
  });

  test('flags group- or world-writable components, sticky or not', () => {
    const stat = fakeStat({ '/': {}, '/tmp': { mode: 0o41777 }, '/tmp/tnp': {} });
    expect(findUntrustedComponent('/tmp/tnp', stat)).toBe('/tmp');
    const groupWritable = fakeStat({
      ...rootChain,
      '/usr/local': { mode: 0o40775 },
      '/usr/local/bin/tnp': {},
    });
    expect(findUntrustedComponent('/usr/local/bin/tnp', groupWritable)).toBe('/usr/local');
  });

  test('flags a symlink and a missing file', () => {
    const stat = fakeStat({ ...rootChain, '/usr/local/bin/tnp': { link: true } });
    expect(findUntrustedComponent('/usr/local/bin/tnp', stat)).toBe('/usr/local/bin/tnp');
    expect(findUntrustedComponent('/usr/local/bin/missing', fakeStat(rootChain))).toBe(
      '/usr/local/bin/missing',
    );
  });
});

describe('windowsAclCommands', () => {
  test('admin-only takes ownership, clears explicit entries, then cuts inheritance', () => {
    const cmds = windowsAclCommands('icacls', 'C:\\ProgramData\\tnp', 'admin-only');
    expect(cmds.map((c) => c.args[1])).toEqual(['/setowner', '/reset', '/inheritance:r']);
    const grants = cmds[2].args.join(' ');
    expect(grants).toContain(`*${WIN_SID.system}:(OI)(CI)F`);
    expect(grants).toContain(`*${WIN_SID.administrators}:(OI)(CI)F`);
    expect(grants).not.toContain(WIN_SID.users);
  });

  test('program-dir adds read/execute for Users and nothing more', () => {
    const grants = windowsAclCommands('icacls', 'C:\\Program Files\\TNP', 'program-dir')[2].args;
    expect(grants).toContain(`*${WIN_SID.users}:(OI)(CI)RX`);
  });

  test('private-file keeps the owner and drops everyone else', () => {
    const [cmd] = windowsAclCommands(
      'icacls',
      'C:\\Users\\a\\AppData\\Local\\tnp\\identity.key',
      'private-file',
    );
    expect(cmd.args).toContain('/inheritance:r');
    expect(cmd.args).toContain(`*${WIN_SID.ownerRights}:F`);
    expect(cmd.args.join(' ')).not.toContain(WIN_SID.users);
  });
});

describe('writeFileAtomic', () => {
  test('enforces the mode even over an existing, looser file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tnp-secure-fs-'));
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, 'old', { mode: 0o644 });
      writeFileAtomic(path, 'new', { mode: 0o600 });
      expect(readFileSync(path, 'utf-8')).toBe('new');
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
