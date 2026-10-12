import { describe, expect, test } from 'bun:test';
import { CommandError, readableStderr } from './system-cmd';

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
