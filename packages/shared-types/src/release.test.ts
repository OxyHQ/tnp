import { describe, expect, test } from 'bun:test';
import {
  compareSemver,
  isStrictSemver,
  parseClientLatestVersion,
  parseSha256Sums,
  RELEASE_SIGNING_PUBLIC_KEY_BASE64,
  RELEASE_SIGNING_PUBLIC_KEY_PEM,
  releaseAssetUrl,
  releaseSigningPublicKey,
} from './release.js';

// The key as documented in docs/architecture/security.md §7 and the release
// workflow. A change here without a rotation is a substituted trust root.
const DOCUMENTED_KEY_BASE64 = 'n4CCDVyVmPikeULWtYh6ohrhAPvd4n9CvhdDgwVSRjw=';
const DOCUMENTED_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAn4CCDVyVmPikeULWtYh6ohrhAPvd4n9CvhdDgwVSRjw=
-----END PUBLIC KEY-----
`;

describe('release signing key', () => {
  test('the embedded key is the documented key', () => {
    expect(RELEASE_SIGNING_PUBLIC_KEY_BASE64).toBe(DOCUMENTED_KEY_BASE64);
    expect(releaseSigningPublicKey()).toHaveLength(32);
  });

  test('the derived PEM is the documented SPKI', () => {
    expect(RELEASE_SIGNING_PUBLIC_KEY_PEM).toBe(DOCUMENTED_KEY_PEM);
  });

  test('the PEM is a key node:crypto reads as the same Ed25519 key', async () => {
    const { createPublicKey } = await import('node:crypto');
    const key = createPublicKey(RELEASE_SIGNING_PUBLIC_KEY_PEM);
    expect(key.asymmetricKeyType).toBe('ed25519');
    const jwk = key.export({ format: 'jwk' }) as { x: string };
    expect(Buffer.from(jwk.x, 'base64url').toString('base64')).toBe(DOCUMENTED_KEY_BASE64);
  });
});

describe('isStrictSemver', () => {
  test.each(['0.0.0', '0.2.0', '1.10.3', '123456789.0.1'])('accepts %s', (v) => {
    expect(isStrictSemver(v)).toBe(true);
  });

  test.each([
    'v0.2.0',
    '0.2',
    '0.2.0.1',
    '00.2.0',
    '0.02.0',
    '0.2.0-rc.1',
    '0.2.0+build',
    ' 0.2.0',
    '0.2.0\n',
    '1234567890.0.0',
    '0.2.0/../../evil',
    '',
    'latest',
  ])('refuses %j', (v) => {
    expect(isStrictSemver(v)).toBe(false);
  });

  test('refuses non-strings', () => {
    expect(isStrictSemver(1)).toBe(false);
    expect(isStrictSemver(null)).toBe(false);
    expect(isStrictSemver(['0.2.0'])).toBe(false);
  });
});

describe('compareSemver', () => {
  test('orders numerically, not lexically', () => {
    expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareSemver('0.2.0', '0.2.1')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareSemver('0.2.0', '0.2.0')).toBe(0);
  });

  test('throws on a malformed version', () => {
    expect(() => compareSemver('0.2', '0.2.0')).toThrow();
    expect(() => compareSemver('0.2.0', 'v0.3.0')).toThrow();
  });
});

describe('releaseAssetUrl', () => {
  test('builds the fixed GitHub URL', () => {
    expect(releaseAssetUrl('0.3.0', 'tnp-linux-x64')).toBe(
      'https://github.com/OxyHQ/tnp/releases/download/v0.3.0/tnp-linux-x64',
    );
    expect(releaseAssetUrl('0.3.0', 'SHA256SUMS.sig')).toBe(
      'https://github.com/OxyHQ/tnp/releases/download/v0.3.0/SHA256SUMS.sig',
    );
  });

  test('refuses a malformed version or an unknown asset', () => {
    expect(() => releaseAssetUrl('0.3.0/../../x', 'tnp-linux-x64')).toThrow();
    expect(() => releaseAssetUrl('0.3.0', '../tnp-linux-x64')).toThrow();
    expect(() => releaseAssetUrl('0.3.0', 'tnp-freebsd-x64')).toThrow();
  });
});

describe('parseSha256Sums', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);

  test('reads sha256sum text and binary mode lines', () => {
    const sums = parseSha256Sums(`${a}  tnp-linux-x64\n${b} *tnp-windows-x64.exe\n`);
    expect(sums.get('tnp-linux-x64')).toBe(a);
    expect(sums.get('tnp-windows-x64.exe')).toBe(b);
  });

  test.each([
    ['empty', ''],
    ['short digest', `${'a'.repeat(63)}  tnp-linux-x64\n`],
    ['uppercase digest', `${'A'.repeat(64)}  tnp-linux-x64\n`],
    ['path in name', `${a}  ../tnp-linux-x64\n`],
    ['blank line in the middle', `${a}  tnp-linux-x64\n\n${b}  tnp-linux-arm64\n`],
    ['duplicate name', `${a}  tnp-linux-x64\n${b}  tnp-linux-x64\n`],
  ])('refuses %s', (_label, text) => {
    expect(() => parseSha256Sums(text)).toThrow();
  });
});

describe('parseClientLatestVersion', () => {
  test('returns a strict version', () => {
    expect(parseClientLatestVersion({ version: '0.3.0', platforms: {} })).toBe('0.3.0');
  });

  test.each([
    [null],
    [[]],
    [{}],
    [{ version: 3 }],
    [{ version: 'v0.3.0' }],
    [{ version: '0.3.0; rm -rf /' }],
  ])('refuses %j', (body: unknown) => {
    expect(() => parseClientLatestVersion(body)).toThrow();
  });
});
