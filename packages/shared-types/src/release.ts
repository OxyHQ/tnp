/**
 * The client release contract: where a release's files live, how they are
 * named, which key signs them, and how a version is compared.
 *
 * Everything that downloads a TNP binary — `tnp update`, the shell and
 * PowerShell installers the API serves, and the release workflow that signs
 * the files — reads these values from here, so the trust root exists exactly
 * once in the repository (docs/architecture/security.md §7).
 *
 * A release `v<version>` carries one binary per platform, `SHA256SUMS` (the
 * `sha256sum` output over every binary) and `SHA256SUMS.sig`: the raw 64-byte
 * Ed25519 detached signature over the exact bytes of `SHA256SUMS`, made with
 * the key below. A binary is trusted only when the signature verifies with the
 * pinned key AND its SHA-256 equals the line for its asset name in the signed
 * list.
 */

/** The GitHub repository releases are published from. */
export const RELEASE_REPOSITORY = 'OxyHQ/tnp';

/**
 * The release signing public key: raw 32-byte Ed25519 key, base64.
 *
 * The matching seed is the `TNP_RELEASE_SIGNING_SEED` GitHub Actions secret.
 * Changing this value is a key rotation: follow the procedure in
 * docs/architecture/security.md §7 — never edit it to make a release verify.
 */
export const RELEASE_SIGNING_PUBLIC_KEY_BASE64 = 'n4CCDVyVmPikeULWtYh6ohrhAPvd4n9CvhdDgwVSRjw=';

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410): the raw key follows it. */
const ED25519_SPKI_PREFIX = [
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The release signing public key as raw bytes. */
export function releaseSigningPublicKey(): Uint8Array {
  const key = base64ToBytes(RELEASE_SIGNING_PUBLIC_KEY_BASE64);
  if (key.length !== 32) throw new Error('release signing key must be 32 bytes');
  return key;
}

/**
 * The same key as a PEM SubjectPublicKeyInfo, the form
 * `openssl pkeyutl -verify -pubin -inkey` reads. Derived, so it cannot drift
 * from the raw key.
 */
export const RELEASE_SIGNING_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----\n${bytesToBase64(
  new Uint8Array([...ED25519_SPKI_PREFIX, ...releaseSigningPublicKey()]),
)}\n-----END PUBLIC KEY-----\n`;

/** The checksum list every release carries. */
export const RELEASE_CHECKSUMS_ASSET = 'SHA256SUMS';
/** The raw 64-byte Ed25519 signature over {@link RELEASE_CHECKSUMS_ASSET}. */
export const RELEASE_SIGNATURE_ASSET = 'SHA256SUMS.sig';

/** Every platform a release ships a binary for, and that binary's asset name. */
export const RELEASE_PLATFORM_ASSETS = {
  'darwin-arm64': 'tnp-darwin-arm64',
  'darwin-x64': 'tnp-darwin-x64',
  'linux-arm64': 'tnp-linux-arm64',
  'linux-x64': 'tnp-linux-x64',
  'windows-x64': 'tnp-windows-x64.exe',
} as const;

export type ReleasePlatform = keyof typeof RELEASE_PLATFORM_ASSETS;

export function isReleasePlatform(value: string): value is ReleasePlatform {
  return Object.hasOwn(RELEASE_PLATFORM_ASSETS, value);
}

/** Size bounds a downloader enforces before hashing anything. */
export const MAX_RELEASE_BINARY_BYTES = 512 * 1024 * 1024;
export const MAX_RELEASE_CHECKSUMS_BYTES = 64 * 1024;
export const RELEASE_SIGNATURE_BYTES = 64;

const SEMVER_RE = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

/**
 * A strict release version: `x.y.z`, decimal, no leading zeros, no `v`, no
 * pre-release or build suffix, each part at most nine digits. Anything else is
 * refused rather than normalised — a version is interpolated into a download
 * URL and compared for downgrade protection.
 */
export function isStrictSemver(value: unknown): value is string {
  return typeof value === 'string' && SEMVER_RE.test(value);
}

function semverParts(version: string): [number, number, number] {
  const match = SEMVER_RE.exec(version);
  if (!match) throw new Error(`not a strict x.y.z version: ${JSON.stringify(version)}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a < b`, zero when equal, positive when `a > b`. Throws on a malformed version. */
export function compareSemver(a: string, b: string): number {
  const left = semverParts(a);
  const right = semverParts(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] as number) - (right[i] as number);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The only URL a release file is downloaded from. Built from a validated
 * version and a known asset name, never taken from an API response.
 */
export function releaseAssetUrl(version: string, asset: string): string {
  if (!isStrictSemver(version)) {
    throw new Error(`not a strict x.y.z version: ${JSON.stringify(version)}`);
  }
  const known =
    asset === RELEASE_CHECKSUMS_ASSET ||
    asset === RELEASE_SIGNATURE_ASSET ||
    (Object.values(RELEASE_PLATFORM_ASSETS) as string[]).includes(asset);
  if (!known) throw new Error(`unknown release asset: ${JSON.stringify(asset)}`);
  return `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${asset}`;
}

const SUMS_LINE_RE = /^([0-9a-f]{64}) [ *]([A-Za-z0-9._-]+)$/;

/**
 * Parse `sha256sum` output into asset name → lowercase hex digest.
 *
 * Strict: every non-empty line must be a digest and a plain file name, and a
 * name may appear once. A malformed list is an error, not a partial result.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  const lines = text.split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '' && index === lines.length - 1) continue;
    const match = SUMS_LINE_RE.exec(line);
    if (!match) throw new Error(`malformed SHA256SUMS line ${index + 1}`);
    const [, digest, name] = match as unknown as [string, string, string];
    if (sums.has(name)) throw new Error(`duplicate SHA256SUMS entry for ${name}`);
    sums.set(name, digest);
  }
  if (sums.size === 0) throw new Error('SHA256SUMS is empty');
  return sums;
}

/** `GET /client/latest`. `platforms` maps each platform to its binary's URL. */
export interface ClientLatestResponse {
  readonly version: string;
  readonly dns: { readonly ip: string; readonly host: string };
  readonly platforms: Readonly<Record<ReleasePlatform, string>>;
  readonly checksums: string;
  readonly signature: string;
  readonly install: { readonly unix: string; readonly windows: string };
}

/**
 * The one field of `/client/latest` a client acts on. Only the version is
 * read: download URLs are rebuilt with {@link releaseAssetUrl}, so a response
 * cannot point a client at another host.
 */
export function parseClientLatestVersion(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('/client/latest did not return an object');
  }
  const version = (body as Record<string, unknown>).version;
  if (!isStrictSemver(version)) {
    throw new Error(`/client/latest returned a malformed version: ${JSON.stringify(version)}`);
  }
  return version;
}
