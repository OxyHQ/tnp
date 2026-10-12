/**
 * Windows machine folders, read from HKLM rather than the environment.
 *
 * An elevated process inherits the user's environment, and a user can define
 * `ProgramFiles`, `ProgramData` or `SystemRoot` for themselves (HKCU\Environment
 * overrides the machine values). Anything an elevated TNP decides from those
 * variables — where SYSTEM's binary lives, which directory it locks down or
 * purges — would then be chosen by whatever runs as that user. So these
 * folders come from the machine registry, and a value that cannot be read or
 * does not look like a local absolute path is refused rather than guessed.
 *
 * Residual: `reg.exe` itself is located under `%SystemRoot%\System32`
 * (system-cmd.ts), which is still the environment's. See
 * docs/architecture/platforms.md.
 */

import { win32 } from 'node:path';
import { type CmdRunner, findSystemBinary, runCmd } from './system-cmd';

/** Value of a `REG_SZ` / `REG_EXPAND_SZ` line in `reg query` output, or null. */
export function parseRegSz(output: string, name: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (m && m[1].toLowerCase() === name.toLowerCase()) return m[2];
  }
  return null;
}

/**
 * A plain local absolute path: a drive letter, a backslash, no environment
 * reference left unexpanded, no `.`/`..` segment, not a UNC or device path.
 */
export function isLocalAbsoluteWindowsPath(path: string): boolean {
  if (!/^[A-Za-z]:\\/.test(path)) return false;
  if (/[%\0\r\n"<>|?*/]/.test(path.slice(2))) return false;
  return !path
    .slice(3)
    .split('\\')
    .some((segment) => segment === '.' || segment === '..');
}

/** How the registry is read; injectable so tests run on any OS. */
export interface RegistryHost {
  run: CmdRunner;
  /** Absolute path of reg.exe, or null when it is missing. */
  reg: string | null;
}

const systemRegistry = (): RegistryHost => ({
  run: runCmd,
  reg: findSystemBinary('reg', 'win32'),
});

function readHklm(key: string, name: string, host: RegistryHost): string {
  if (!host.reg) throw new Error(`reg.exe not found; cannot read ${name} from the registry`);
  const res = host.run({ file: host.reg, args: ['query', key, '/v', name] });
  const value = res.status === 0 ? parseRegSz(res.stdout, name) : null;
  if (!value) {
    throw new Error(
      `could not read ${name} from ${key}; refusing to take it from the environment instead`,
    );
  }
  return value;
}

function checked(name: string, path: string): string {
  if (!isLocalAbsoluteWindowsPath(path)) {
    throw new Error(
      `${name} from the registry is ${JSON.stringify(path)}, not a local absolute path; refusing to use it`,
    );
  }
  return win32.normalize(path);
}

/** `%ProgramFiles%` from HKLM. */
export function windowsProgramFiles(host: RegistryHost = systemRegistry()): string {
  return checked(
    'ProgramFilesDir',
    readHklm('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion', 'ProgramFilesDir', host),
  );
}

/** `%SystemRoot%` from HKLM. */
export function windowsSystemRoot(host: RegistryHost = systemRegistry()): string {
  return checked(
    'SystemRoot',
    readHklm('HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', 'SystemRoot', host),
  );
}

/**
 * Expand the ProfileList `ProgramData` value (normally `%SystemDrive%\ProgramData`)
 * using the drive of the registry's SystemRoot. Only `%SystemDrive%` is
 * expanded; any other variable is refused, since expanding it would mean
 * reading the environment this exists to avoid.
 */
export function expandProgramData(raw: string, systemRoot: string): string {
  const drive = /^([A-Za-z]:)\\/.exec(systemRoot)?.[1];
  if (!drive) throw new Error(`SystemRoot ${JSON.stringify(systemRoot)} has no drive letter`);
  return checked('ProgramData', raw.replace(/%SystemDrive%/gi, drive));
}

let programDataCache: string | null = null;

/** `%ProgramData%` from HKLM (memoized: it cannot change under a running process). */
export function windowsProgramData(host?: RegistryHost): string {
  if (host || programDataCache === null) {
    const registry = host ?? systemRegistry();
    const raw = readHklm(
      'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList',
      'ProgramData',
      registry,
    );
    const value = expandProgramData(raw, windowsSystemRoot(registry));
    if (host) return value;
    programDataCache = value;
  }
  return programDataCache;
}
