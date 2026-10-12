import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findUntrustedComponent,
  type PathStat,
  parseWindowsAclProbe,
  restrictWindowsAcl,
  settlePlainFile,
  WIN_SID,
  type WindowsAclEntry,
  type WindowsAclHost,
  type WindowsAclRule,
  windowsAclCommands,
  windowsAclProbeScript,
  windowsAclProblems,
  windowsAncestorProblems,
  windowsAncestors,
  windowsDescendantCommands,
  writeFileAtomic,
} from './secure-fs';
import type { Cmd, CmdResult } from './system-cmd';

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

  test('never recurses with icacls, and always acts on a link rather than its target', () => {
    for (const profile of ['admin-only', 'program-dir', 'private-file'] as const) {
      for (const cmd of windowsAclCommands('icacls', 'C:\\x', profile)) {
        expect(cmd.args).toContain('/L');
        expect(cmd.args).not.toContain('/T');
        expect(cmd.args).not.toContain('/C');
      }
    }
    for (const cmd of windowsDescendantCommands('icacls', ['C:\\x\\a', 'C:\\x\\b'])) {
      expect(cmd.args).toContain('/L');
      expect(cmd.args).not.toContain('/T');
    }
  });

  test('program-dir adds read/execute for Users and nothing more', () => {
    const grants = windowsAclCommands('icacls', 'C:\\Program Files\\TNP', 'program-dir')[2].args;
    expect(grants).toContain(`*${WIN_SID.users}:(OI)(CI)RX`);
  });

  test('private-file resets explicit entries first, so an old Users ACE does not survive', () => {
    const cmds = windowsAclCommands(
      'icacls',
      'C:\\Users\\a\\AppData\\Local\\tnp\\identity.key',
      'private-file',
    );
    // No /setowner: the file stays its user's.
    expect(cmds.map((c) => c.args[1])).toEqual(['/reset', '/inheritance:r']);
    expect(cmds[1].args).toContain(`*${WIN_SID.ownerRights}:F`);
    expect(cmds[1].args.join(' ')).not.toContain(WIN_SID.users);
  });
});

// ── Windows ACL probe and verification ──

const ADMIN_RULES: WindowsAclRule[] = [
  { sid: WIN_SID.system, rights: 0x1f01ff, allow: true, inheritOnly: false },
  { sid: WIN_SID.administrators, rights: 0x1f01ff, allow: true, inheritOnly: false },
];
const USER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001';

function entry(path: string, extra: Partial<WindowsAclEntry> = {}): WindowsAclEntry {
  return {
    path,
    dir: false,
    reparse: false,
    owner: WIN_SID.administrators,
    rules: ADMIN_RULES,
    ...extra,
  };
}

/** What the PowerShell probe prints for `entries`. */
function probeJson(entries: WindowsAclEntry[]): string {
  return JSON.stringify(
    entries.map((e) => ({
      ...e,
      path: Buffer.from(e.path, 'utf16le').toString('base64'),
      // Get-Acl reports masks as signed 32-bit ints.
      rules: e.rules.map((r) => ({ ...r, rights: r.rights | 0 })),
    })),
  );
}

describe('parseWindowsAclProbe', () => {
  test('round-trips paths (any characters) and unsigned masks', () => {
    const entries = [
      entry('C:\\ProgramData\\tnp', { dir: true }),
      entry("C:\\ProgramData\\tnp\\Jos\u00e9's \u2019quoted\u2019.json", {
        rules: [{ sid: WIN_SID.users, rights: 0x80000000, allow: true, inheritOnly: true }],
      }),
    ];
    const parsed = parseWindowsAclProbe(probeJson(entries));
    expect(parsed).toEqual(entries);
  });

  test('a single object (PowerShell unrolls one-element arrays) still parses', () => {
    const one = JSON.parse(probeJson([entry('C:\\x')]))[0];
    expect(parseWindowsAclProbe(JSON.stringify(one))).toHaveLength(1);
  });

  test('refuses output it does not understand rather than passing it', () => {
    expect(() => parseWindowsAclProbe('[]')).toThrow();
    expect(() => parseWindowsAclProbe('not json')).toThrow();
    const noOwner = JSON.parse(probeJson([entry('C:\\x')]));
    noOwner[0].owner = 'Administrators';
    expect(() => parseWindowsAclProbe(JSON.stringify(noOwner))).toThrow(/owner/);
    const badRule = JSON.parse(probeJson([entry('C:\\x')]));
    badRule[0].rules[0].rights = 'FullControl';
    expect(() => parseWindowsAclProbe(JSON.stringify(badRule))).toThrow(/rule/);
  });
});

describe('windowsAclProblems', () => {
  test('a locked tree passes', () => {
    const tree = [entry('C:\\ProgramData\\tnp', { dir: true }), entry('C:\\ProgramData\\tnp\\a')];
    expect(windowsAclProblems(tree, 'admin-only')).toEqual([]);
  });

  test('flags a leftover Users read entry on a config file', () => {
    const tree = [
      entry('C:\\ProgramData\\tnp', { dir: true }),
      entry('C:\\ProgramData\\tnp\\config.json', {
        rules: [
          ...ADMIN_RULES,
          { sid: WIN_SID.users, rights: 0x1200a9, allow: true, inheritOnly: false },
        ],
      }),
    ];
    expect(windowsAclProblems(tree, 'admin-only').join()).toContain(
      'config.json grants S-1-5-32-545',
    );
  });

  test('flags a user-owned file, a junction, and an unknown SID', () => {
    const problems = windowsAclProblems(
      [
        entry('C:\\d', { dir: true }),
        entry('C:\\d\\a', { owner: USER_SID }),
        entry('C:\\d\\j', { reparse: true, owner: null, rules: [] }),
        entry('C:\\d\\b', {
          rules: [{ sid: USER_SID, rights: 0x1f01ff, allow: true, inheritOnly: false }],
        }),
      ],
      'admin-only',
    );
    expect(problems).toHaveLength(3);
  });

  test('a deny entry is not a grant', () => {
    const tree = [
      entry('C:\\d', {
        rules: [
          ...ADMIN_RULES,
          { sid: USER_SID, rights: 0x1f01ff, allow: false, inheritOnly: false },
        ],
      }),
    ];
    expect(windowsAclProblems(tree, 'admin-only')).toEqual([]);
  });

  test('program-dir lets Users read and execute, never write', () => {
    const rx = { sid: WIN_SID.users, rights: 0x1200a9, allow: true, inheritOnly: false };
    expect(
      windowsAclProblems([entry('C:\\p', { rules: [...ADMIN_RULES, rx] })], 'program-dir'),
    ).toEqual([]);
    expect(
      windowsAclProblems([entry('C:\\p', { rules: [...ADMIN_RULES, rx] })], 'admin-only'),
    ).toHaveLength(1);
    const modify = { ...rx, rights: 0x1301bf };
    expect(
      windowsAclProblems([entry('C:\\p', { rules: [...ADMIN_RULES, modify] })], 'program-dir'),
    ).toHaveLength(1);
  });

  test('private-file allows OWNER RIGHTS and any owner, nobody else', () => {
    const owner = { sid: WIN_SID.ownerRights, rights: 0x1f01ff, allow: true, inheritOnly: false };
    const key = entry('C:\\Users\\a\\k', { owner: USER_SID, rules: [...ADMIN_RULES, owner] });
    expect(windowsAclProblems([key], 'private-file')).toEqual([]);
    const users = { sid: WIN_SID.users, rights: 0x1200a9, allow: true, inheritOnly: false };
    expect(
      windowsAclProblems([{ ...key, rules: [...key.rules, users] }], 'private-file'),
    ).toHaveLength(1);
  });
});

describe('windowsAncestorProblems', () => {
  // The stock ACLs of C:\ and C:\Program Files, as Get-Acl reports them.
  const AUTH_USERS = 'S-1-5-11';
  const stockRoot = entry('C:\\', {
    dir: true,
    owner: WIN_SID.trustedInstaller,
    rules: [
      ...ADMIN_RULES,
      { sid: WIN_SID.users, rights: 0x1200a9, allow: true, inheritOnly: false },
      { sid: AUTH_USERS, rights: 0x4, allow: true, inheritOnly: false },
      { sid: AUTH_USERS, rights: 0x1301bf, allow: true, inheritOnly: true },
    ],
  });
  const stockProgramFiles = entry('C:\\Program Files', {
    dir: true,
    owner: WIN_SID.trustedInstaller,
    rules: [
      { sid: WIN_SID.trustedInstaller, rights: 0x1f01ff, allow: true, inheritOnly: false },
      ...ADMIN_RULES,
      { sid: WIN_SID.users, rights: 0x1200a9, allow: true, inheritOnly: false },
      { sid: 'S-1-3-0', rights: 0x10000000, allow: true, inheritOnly: true },
      { sid: 'S-1-15-2-1', rights: 0x1200a9, allow: true, inheritOnly: false },
    ],
  });

  test('stock Windows passes', () => {
    expect(windowsAncestorProblems([stockProgramFiles, stockRoot])).toEqual([]);
  });

  test('a Program Files a user could rename or re-permission fails', () => {
    for (const rights of [0x10000, 0x40000, 0x80000, 0x40, 0x10000000, 0x1301bf]) {
      const loosened = {
        ...stockProgramFiles,
        rules: [
          ...stockProgramFiles.rules,
          { sid: USER_SID, rights, allow: true, inheritOnly: false },
        ],
      };
      expect(windowsAncestorProblems([loosened, stockRoot])).toHaveLength(1);
    }
  });

  test('a user-owned or junctioned ancestor fails', () => {
    expect(windowsAncestorProblems([{ ...stockProgramFiles, owner: USER_SID }])).toHaveLength(1);
    expect(
      windowsAncestorProblems([{ ...stockProgramFiles, reparse: true, owner: null, rules: [] }]),
    ).toHaveLength(1);
  });

  test('ancestors run from the parent up to the drive root', () => {
    expect(windowsAncestors('C:\\Program Files\\TNP')).toEqual(['C:\\Program Files', 'C:\\']);
  });
});

describe('restrictWindowsAcl (planned commands, on a fake Windows)', () => {
  function fakeHost(opts: {
    link?: boolean;
    file?: boolean;
    probes: WindowsAclEntry[][];
    failOn?: string;
  }): WindowsAclHost & { cmds: Cmd[] } {
    const cmds: Cmd[] = [];
    const probes = [...opts.probes];
    return {
      cmds,
      icacls: 'C:\\Windows\\System32\\icacls.exe',
      powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      lstat: () => ({
        isSymbolicLink: () => opts.link ?? false,
        isDirectory: () => !(opts.file ?? false),
        isFile: () => opts.file ?? false,
      }),
      run: (cmd: Cmd): CmdResult => {
        cmds.push(cmd);
        if (cmd.file.endsWith('powershell.exe')) {
          const next = probes.shift();
          if (!next) throw new Error('unexpected probe');
          return { status: 0, stdout: probeJson(next), stderr: '' };
        }
        if (opts.failOn && cmd.args.includes(opts.failOn)) {
          return { status: 5, stdout: '', stderr: 'Access is denied.' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    };
  }
  const dir = 'C:\\ProgramData\\tnp';
  const icaclsSteps = (cmds: Cmd[]) =>
    cmds.map((c) => (c.file.endsWith('powershell.exe') ? 'probe' : `${c.args[0]} ${c.args[1]}`));

  test('locks the directory, probes, resets each child one by one, then verifies', () => {
    const tree = [
      entry(dir, { dir: true }),
      entry(`${dir}\\config.json`, {
        owner: USER_SID,
        rules: [
          ...ADMIN_RULES,
          { sid: WIN_SID.users, rights: 0x1200a9, allow: true, inheritOnly: false },
        ],
      }),
    ];
    const fixed = [entry(dir, { dir: true }), entry(`${dir}\\config.json`)];
    const host = fakeHost({ probes: [tree, tree, fixed] });
    restrictWindowsAcl(dir, 'admin-only', host);
    expect(icaclsSteps(host.cmds)).toEqual([
      'probe',
      `${dir} /setowner`,
      `${dir} /reset`,
      `${dir} /inheritance:r`,
      'probe',
      `${dir}\\config.json /setowner`,
      `${dir}\\config.json /reset`,
      'probe',
    ]);
  });

  test('refuses a directory that is a junction before running anything', () => {
    const host = fakeHost({ link: true, probes: [] });
    expect(() => restrictWindowsAcl(dir, 'admin-only', host)).toThrow(/junction/);
    expect(host.cmds).toEqual([]);
  });

  test('refuses a tree holding a junction or a user-owned subdirectory, without recursing into it', () => {
    for (const planted of [
      entry(`${dir}\\x`, { dir: true, reparse: true, owner: null, rules: [] }),
      entry(`${dir}\\x`, { dir: true, owner: USER_SID }),
    ]) {
      const tree = [entry(dir, { dir: true }), planted];
      const host = fakeHost({ probes: [tree, tree] });
      expect(() => restrictWindowsAcl(dir, 'admin-only', host)).toThrow(/did not create/);
      // Nothing was run on the planted entry.
      expect(host.cmds.some((c) => c.args[0] === `${dir}\\x`)).toBe(false);
    }
  });

  test('a junction already inside stops it before any ACL changes (which would propagate)', () => {
    const tree = [
      entry(dir, { dir: true }),
      entry(`${dir}\\x`, { dir: true, reparse: true, owner: null, rules: [] }),
    ];
    const host = fakeHost({ probes: [tree] });
    expect(() => restrictWindowsAcl(dir, 'admin-only', host)).toThrow(/junctions/);
    expect(host.cmds.every((c) => c.file.endsWith('powershell.exe'))).toBe(true);
  });

  test('throws when the verified result is not what the profile allows', () => {
    const stillOpen = [
      entry(dir, { dir: true }),
      entry(`${dir}\\config.json`, {
        rules: [
          ...ADMIN_RULES,
          { sid: WIN_SID.users, rights: 0x1200a9, allow: true, inheritOnly: false },
        ],
      }),
    ];
    const host = fakeHost({ probes: [stillOpen, stillOpen, stillOpen] });
    expect(() => restrictWindowsAcl(dir, 'admin-only', host)).toThrow(/not as required/);
  });

  test('a failing icacls step stops everything', () => {
    const host = fakeHost({ probes: [[entry(dir, { dir: true })]], failOn: '/reset' });
    expect(() => restrictWindowsAcl(dir, 'admin-only', host)).toThrow(/Access is denied/);
    // Only the probe before any change ran; nothing after the failure.
    expect(host.cmds.filter((c) => c.file.endsWith('powershell.exe'))).toHaveLength(1);
  });

  test('a private file is reset, re-granted and verified without touching its owner', () => {
    const key = 'C:\\Users\\a\\AppData\\Local\\tnp\\identity.key';
    const owner = { sid: WIN_SID.ownerRights, rights: 0x1f01ff, allow: true, inheritOnly: false };
    const host = fakeHost({
      file: true,
      probes: [[entry(key, { owner: USER_SID, rules: [...ADMIN_RULES, owner] })]],
    });
    restrictWindowsAcl(key, 'private-file', host);
    expect(icaclsSteps(host.cmds)).toEqual([`${key} /reset`, `${key} /inheritance:r`, 'probe']);
  });
});

const pwshForParse = Bun.which('pwsh');

describe.skipIf(!pwshForParse)('the ACL probe script', () => {
  test('parses as PowerShell', () => {
    const script = windowsAclProbeScript(["C:\\ProgramData\\tnp's", 'C:\\\u2019x'], true);
    const result = Bun.spawnSync(
      [
        pwshForParse as string,
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$e = $null; [System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e) | Out-Null; if ($e.Count) { $e | ForEach-Object { Write-Output "ERR $_" }; exit 1 }; Write-Output OK',
      ],
      { stdin: new TextEncoder().encode(script) },
    );
    expect(result.stdout.toString()).toContain('OK');
    expect(result.exitCode).toBe(0);
  }, 60_000);

  // Get-Acl exists only on Windows, so it is stubbed here; everything else —
  // the walk, the reparse-point check, base64 paths, the JSON shape for zero,
  // one and several rules — is the real script on a real directory tree.
  test.skipIf(process.platform === 'win32')(
    'walks a real tree, stops at a symlink, and prints what the parser reads',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'tnp-acl-probe-'));
      try {
        const root = join(dir, "ré 'q'");
        mkdirSync(join(root, 'sub'), { recursive: true });
        writeFileSync(join(root, 'one.json'), '{}');
        writeFileSync(join(root, 'sub', 'none'), '');
        mkdirSync(join(dir, 'outside'));
        writeFileSync(join(dir, 'outside', 'secret'), '');
        symlinkSync(join(dir, 'outside'), join(root, 'link'));
        const stub = `function Get-Acl {
  param([string]$LiteralPath)
  $o = [pscustomobject]@{ P = $LiteralPath }
  $o | Add-Member -MemberType ScriptMethod -Name GetOwner -Value { param($t) [pscustomobject]@{ Value = '${WIN_SID.administrators}' } }
  $o | Add-Member -MemberType ScriptMethod -Name GetAccessRules -Value {
    param($a, $b, $t)
    $rule = { param($sid, $rights, $io) [pscustomobject]@{
      IdentityReference = [pscustomobject]@{ Value = $sid }
      FileSystemRights = $rights
      AccessControlType = [System.Security.AccessControl.AccessControlType]::Allow
      PropagationFlags = if ($io) { [System.Security.AccessControl.PropagationFlags]::InheritOnly } else { [System.Security.AccessControl.PropagationFlags]::None }
    } }
    if ($this.P -like '*none') { return }
    if ($this.P -like '*one.json') { return (& $rule '${WIN_SID.system}' 2032127 $false) }
    (& $rule '${WIN_SID.system}' 2032127 $false)
    (& $rule '${WIN_SID.users}' -2147483648 $true)
  }
  $o
}
`;
        const scriptPath = join(dir, 'probe.ps1');
        writeFileSync(scriptPath, stub + windowsAclProbeScript([root], true));
        const result = Bun.spawnSync(
          [pwshForParse as string, '-NoProfile', '-NonInteractive', '-File', scriptPath],
          { env: { PATH: process.env.PATH ?? '', HOME: dir } },
        );
        expect(result.stderr.toString()).toBe('');
        const entries = parseWindowsAclProbe(result.stdout.toString());
        const byName = new Map(entries.map((e) => [e.path.slice(root.length), e]));
        expect([...byName.keys()].sort()).toEqual(
          ['', '/link', '/one.json', '/sub', '/sub/none'].sort(),
        );
        expect(byName.get('/link')?.reparse).toBe(true);
        expect(entries.some((e) => e.path.includes('secret'))).toBe(false);
        expect(byName.get('/one.json')?.rules).toEqual([
          { sid: WIN_SID.system, rights: 0x1f01ff, allow: true, inheritOnly: false },
        ]);
        expect(byName.get('/sub/none')?.rules).toEqual([]);
        expect(byName.get('')?.rules).toEqual([
          { sid: WIN_SID.system, rights: 0x1f01ff, allow: true, inheritOnly: false },
          { sid: WIN_SID.users, rights: 0x80000000, allow: true, inheritOnly: true },
        ]);
        expect(byName.get('')?.dir).toBe(true);
        expect(byName.get('')?.owner).toBe(WIN_SID.administrators);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );
});

describe('settlePlainFile', () => {
  test('sets the mode of a regular file through its descriptor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tnp-settle-'));
    try {
      const path = join(dir, 'config.json');
      writeFileSync(path, '{}', { mode: 0o644 });
      const self = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 };
      expect(settlePlainFile(path, self, 0o600)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(settlePlainFile(join(dir, 'absent'), self, 0o600)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('refuses a symlink and leaves its target alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tnp-settle-'));
    try {
      const target = join(dir, 'victim');
      writeFileSync(target, 'x', { mode: 0o644 });
      const link = join(dir, 'config.json');
      symlinkSync(target, link);
      expect(() => settlePlainFile(link, null, 0o600)).toThrow(/symbolic link/);
      expect(statSync(target).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')('refuses a FIFO without blocking on it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tnp-settle-'));
    try {
      const fifo = join(dir, 'identity.key');
      const mkfifo = Bun.spawnSync(['mkfifo', fifo]);
      if (mkfifo.exitCode !== 0) return;
      expect(() => settlePlainFile(fifo, null, 0o600)).toThrow(/not a regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
