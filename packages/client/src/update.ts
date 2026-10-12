/**
 * `tnp update`: download, verify and install a newer signed release.
 *
 * The API is asked one thing — the latest version number — and that answer is
 * only a hint. The download URLs are rebuilt from a fixed scheme
 * (`releaseAssetUrl`), the checksum list must carry a valid Ed25519 signature
 * from the key pinned in `@tnp/shared-types`, the binary's SHA-256 must equal
 * its line in that list, and the version must be strictly newer than the one
 * running. A compromised API can therefore withhold an update, but cannot make
 * a client install bytes the release key did not sign, or roll it back.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  compareSemver,
  isStrictSemver,
  MAX_RELEASE_BINARY_BYTES,
  MAX_RELEASE_CHECKSUMS_BYTES,
  parseClientLatestVersion,
  parseSha256Sums,
  RELEASE_CHECKSUMS_ASSET,
  RELEASE_PLATFORM_ASSETS,
  RELEASE_SIGNATURE_ASSET,
  RELEASE_SIGNATURE_BYTES,
  type ReleasePlatform,
  releaseAssetUrl,
  releaseSigningPublicKey,
} from '@tnp/shared-types';
import nacl from 'tweetnacl';

export type UpdateDecision =
  | { readonly kind: 'update'; readonly from: string; readonly to: string }
  | { readonly kind: 'current'; readonly version: string }
  | { readonly kind: 'downgrade'; readonly from: string; readonly offered: string };

/**
 * Whether `latest` should replace `current`. Only a strictly newer version is
 * an update; an equal one is current and an older one is a refused downgrade.
 * Throws on a malformed version on either side.
 */
export function decideUpdate(current: string, latest: string): UpdateDecision {
  if (!isStrictSemver(current)) throw new Error(`running version is malformed: ${current}`);
  if (!isStrictSemver(latest)) {
    throw new Error(`offered version is malformed: ${JSON.stringify(latest)}`);
  }
  const order = compareSemver(latest, current);
  if (order > 0) return { kind: 'update', from: current, to: latest };
  if (order === 0) return { kind: 'current', version: current };
  return { kind: 'downgrade', from: current, offered: latest };
}

/** The release platform this process runs on, or null when no binary is published for it. */
export function currentReleasePlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleasePlatform | null {
  const os =
    platform === 'darwin'
      ? 'darwin'
      : platform === 'linux'
        ? 'linux'
        : platform === 'win32'
          ? 'windows'
          : null;
  const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
  if (!os || !cpu) return null;
  const key = `${os}-${cpu}`;
  return key in RELEASE_PLATFORM_ASSETS ? (key as ReleasePlatform) : null;
}

export class ReleaseVerificationError extends Error {
  override name = 'ReleaseVerificationError';
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Verify a downloaded release asset. Throws {@link ReleaseVerificationError}
 * unless `signature` is a valid Ed25519 signature by `publicKey` over the
 * exact bytes of `checksums`, and `binary`'s SHA-256 is the signed entry for
 * `asset`. The signature is checked first: nothing in an unsigned list is
 * read.
 */
export function verifyReleaseAsset(input: {
  readonly asset: string;
  readonly binary: Uint8Array;
  readonly checksums: Uint8Array;
  readonly signature: Uint8Array;
  readonly publicKey?: Uint8Array;
}): void {
  const publicKey = input.publicKey ?? releaseSigningPublicKey();
  if (input.signature.length !== RELEASE_SIGNATURE_BYTES) {
    throw new ReleaseVerificationError(
      `${RELEASE_SIGNATURE_ASSET} is ${input.signature.length} bytes, expected ${RELEASE_SIGNATURE_BYTES}`,
    );
  }
  if (!nacl.sign.detached.verify(input.checksums, input.signature, publicKey)) {
    throw new ReleaseVerificationError(
      `${RELEASE_SIGNATURE_ASSET} is not a valid signature by the pinned release key`,
    );
  }
  let sums: Map<string, string>;
  try {
    sums = parseSha256Sums(new TextDecoder('utf-8', { fatal: true }).decode(input.checksums));
  } catch (err) {
    throw new ReleaseVerificationError(
      `signed ${RELEASE_CHECKSUMS_ASSET} is malformed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const expected = sums.get(input.asset);
  if (!expected) {
    throw new ReleaseVerificationError(
      `signed ${RELEASE_CHECKSUMS_ASSET} has no entry for ${input.asset}`,
    );
  }
  const actual = sha256Hex(input.binary);
  if (actual !== expected) {
    throw new ReleaseVerificationError(
      `${input.asset} SHA-256 ${actual} does not match the signed ${expected}`,
    );
  }
}

/** Download `url` into memory, refusing anything over `maxBytes` or delivered over plain HTTP. */
export async function fetchBounded(
  url: string,
  maxBytes: number,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
  if (res.url && !res.url.startsWith('https://')) {
    throw new Error(`GET ${url} was redirected off HTTPS`);
  }
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new Error(`GET ${url} is ${declared} bytes, over ${maxBytes}`);
  if (!res.body) throw new Error(`GET ${url} returned no body`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new Error(`GET ${url} exceeded ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export interface VerifiedRelease {
  readonly version: string;
  readonly asset: string;
  readonly binary: Uint8Array;
}

/** Download every file of `version` for `platform` from the fixed URLs and verify them. */
export async function downloadVerifiedRelease(
  version: string,
  platform: ReleasePlatform,
  fetchImpl: typeof fetch = fetch,
  publicKey?: Uint8Array,
): Promise<VerifiedRelease> {
  const asset = RELEASE_PLATFORM_ASSETS[platform];
  const [checksums, signature] = await Promise.all([
    fetchBounded(
      releaseAssetUrl(version, RELEASE_CHECKSUMS_ASSET),
      MAX_RELEASE_CHECKSUMS_BYTES,
      fetchImpl,
    ),
    fetchBounded(
      releaseAssetUrl(version, RELEASE_SIGNATURE_ASSET),
      RELEASE_SIGNATURE_BYTES,
      fetchImpl,
    ),
  ]);
  const binary = await fetchBounded(
    releaseAssetUrl(version, asset),
    MAX_RELEASE_BINARY_BYTES,
    fetchImpl,
  );
  verifyReleaseAsset({ asset, binary, checksums, signature, publicKey });
  return { version, asset, binary };
}

/** Ask the API for the latest version. Only the version is read from the response. */
export async function fetchLatestVersion(
  apiBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`${apiBaseUrl}/client/latest`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${apiBaseUrl}/client/latest returned ${res.status}`);
  return parseClientLatestVersion(await res.json());
}

/**
 * Whether this process is a compiled `tnp` binary. Under `bun src/cli.ts`
 * `process.execPath` is the Bun runtime itself, which an update must never
 * overwrite.
 */
export function isCompiledBinary(main: string = Bun.main): boolean {
  return main.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(main);
}

/**
 * Replace the binary at `target` with `bytes`.
 *
 * The new file is created next to the target with an exclusive create and a
 * random name (so a planted file or symlink cannot be written through),
 * flushed, made executable, then renamed over the target — atomic on POSIX,
 * where the running process keeps its old inode. Windows cannot replace a
 * running executable, so the target is first renamed aside to `<target>.old`
 * and restored if the final rename fails.
 */
export function installBinaryAtomically(
  target: string,
  bytes: Uint8Array,
  platform: NodeJS.Platform = process.platform,
): void {
  const dir = dirname(target);
  const tmp = join(dir, `.${basename(target)}.${randomBytes(8).toString('hex')}.new`);
  const fd = openSync(tmp, 'wx', 0o700);
  try {
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(fd, bytes, written, bytes.length - written);
    }
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    unlinkSync(tmp);
    throw err;
  }
  closeSync(fd);

  try {
    chmodSync(tmp, 0o755);
    if (platform === 'win32') {
      const aside = `${target}.old`;
      if (existsSync(aside)) unlinkSync(aside);
      renameSync(target, aside);
      try {
        renameSync(tmp, target);
      } catch (err) {
        renameSync(aside, target);
        throw err;
      }
    } else {
      renameSync(tmp, target);
    }
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
}
