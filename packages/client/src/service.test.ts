import { describe, expect, test } from 'bun:test';
import { autoConnectPlist, autoConnectUnit, windowsAutoConnectCommand } from './autoconnect';
import {
  encodeUtf16le,
  isCompiledBinary,
  launchdPlist,
  parseRegSz,
  SERVICE_USER,
  serviceBinaryPath,
  buildSystemdUnit,
  windowsTaskXml,
} from './service';

describe('systemd unit', () => {
  const unit = buildSystemdUnit('/usr/local/bin/tnp');
  const directives = new Set(unit.split('\n'));

  test('runs as the unprivileged service user, not root', () => {
    expect(directives.has(`User=${SERVICE_USER}`)).toBe(true);
    expect(directives.has(`Group=${SERVICE_USER}`)).toBe(true);
    expect(SERVICE_USER).not.toBe('root');
  });

  test('holds only the capability to bind port 53', () => {
    expect(directives.has('AmbientCapabilities=CAP_NET_BIND_SERVICE')).toBe(true);
    expect(directives.has('CapabilityBoundingSet=CAP_NET_BIND_SERVICE')).toBe(true);
    expect(directives.has('NoNewPrivileges=yes')).toBe(true);
  });

  test('carries the sandbox directives', () => {
    for (const d of [
      'ProtectSystem=strict',
      'ProtectHome=yes',
      'PrivateTmp=yes',
      'PrivateDevices=yes',
      'ProtectKernelTunables=yes',
      'ProtectKernelModules=yes',
      'ProtectControlGroups=yes',
      'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
      'RestrictNamespaces=yes',
      'RestrictSUIDSGID=yes',
      'LockPersonality=yes',
      'SystemCallArchitectures=native',
      'SystemCallFilter=@system-service',
      'UMask=0077',
    ]) {
      expect(directives.has(d)).toBe(true);
    }
  });

  test('its only writable path is its own state dir, never /var/lib/tnp', () => {
    // Root writes the kill-switch record under /var/lib/tnp; a directory the
    // daemon's user owned would let it plant a symlink for root to follow.
    expect(directives.has('StateDirectory=tnp-resolver')).toBe(true);
    expect(directives.has('StateDirectoryMode=0700')).toBe(true);
    expect(unit).not.toContain('StateDirectory=tnp\n');
    expect(unit).not.toContain('ReadWritePaths=');
    expect(unit).not.toContain('RuntimeDirectory=');
    expect(unit).not.toContain('DynamicUser=');
  });

  test('executes the installed binary', () => {
    expect(directives.has('ExecStart=/usr/local/bin/tnp run')).toBe(true);
  });

  test('routing-link commands run with full privileges, outside the sandbox', () => {
    // `+`: creating tnp0 and reconfiguring resolved need root, which the
    // sandboxed daemon user does not have. `-`: a failure stays non-fatal.
    const withLink = buildSystemdUnit('/usr/local/bin/tnp', {
      up: ['ip link add tnp0 type dummy'],
      down: ['ip link delete tnp0'],
    });
    expect(withLink).toContain("ExecStartPost=-+/bin/sh -c 'ip link add tnp0 type dummy'");
    expect(withLink).toContain("ExecStopPost=-+/bin/sh -c 'ip link delete tnp0'");
  });
});

describe('service binary location', () => {
  test('POSIX services run the root-owned install path', () => {
    expect(serviceBinaryPath('linux')).toBe('/usr/local/bin/tnp');
    expect(serviceBinaryPath('darwin')).toBe('/usr/local/bin/tnp');
  });

  test('Windows services run the copy under Program Files, never a temp or bunfs path', () => {
    const path = serviceBinaryPath('win32', () => 'C:\\Program Files');
    expect(path.endsWith('\\TNP\\tnp.exe')).toBe(true);
    expect(path).not.toContain('$bunfs');
    expect(path).not.toContain('usr\\local');
  });

  test('only a compiled binary is installable', () => {
    expect(isCompiledBinary('/$bunfs/root/tnp')).toBe(true);
    expect(isCompiledBinary('B:\\~BUN\\root\\tnp.exe')).toBe(true);
    expect(isCompiledBinary('B:/~BUN/root/tnp.exe')).toBe(true);
    expect(isCompiledBinary('/home/me/tnp/packages/client/src/cli.ts')).toBe(false);
  });

  test('reads ProgramFilesDir from reg output', () => {
    const out =
      '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\r\n    ProgramFilesDir    REG_SZ    D:\\Program Files\r\n\r\n';
    expect(parseRegSz(out, 'ProgramFilesDir')).toBe('D:\\Program Files');
    expect(parseRegSz(out, 'CommonFilesDir')).toBeNull();
  });
});

describe('launchd and Task Scheduler definitions', () => {
  test('plist escapes paths and sets a private umask', () => {
    const plist = launchdPlist('/opt/a&b/<tnp>', '/var/log/tnp-resolver.log');
    expect(plist).toContain('<string>/opt/a&amp;b/&lt;tnp&gt;</string>');
    expect(plist).toContain('<key>Umask</key>\n  <integer>63</integer>');
  });

  test('task XML runs the given binary as SYSTEM with escaping', () => {
    const xml = windowsTaskXml('C:\\Program Files\\TNP & Co\\tnp.exe');
    expect(xml).toContain('<Command>C:\\Program Files\\TNP &amp; Co\\tnp.exe</Command>');
    expect(xml).toContain('<UserId>S-1-5-18</UserId>');
  });

  test('task XML is encoded UTF-16LE with a BOM', () => {
    const bytes = encodeUtf16le('<T/>');
    expect([...bytes.subarray(0, 4)]).toEqual([0xff, 0xfe, 0x3c, 0x00]);
  });
});

describe('autoconnect definitions', () => {
  test('the elevated Windows logon task is an argument vector naming the given binary', () => {
    const cmd = windowsAutoConnectCommand(
      'C:\\Windows\\System32\\schtasks.exe',
      'C:\\Program Files\\TNP\\tnp.exe',
    );
    expect(cmd.args).toEqual([
      '/Create',
      '/TN',
      'TnpAutoConnect',
      '/TR',
      '"C:\\Program Files\\TNP\\tnp.exe" connect',
      '/SC',
      'ONLOGON',
      '/RL',
      'HIGHEST',
      '/F',
    ]);
  });

  test('per-user units name the binary they are given', () => {
    expect(autoConnectUnit('/usr/local/bin/tnp')).toContain('ExecStart=/usr/local/bin/tnp connect');
    expect(autoConnectPlist('/a&b')).toContain('<string>/a&amp;b</string>');
  });
});
