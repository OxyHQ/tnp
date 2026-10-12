/**
 * Check a release directory the way a client will. Run by
 * `.github/workflows/release-client.yml`, never shipped in the binary:
 *
 *   bun packages/client/src/release-check.ts <dir>               # before signing
 *   bun packages/client/src/release-check.ts <dir> --signed      # after signing
 *
 * Before signing it proves `SHA256SUMS` is well formed, names exactly one
 * entry per published platform binary, and matches the files in `<dir>`.
 * With `--signed` it then runs every binary through `verifyReleaseAsset` — the
 * function `tnp update` uses — against the key pinned in `@tnp/shared-types`,
 * so a release whose signature the shipped client would refuse is never
 * published.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSha256Sums,
  RELEASE_CHECKSUMS_ASSET,
  RELEASE_PLATFORM_ASSETS,
  RELEASE_SIGNATURE_ASSET,
} from '@tnp/shared-types';
import { sha256Hex, verifyReleaseAsset } from './update';

export function checkReleaseDir(
  dir: string,
  options: { readonly signed: boolean; readonly publicKey?: Uint8Array },
): string[] {
  const checksums = new Uint8Array(readFileSync(join(dir, RELEASE_CHECKSUMS_ASSET)));
  const sums = parseSha256Sums(new TextDecoder('utf-8', { fatal: true }).decode(checksums));
  const expected = Object.values(RELEASE_PLATFORM_ASSETS).sort();
  const listed = [...sums.keys()].sort();
  if (JSON.stringify(listed) !== JSON.stringify(expected)) {
    throw new Error(
      `${RELEASE_CHECKSUMS_ASSET} lists ${listed.join(', ')}; expected exactly ${expected.join(', ')}`,
    );
  }

  const signaturePath = join(dir, RELEASE_SIGNATURE_ASSET);
  const signature = options.signed ? new Uint8Array(readFileSync(signaturePath)) : null;
  if (!options.signed && existsSync(signaturePath)) {
    throw new Error(`${RELEASE_SIGNATURE_ASSET} exists before signing`);
  }

  for (const asset of expected) {
    const binary = new Uint8Array(readFileSync(join(dir, asset)));
    if (signature) {
      verifyReleaseAsset({ asset, binary, checksums, signature, publicKey: options.publicKey });
    } else if (sha256Hex(binary) !== sums.get(asset)) {
      throw new Error(`${asset} does not match its ${RELEASE_CHECKSUMS_ASSET} entry`);
    }
  }
  return expected;
}

if (import.meta.main) {
  const [dir, flag] = process.argv.slice(2);
  if (!dir || (flag !== undefined && flag !== '--signed')) {
    console.error('usage: bun packages/client/src/release-check.ts <release-dir> [--signed]');
    process.exit(2);
  }
  const signed = flag === '--signed';
  const assets = checkReleaseDir(dir, { signed });
  console.log(
    signed
      ? `verified ${assets.length} binaries against ${RELEASE_SIGNATURE_ASSET} with the pinned release key`
      : `${RELEASE_CHECKSUMS_ASSET} matches all ${assets.length} binaries`,
  );
}
