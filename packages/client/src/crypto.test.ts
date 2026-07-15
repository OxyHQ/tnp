import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import nacl from "tweetnacl";
import {
  computeSharedKey,
  decrypt,
  encrypt,
  fromBase64,
  generateEphemeralKeypair,
  generateIdentity,
  loadOrCreateIdentity,
  toBase64,
} from "./crypto";

describe("base64 helpers", () => {
  test("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255, 128, 42]);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });

  test("round-trips the empty array", () => {
    expect(toBase64(new Uint8Array(0))).toBe("");
    expect(fromBase64("")).toEqual(new Uint8Array(0));
  });

  test("round-trips 256 random bytes", () => {
    const bytes = nacl.randomBytes(256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});

describe("generateIdentity", () => {
  test("produces Ed25519 key sizes (32-byte public, 64-byte secret)", () => {
    const id = generateIdentity();
    expect(id.publicKey.byteLength).toBe(32);
    expect(id.secretKey.byteLength).toBe(64);
  });

  test("produces a distinct keypair on each call", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(toBase64(a.secretKey)).not.toBe(toBase64(b.secretKey));
    expect(toBase64(a.publicKey)).not.toBe(toBase64(b.publicKey));
  });

  test("keypair actually signs and verifies", () => {
    const id = generateIdentity();
    const msg = new TextEncoder().encode("tnp");
    const signed = nacl.sign(msg, id.secretKey);
    expect(nacl.sign.open(signed, id.publicKey)).toEqual(msg);
  });
});

describe("generateEphemeralKeypair + computeSharedKey", () => {
  test("produces X25519 key sizes (32-byte public and secret)", () => {
    const kp = generateEphemeralKeypair();
    expect(kp.publicKey.byteLength).toBe(32);
    expect(kp.secretKey.byteLength).toBe(32);
  });

  test("both parties derive the same shared key (ECDH agreement)", () => {
    const alice = generateEphemeralKeypair();
    const bob = generateEphemeralKeypair();
    const aliceView = computeSharedKey(alice.secretKey, bob.publicKey);
    const bobView = computeSharedKey(bob.secretKey, alice.publicKey);
    expect(toBase64(aliceView)).toBe(toBase64(bobView));
  });

  test("a different peer key yields a different shared key", () => {
    const alice = generateEphemeralKeypair();
    const bob = generateEphemeralKeypair();
    const mallory = generateEphemeralKeypair();
    const withBob = computeSharedKey(alice.secretKey, bob.publicKey);
    const withMallory = computeSharedKey(alice.secretKey, mallory.publicKey);
    expect(toBase64(withBob)).not.toBe(toBase64(withMallory));
  });
});

describe("encrypt / decrypt", () => {
  function sessionKey(): Uint8Array {
    const a = generateEphemeralKeypair();
    const b = generateEphemeralKeypair();
    return computeSharedKey(a.secretKey, b.publicKey);
  }

  test("round-trips a payload through a shared key", () => {
    const key = sessionKey();
    const plaintext = new TextEncoder().encode("hello overlay network");
    const decrypted = decrypt(encrypt(plaintext, key), key);
    expect(new TextDecoder().decode(decrypted)).toBe("hello overlay network");
  });

  test("round-trips an empty payload", () => {
    const key = sessionKey();
    const decrypted = decrypt(encrypt(new Uint8Array(0), key), key);
    expect(decrypted).toEqual(new Uint8Array(0));
  });

  test("prepends a 24-byte nonce and a 16-byte Poly1305 tag", () => {
    const key = sessionKey();
    const plaintext = new Uint8Array([1, 2, 3, 4]);
    const out = encrypt(plaintext, key);
    // 24 (nonce) + 4 (plaintext) + 16 (tag)
    expect(out.byteLength).toBe(24 + 4 + 16);
  });

  test("is non-deterministic: same plaintext + key yields different ciphertext", () => {
    const key = sessionKey();
    const plaintext = new TextEncoder().encode("repeat");
    const first = encrypt(plaintext, key);
    const second = encrypt(plaintext, key);
    expect(toBase64(first)).not.toBe(toBase64(second));
    // ...but both still decrypt to the same plaintext.
    expect(decrypt(first, key)).toEqual(decrypt(second, key));
  });

  test("rejects decryption under the wrong key", () => {
    const good = sessionKey();
    const wrong = sessionKey();
    const ct = encrypt(new TextEncoder().encode("secret"), good);
    expect(() => decrypt(ct, wrong)).toThrow("Decryption failed: invalid key or tampered data");
  });

  test("rejects a tampered ciphertext byte", () => {
    const key = sessionKey();
    const ct = encrypt(new TextEncoder().encode("integrity"), key);
    // Flip a byte in the ciphertext body (past the 24-byte nonce).
    ct[30] ^= 0xff;
    expect(() => decrypt(ct, key)).toThrow("Decryption failed: invalid key or tampered data");
  });

  test("rejects a tampered nonce", () => {
    const key = sessionKey();
    const ct = encrypt(new TextEncoder().encode("integrity"), key);
    ct[0] ^= 0xff;
    expect(() => decrypt(ct, key)).toThrow("Decryption failed: invalid key or tampered data");
  });

  test("rejects input too short to hold a nonce", () => {
    const key = sessionKey();
    expect(() => decrypt(new Uint8Array(23), key)).toThrow(
      "Encrypted data too short to contain a nonce",
    );
  });
});

describe("loadOrCreateIdentity", () => {
  test("creates, persists, and reloads the same identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "tnp-identity-"));
    try {
      const keyPath = join(dir, "nested", "identity.key");
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

  test("stores keys as base64 JSON that decodes back to the raw bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "tnp-identity-"));
    try {
      const keyPath = join(dir, "identity.key");
      const created = loadOrCreateIdentity(keyPath);
      const onDisk = JSON.parse(readFileSync(keyPath, "utf-8")) as {
        publicKey: string;
        secretKey: string;
      };
      expect(fromBase64(onDisk.publicKey)).toEqual(created.publicKey);
      expect(fromBase64(onDisk.secretKey)).toEqual(created.secretKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
