import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import nacl from 'tweetnacl';
import { fromBase64, generateIdentity, loadOrCreateIdentity, toBase64 } from './crypto';
import { probeWindowsAcl, WIN_SID, windowsAclProblems } from './secure-fs';
import { findSystemBinary, runChecked, runCmd } from './system-cmd';

/** On Windows the ACL is the permission: what the real probe reads for `path`. */
function windowsKeyProblems(path: string): string[] {
  const powershell = findSystemBinary('powershell', 'win32') as string;
  return windowsAclProblems(
    probeWindowsAcl({ run: runCmd, powershell }, [path], false),
    'private-file',
  );
}

describe('base64 helpers', () => {
  test('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 42]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  test('round-trips the empty array', () => {
    expect(toBase64(new Uint8Array(0))).toBe('');
    expect(fromBase64('')).toEqual(new Uint8Array(0));
  });

  test('round-trips 256 random bytes', () => {
    const bytes = nacl.randomBytes(256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});

describe('generateIdentity', () => {
  test('produces Ed25519 key sizes (32-byte public, 64-byte secret)', () => {
    const id = generateIdentity();
    expect(id.publicKey.byteLength).toBe(32);
    expect(id.secretKey.byteLength).toBe(64);
  });

  test('produces a distinct keypair on each call', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(toBase64(a.secretKey)).not.toBe(toBase64(b.secretKey));
    expect(toBase64(a.publicKey)).not.toBe(toBase64(b.publicKey));
  });

  test('keypair actually signs and verifies', () => {
    const id = generateIdentity();
    const msg = new TextEncoder().encode('tnp');
    const signed = nacl.sign(msg, id.secretKey);
    expect(nacl.sign.open(signed, id.publicKey)).toEqual(msg);
  });
});

describe('loadOrCreateIdentity', () => {
  test('creates, persists, and reloads the same identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tnp-identity-'));
    try {
      const keyPath = join(dir, 'nested', 'identity.key');
      expect(existsSync(keyPath)).toBe(false);

      const created = loadOrCreateIdentity(keyPath);
      expect(existsSync(keyPath)).toBe(true);
      expect(created.publicKey.byteLength).toBe(32);
      expect(created.secretKey.byteLength).toBe(64);

      // Second call must reload the persisted keys, not mint new ones.
      const reloaded = loadOrCreateIdentity(keyPath);
      expect(toBase64(reloaded.publicKey)).toBe(toBase64(created.publicKey));
      expect(toBase64(reloaded.secretKey)).toBe(toBase64(created.secretKey));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stores keys as base64 JSON that decodes back to the raw bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tnp-identity-'));
    try {
      const keyPath = join(dir, 'identity.key');
      const created = loadOrCreateIdentity(keyPath);
      const onDisk = JSON.parse(readFileSync(keyPath, 'utf-8')) as {
        publicKey: string;
        secretKey: string;
      };
      expect(fromBase64(onDisk.publicKey)).toEqual(created.publicKey);
      expect(fromBase64(onDisk.secretKey)).toEqual(created.secretKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test('writes the key 0600 inside a 0700 directory it creates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tnp-identity-'));
    try {
      const keyPath = join(dir, 'state', 'identity.key');
      loadOrCreateIdentity(keyPath);
      if (process.platform === 'win32') {
        expect(windowsKeyProblems(keyPath)).toEqual([]);
      } else {
        expect(statSync(keyPath).mode & 0o777).toBe(0o600);
        expect(statSync(join(dir, 'state')).mode & 0o777).toBe(0o700);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('tightens a key an earlier build left readable by others', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tnp-identity-'));
    try {
      const keyPath = join(dir, 'identity.key');
      const created = loadOrCreateIdentity(keyPath);
      if (process.platform === 'win32') {
        // What an older build left: an explicit read grant for Users.
        const icacls = findSystemBinary('icacls', 'win32') as string;
        runChecked({ file: icacls, args: [keyPath, '/grant', `*${WIN_SID.users}:R`] });
        expect(windowsKeyProblems(keyPath).join(' ')).toContain(WIN_SID.users);
      } else {
        chmodSync(keyPath, 0o644);
      }
      const reloaded = loadOrCreateIdentity(keyPath);
      expect(toBase64(reloaded.publicKey)).toBe(toBase64(created.publicKey));
      if (process.platform === 'win32') expect(windowsKeyProblems(keyPath)).toEqual([]);
      else expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to read a key through a symlink', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tnp-identity-'));
    try {
      const elsewhere = join(dir, 'attacker.key');
      writeFileSync(elsewhere, JSON.stringify({ publicKey: 'AA==', secretKey: 'AA==' }));
      const keyPath = join(dir, 'identity.key');
      symlinkSync(elsewhere, keyPath);
      expect(() => loadOrCreateIdentity(keyPath)).toThrow('not a regular file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
