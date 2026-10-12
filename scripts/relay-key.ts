#!/usr/bin/env bun

/**
 * Print the Ed25519 public key (canonical base64) of a base64 32-byte seed —
 * the value to list for a relay in `TNP_OXY_RELAYS` (`relayKey`) for its
 * `RELAY_KEY_SEED`, or to pin in `@tnp/shared-types` for a
 * `TNP_DIRECTORY_SIGNING_SEED`.
 *
 *   bun scripts/relay-key.ts < relay-signing-seed.b64
 *   bun scripts/relay-key.ts ~/.local/share/tnp/relay-signing-seed.b64
 *
 * The seed is read from a file or stdin, never from the command line (where
 * it would land in shell history and `ps`), and is never printed. Standard
 * library only.
 *
 * Generating a seed (outside the repository; keep only the seed, offline or in
 * SSM):
 *
 *   openssl genpkey -algorithm ed25519 -out key.pem
 *   openssl pkey -in key.pem -outform DER | tail -c 32 | base64 -w0 > seed.b64
 *   openssl pkey -in key.pem -pubout -outform DER | tail -c 32 | base64 -w0   # public key
 *   shred -u key.pem
 */

import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

// RFC 8410 PKCS#8 prefix for an Ed25519 private key: the 32-byte seed follows.
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function publicKeyFromSeed(seedBase64: string): string {
  const text = seedBase64.trim();
  const seed = Buffer.from(text, 'base64');
  if (seed.length !== 32 || seed.toString('base64') !== text) {
    throw new Error('the seed must be canonical base64 of exactly 32 bytes');
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return Buffer.from(spki.subarray(spki.length - 32)).toString('base64');
}

if (import.meta.main) {
  const path = process.argv[2];
  const input = path ? readFileSync(path, 'utf8') : readFileSync(0, 'utf8');
  try {
    console.log(publicKeyFromSeed(input));
  } catch (err) {
    console.error(`relay-key: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
