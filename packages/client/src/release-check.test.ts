/**
 * The release pipeline's two halves: `.github/scripts/sign-release.sh` signs
 * with OpenSSL from the raw seed, and `checkReleaseDir` (the client's own
 * verification) must accept exactly what it produces. Running both here is
 * what proves OpenSSL's Ed25519 and tweetnacl's agree on this key format.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_PLATFORM_ASSETS } from '@tnp/shared-types';
import nacl from 'tweetnacl';
import { checkReleaseDir } from './release-check';
import { sha256Hex } from './update';

const SIGN_SCRIPT = join(import.meta.dir, '../../../.github/scripts/sign-release.sh');
const assets = Object.values(RELEASE_PLATFORM_ASSETS);
const seed = new Uint8Array(32).map((_, i) => i * 7 + 1);
const keys = nacl.sign.keyPair.fromSeed(seed);
const seedB64 = Buffer.from(seed).toString('base64');
const hasOpenSsl3 = /^OpenSSL ([3-9]|[1-9][0-9]+)\./.test(
  Bun.spawnSync(['openssl', 'version']).stdout.toString(),
);

let root: string;
let counter = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tnp-release-check-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function releaseDir(opts: { omit?: string; extra?: string; tamper?: string } = {}): string {
  const dir = join(root, `release-${counter++}`);
  mkdirSync(dir);
  const lines: string[] = [];
  for (const asset of assets) {
    if (asset === opts.omit) continue;
    const bytes = new TextEncoder().encode(`binary for ${asset}\n`);
    writeFileSync(join(dir, asset), opts.tamper === asset ? 'tampered' : bytes);
    lines.push(`${sha256Hex(bytes)}  ${asset}\n`);
  }
  if (opts.extra) lines.push(`${'0'.repeat(64)}  ${opts.extra}\n`);
  writeFileSync(join(dir, 'SHA256SUMS'), lines.join(''));
  return dir;
}

function signWithNacl(dir: string, secretKey = keys.secretKey): void {
  writeFileSync(
    join(dir, 'SHA256SUMS.sig'),
    nacl.sign.detached(new Uint8Array(readFileSync(join(dir, 'SHA256SUMS'))), secretKey),
  );
}

describe('checkReleaseDir', () => {
  test('accepts a complete unsigned release before signing', () => {
    expect(checkReleaseDir(releaseDir(), { signed: false })).toEqual([...assets].sort());
  });

  test('accepts a complete release signed by the key', () => {
    const dir = releaseDir();
    signWithNacl(dir);
    expect(() => checkReleaseDir(dir, { signed: true, publicKey: keys.publicKey })).not.toThrow();
  });

  test('refuses a release signed by another key', () => {
    const dir = releaseDir();
    signWithNacl(dir, nacl.sign.keyPair.fromSeed(new Uint8Array(32)).secretKey);
    expect(() => checkReleaseDir(dir, { signed: true, publicKey: keys.publicKey })).toThrow(
      /not a valid signature/,
    );
  });

  test('refuses a release the pinned key did not sign', () => {
    const dir = releaseDir();
    signWithNacl(dir);
    expect(() => checkReleaseDir(dir, { signed: true })).toThrow(/not a valid signature/);
  });

  test('refuses a missing platform, an extra entry or a tampered binary', () => {
    expect(() => checkReleaseDir(releaseDir({ omit: 'tnp-linux-x64' }), { signed: false })).toThrow(
      /expected exactly/,
    );
    expect(() => checkReleaseDir(releaseDir({ extra: 'notes.txt' }), { signed: false })).toThrow(
      /expected exactly/,
    );
    expect(() =>
      checkReleaseDir(releaseDir({ tamper: 'tnp-darwin-x64' }), { signed: false }),
    ).toThrow(/does not match/);
  });

  test('refuses a signature present before signing', () => {
    const dir = releaseDir();
    signWithNacl(dir);
    expect(() => checkReleaseDir(dir, { signed: false })).toThrow(/before signing/);
  });
});

// sign-release.sh is a GNU/Linux tool (`base64 -w0`, `sha256sum`, GNU `wc`)
// that only ever runs in the ubuntu release job; on macOS and Windows its
// coreutils differ, so it is tested where it runs.
describe.skipIf(!hasOpenSsl3 || process.platform !== 'linux')(
  '.github/scripts/sign-release.sh',
  () => {
    function keySource(publicKey: Uint8Array): string {
      const file = join(root, `release-${counter++}.ts`);
      writeFileSync(
        file,
        `export const RELEASE_SIGNING_PUBLIC_KEY_BASE64 = '${Buffer.from(publicKey).toString('base64')}';\n`,
      );
      return file;
    }

    function sign(dir: string, env: Record<string, string>) {
      const result = Bun.spawnSync(['bash', SIGN_SCRIPT, dir], {
        env: { PATH: process.env.PATH ?? '', ...env },
      });
      return {
        exitCode: result.exitCode,
        output: result.stdout.toString() + result.stderr.toString(),
      };
    }

    test('signs exactly as tweetnacl does, and the client verification accepts it', () => {
      const dir = releaseDir();
      const r = sign(dir, {
        TNP_RELEASE_SIGNING_SEED: seedB64,
        TNP_RELEASE_KEY_SOURCE: keySource(keys.publicKey),
      });
      expect(r.output).toContain('Signed SHA256SUMS');
      expect(r.exitCode).toBe(0);
      const sums = new Uint8Array(readFileSync(join(dir, 'SHA256SUMS')));
      const sig = new Uint8Array(readFileSync(join(dir, 'SHA256SUMS.sig')));
      expect(Buffer.from(sig)).toEqual(Buffer.from(nacl.sign.detached(sums, keys.secretKey)));
      expect(() => checkReleaseDir(dir, { signed: true, publicKey: keys.publicKey })).not.toThrow();
    });

    test('refuses a seed that does not derive the pinned key — the real one included', () => {
      const envs: Record<string, string>[] = [
        { TNP_RELEASE_SIGNING_SEED: seedB64 },
        {
          TNP_RELEASE_SIGNING_SEED: seedB64,
          TNP_RELEASE_KEY_SOURCE: keySource(
            nacl.sign.keyPair.fromSeed(new Uint8Array(32)).publicKey,
          ),
        },
      ];
      for (const env of envs) {
        const dir = releaseDir();
        const r = sign(dir, env);
        expect(r.exitCode).not.toBe(0);
        expect(r.output).toContain('does not derive the pinned release public key');
        expect(existsSync(join(dir, 'SHA256SUMS.sig'))).toBe(false);
      }
    });

    test('refuses a missing or malformed seed', () => {
      for (const seedValue of ['', 'abc', Buffer.alloc(31).toString('base64')]) {
        const dir = releaseDir();
        const r = sign(dir, {
          TNP_RELEASE_SIGNING_SEED: seedValue,
          TNP_RELEASE_KEY_SOURCE: keySource(keys.publicKey),
        });
        expect(r.exitCode).not.toBe(0);
        expect(existsSync(join(dir, 'SHA256SUMS.sig'))).toBe(false);
      }
    });

    test('refuses when a binary does not match SHA256SUMS', () => {
      const dir = releaseDir({ tamper: 'tnp-linux-arm64' });
      const r = sign(dir, {
        TNP_RELEASE_SIGNING_SEED: seedB64,
        TNP_RELEASE_KEY_SOURCE: keySource(keys.publicKey),
      });
      expect(r.exitCode).not.toBe(0);
      expect(existsSync(join(dir, 'SHA256SUMS.sig'))).toBe(false);
    });
  },
);
