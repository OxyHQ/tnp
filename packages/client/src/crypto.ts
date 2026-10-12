/**
 * NaCl crypto layer for the TNP overlay network.
 *
 * Uses tweetnacl for:
 * - Ed25519 signing keypairs (service node identity)
 * - X25519 ephemeral keypairs (per-circuit key exchange)
 * - XSalsa20-Poly1305 symmetric encryption (data payloads)
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

// ---------------------------------------------------------------------------
// Ephemeral X25519 keypair (per-circuit key exchange)
// ---------------------------------------------------------------------------

export interface EphemeralKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Generate an ephemeral X25519 keypair for per-circuit key exchange.
 */
export function generateEphemeralKeypair(): EphemeralKeypair {
  const kp = nacl.box.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/**
 * Compute a shared secret from our X25519 secret key and the peer's public key.
 * Uses nacl.box.before() to precompute the XSalsa20 key.
 */
export function computeSharedKey(ourSecretKey: Uint8Array, theirPublicKey: Uint8Array): Uint8Array {
  return nacl.box.before(theirPublicKey, ourSecretKey);
}

// ---------------------------------------------------------------------------
// Symmetric encryption (XSalsa20-Poly1305 via nacl.secretbox)
// ---------------------------------------------------------------------------

/**
 * Encrypt data with a precomputed shared key.
 * Returns: nonce (24 bytes) + ciphertext.
 */
export function encrypt(data: Uint8Array, sharedKey: Uint8Array): Uint8Array {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(data, nonce, sharedKey);
  const result = new Uint8Array(nonce.length + ciphertext.length);
  result.set(nonce, 0);
  result.set(ciphertext, nonce.length);
  return result;
}

/**
 * Decrypt data with a precomputed shared key.
 * Input: nonce (24 bytes) + ciphertext.
 * Throws if decryption fails (invalid key or tampered data).
 */
export function decrypt(encrypted: Uint8Array, sharedKey: Uint8Array): Uint8Array {
  if (encrypted.byteLength < nacl.secretbox.nonceLength) {
    throw new Error('Encrypted data too short to contain a nonce');
  }

  const nonce = encrypted.subarray(0, nacl.secretbox.nonceLength);
  const ciphertext = encrypted.subarray(nacl.secretbox.nonceLength);
  const plaintext = nacl.secretbox.open(ciphertext, nonce, sharedKey);

  if (plaintext === null) {
    throw new Error('Decryption failed: invalid key or tampered data');
  }

  return plaintext;
}
