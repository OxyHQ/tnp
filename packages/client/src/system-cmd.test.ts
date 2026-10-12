import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandError, childEnv, findSystemBinary, readableStderr, runCmd } from './system-cmd';

// The shape of what Windows PowerShell 5.1 writes to a redirected stderr when
// a command started with -NonInteractive fails.
const CLIXML =
  '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
  '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN></Obj>' +
  '<S S="Error">Get-Acl : Attempted to perform an unauthorized operation._x000D__x000A_</S>' +
  '<S S="Error">At line:12 char:12_x000D__x000A_</S>' +
  '<S S="Error">+ CategoryInfo : &lt;PermissionDenied&gt; &amp; more_x000D__x000A_</S></Objs>';

describe('readableStderr', () => {
  test('extracts the error text from PowerShell CLIXML', () => {
    expect(readableStderr(CLIXML)).toBe(
      'Get-Acl : Attempted to perform an unauthorized operation.\r\nAt line:12 char:12\r\n+ CategoryInfo : <PermissionDenied> & more\r\n',
    );
  });

  test('leaves ordinary stderr alone', () => {
    expect(readableStderr('pfctl: Permission denied\n')).toBe('pfctl: Permission denied\n');
  });

  test('CLIXML with no error records (progress only) is returned as it was', () => {
    const progress = '#< CLIXML\r\n<Objs><Obj S="progress" RefId="0"></Obj></Objs>';
    expect(readableStderr(progress)).toBe(progress);
  });
});

describe('CommandError', () => {
  test('names the PowerShell error, not "#< CLIXML"', () => {
    const err = new CommandError(
      {
        file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        args: ['-NoProfile'],
      },
      { status: 1, stdout: '', stderr: CLIXML },
    );
    expect(err.message).toEndWith(
      'failed (exit 1): Get-Acl : Attempted to perform an unauthorized operation.',
    );
  });

  test('falls back to stdout, first non-empty line', () => {
    const err = new CommandError(
      { file: '/sbin/pfctl', args: ['-E'] },
      { status: 2, stdout: '\n  No ALTQ support\nmore', stderr: '' },
    );
    expect(err.message).toBe('/sbin/pfctl -E failed (exit 2): No ALTQ support');
  });
});

describe('childEnv', () => {
  test('on Windows, leaves PSModulePath out, whatever its case', () => {
    const env = {
      Path: 'C:\\Windows',
      PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules',
      psmodulepath: 'x',
    };
    expect(childEnv(env, 'win32')).toEqual({ Path: 'C:\\Windows' });
  });

  test('elsewhere, passes the environment through', () => {
    const env = { PATH: '/usr/bin', PSModulePath: '/opt/microsoft/powershell/7/Modules' };
    expect(childEnv(env, 'linux')).toBe(env);
  });

  // The real failure: tnp started from pwsh 7 (as GitHub's Windows runners,
  // and many Windows users, run it) spawning Windows PowerShell 5.1.
  test.skipIf(process.platform !== 'win32')(
    'Windows PowerShell loads its own modules when tnp was started from pwsh',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'tnp-psmodulepath-'));
      const saved = process.env.PSModulePath;
      try {
        writeFileSync(join(dir, 'f'), 'x');
        process.env.PSModulePath = ['C:\\Program Files\\PowerShell\\7\\Modules', saved ?? ''].join(
          ';',
        );
        const res = runCmd({
          file: findSystemBinary('powershell', 'win32') as string,
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `(Get-Acl -LiteralPath '${join(dir, 'f')}').Owner`,
          ],
        });
        expect(readableStderr(res.stderr)).toBe('');
        expect(res.status).toBe(0);
        expect(res.stdout.trim()).not.toBe('');
      } finally {
        if (saved === undefined) delete process.env.PSModulePath;
        else process.env.PSModulePath = saved;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
