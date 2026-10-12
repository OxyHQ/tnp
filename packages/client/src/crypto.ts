/**
 * The relay's registry identity key (Ed25519) and base64 helpers.
 *
 * The shared-key tunnel crypto that used to live here (one X25519 shared key
 * for both directions, random nonces, no counters — audit S5) is gone. The
 * overlay's end-to-end session is `@tnp/protocol/v1` (Noise NK + counter-nonce
 * sealed records), and its keys are in `overlay/identity.ts`.
 */

import nacl from 'tweetnacl';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { restrictWindowsAcl } from './secure-fs';

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

export function fromBase64(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

// ---------------------------------------------------------------------------
// Identity (Ed25519 signing keypair)
// ---------------------------------------------------------------------------

export interface IdentityKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Generate a new Ed25519 signing keypair (for service node identity).
 */
export function generateIdentity(): IdentityKeypair {
  const kp = nacl.sign.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/**
 * Load identity keypair from file path, or generate and save if it does not exist.
 * Stored as JSON with base64-encoded keys.
 */
export function loadOrCreateIdentity(keyPath: string): IdentityKeypair {
  if (existsSync(keyPath)) {
    // A symlink here could point root's read at a key someone else chose (or
    // at a file whose contents a JSON parse error would echo back).
    const st = lstatSync(keyPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`identity key ${keyPath} is not a regular file; refusing to use it`);
    }
    // Keys written by earlier builds, or copied in by hand, may be readable by
    // others. Tighten rather than keep using a key in that state silently.
    if (process.platform === 'win32') {
      // Keys from earlier builds inherited the directory ACL. Best-effort: a
      // failure is reported, not fatal, since the key is still the user's.
      try {
        restrictWindowsAcl(keyPath, 'private-file');
      } catch (err) {
        console.warn(
          `[tnp] could not restrict the ACL on ${keyPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else if ((st.mode & 0o077) !== 0) {
      chmodSync(keyPath, 0o600);
      console.warn(`[tnp] identity key ${keyPath} was readable by other users; set it to 0600`);
    }
    const raw = readFileSync(keyPath, 'utf-8');
    const data = JSON.parse(raw) as { publicKey: string; secretKey: string };
    return {
      publicKey: fromBase64(data.publicKey),
      secretKey: fromBase64(data.secretKey),
    };
  }

  const identity = generateIdentity();
  const dir = dirname(keyPath);
  // 0700 applies only to directories this call creates; an existing parent is
  // left alone, since it may be shared (a test's temp dir, say).
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `wx` (O_CREAT|O_EXCL) fails on anything already at the path — including a
  // symlink planted between the existence check above and this write — instead
  // of writing the secret key through it.
  writeFileSync(
    keyPath,
    `${JSON.stringify(
      {
        publicKey: toBase64(identity.publicKey),
        secretKey: toBase64(identity.secretKey),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  if (process.platform === 'win32') {
    // POSIX modes mean nothing on Windows; the ACL is the permission.
    restrictWindowsAcl(keyPath, 'private-file');
  } else {
    chmodSync(keyPath, 0o600);
  }

  return identity;
}
