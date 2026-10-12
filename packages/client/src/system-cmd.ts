/**
 * Run system commands without a shell.
 *
 * Every privileged command the client runs goes through here as an argument
 * vector: no string is ever handed to `/bin/sh` or `cmd.exe`, so a value read
 * from config or the environment cannot become shell syntax. The binaries are
 * resolved from fixed system directories rather than `$PATH`, because the
 * caller is usually root and `$PATH` usually belongs to whoever ran `sudo`.
 *
 * Commands are plain data (`Cmd`) so the code that decides *what* to run is a
 * pure function that tests can inspect on any OS; only `runCmd` touches the
 * machine.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

export interface Cmd {
  /** Absolute path of the executable. */
  file: string;
  args: string[];
  /** Written to the child's stdin, e.g. a ruleset for `pfctl -f -`. */
  input?: string;
}

export interface CmdResult {
  /** Exit status; -1 when the process could not be started at all. */
  status: number;
  stdout: string;
  stderr: string;
}

export type CmdRunner = (cmd: Cmd) => CmdResult;

export const runCmd: CmdRunner = (cmd) => {
  const res = spawnSync(cmd.file, cmd.args, {
    input: cmd.input,
    encoding: 'utf-8',
    stdio: 'pipe',
    shell: false,
    windowsHide: true,
  });
  if (res.error) {
    return { status: -1, stdout: '', stderr: res.error.message };
  }
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
};

export class CommandError extends Error {
  constructor(
    readonly cmd: Cmd,
    readonly result: CmdResult,
  ) {
    const detail = (result.stderr || result.stdout).trim().split('\n')[0] ?? '';
    super(`${formatCmd(cmd)} failed (exit ${result.status})${detail ? `: ${detail}` : ''}`);
    this.name = 'CommandError';
  }
}

/** Run a command and throw `CommandError` unless it exits 0. */
export function runChecked(cmd: Cmd, run: CmdRunner = runCmd): CmdResult {
  const result = run(cmd);
  if (result.status !== 0) throw new CommandError(cmd, result);
  return result;
}

/** Human-readable rendering for messages. Never fed back to a shell. */
export function formatCmd(cmd: Cmd): string {
  return [cmd.file, ...cmd.args]
    .map((a) => (/[\s"'$`\\]/.test(a) ? JSON.stringify(a) : a))
    .join(' ');
}

const POSIX_SYSTEM_DIRS = ['/usr/sbin', '/sbin', '/usr/bin', '/bin'];

/** `%SystemRoot%\System32`, the only place Windows system tools are taken from. */
export function windowsSystem32(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32');
}

/**
 * Absolute path of a system binary, or null when it is not installed.
 *
 * POSIX looks only in the root-owned system directories; Windows only in
 * System32. A binary that exists solely somewhere on the caller's `$PATH` is
 * deliberately not found.
 */
export function findSystemBinary(
  name: string,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (platform === 'win32') {
    const system32 = windowsSystem32();
    const candidates =
      name === 'powershell'
        ? [win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe')]
        : [win32.join(system32, `${name}.exe`)];
    return candidates.find((c) => exists(c)) ?? null;
  }
  for (const dir of POSIX_SYSTEM_DIRS) {
    const candidate = `${dir}/${name}`;
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Like `findSystemBinary`, but a missing tool is an error naming it. */
export function requireSystemBinary(
  name: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const path = findSystemBinary(name, platform);
  if (!path) throw new Error(`required system tool "${name}" was not found`);
  return path;
}

/** True when the current process is root (POSIX). Always false on Windows. */
export function isRoot(): boolean {
  return typeof process.geteuid === 'function' && process.geteuid() === 0;
}
