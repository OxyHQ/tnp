import { describe, expect, test } from 'bun:test';
import type { Cmd, CmdResult } from './system-cmd';
import {
  expandProgramData,
  isLocalAbsoluteWindowsPath,
  type RegistryHost,
  windowsProgramData,
  windowsProgramFiles,
} from './windows-paths';

/** A reg.exe that answers from a table of `<key>|<name>` → reg output. */
function fakeRegistry(values: Record<string, { type: string; value: string }>): RegistryHost & {
  calls: Cmd[];
} {
  const calls: Cmd[] = [];
  return {
    calls,
    reg: 'C:\\Windows\\System32\\reg.exe',
    run: (cmd: Cmd): CmdResult => {
      calls.push(cmd);
      const [, key, , name] = cmd.args;
      const hit = values[`${key}|${name}`];
      if (!hit) return { status: 1, stdout: '', stderr: 'ERROR: not found' };
      return {
        status: 0,
        stdout: `\r\n${key}\r\n    ${name}    ${hit.type}    ${hit.value}\r\n\r\n`,
        stderr: '',
      };
    },
  };
}

const CURRENT_VERSION = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion';
const NT_CURRENT_VERSION = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';
const PROFILE_LIST = `${NT_CURRENT_VERSION}\\ProfileList`;

describe('isLocalAbsoluteWindowsPath', () => {
  test.each(['C:\\Program Files', 'D:\\ProgramData', 'C:\\'])('accepts %s', (p) => {
    expect(isLocalAbsoluteWindowsPath(p)).toBe(true);
  });

  test.each([
    '\\\\server\\share\\Program Files',
    '\\\\?\\C:\\Program Files',
    'Program Files',
    'C:Program Files',
    '%SystemDrive%\\ProgramData',
    'C:\\%USERPROFILE%\\x',
    'C:\\Program Files\\..\\Users\\a',
    'C:\\a\nb',
    'C:\\a/b',
  ])('refuses %j', (p) => {
    expect(isLocalAbsoluteWindowsPath(p)).toBe(false);
  });
});

describe('Windows folders from HKLM', () => {
  test('ProgramFiles comes from the registry, whatever the environment says', () => {
    const saved = process.env.ProgramFiles;
    process.env.ProgramFiles = 'C:\\Users\\mallory\\pf';
    try {
      const reg = fakeRegistry({
        [`${CURRENT_VERSION}|ProgramFilesDir`]: { type: 'REG_SZ', value: 'D:\\Program Files' },
      });
      expect(windowsProgramFiles(reg)).toBe('D:\\Program Files');
    } finally {
      if (saved === undefined) delete process.env.ProgramFiles;
      else process.env.ProgramFiles = saved;
    }
  });

  test('an unreadable registry is an error, not a fallback to the environment', () => {
    expect(() => windowsProgramFiles(fakeRegistry({}))).toThrow(/refusing/);
    expect(() => windowsProgramFiles({ ...fakeRegistry({}), reg: null })).toThrow(/reg.exe/);
  });

  test('a registry value that is not a local absolute path is refused', () => {
    const reg = fakeRegistry({
      [`${CURRENT_VERSION}|ProgramFilesDir`]: { type: 'REG_SZ', value: '\\\\evil\\share' },
    });
    expect(() => windowsProgramFiles(reg)).toThrow(/not a local absolute path/);
  });

  test('ProgramData expands only %SystemDrive%, from the registry SystemRoot', () => {
    const reg = fakeRegistry({
      [`${PROFILE_LIST}|ProgramData`]: {
        type: 'REG_EXPAND_SZ',
        value: '%SystemDrive%\\ProgramData',
      },
      [`${NT_CURRENT_VERSION}|SystemRoot`]: { type: 'REG_SZ', value: 'E:\\WINDOWS' },
    });
    expect(windowsProgramData(reg)).toBe('E:\\ProgramData');
    expect(expandProgramData('%SYSTEMDRIVE%\\ProgramData', 'C:\\Windows')).toBe('C:\\ProgramData');
    expect(() => expandProgramData('%PUBLIC%\\ProgramData', 'C:\\Windows')).toThrow();
    expect(() => expandProgramData('%SystemDrive%\\ProgramData', 'Windows')).toThrow();
  });
});
