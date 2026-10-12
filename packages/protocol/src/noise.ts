/**
 * Noise_NK_25519_ChaChaPoly_SHA256 — the handshake core.
 *
 * Normative spec: docs/architecture/transport.md §9, which defers to The Noise
 * Protocol Framework, revision 34 (https://noiseprotocol.org/noise.html), §5
 * (processing rules), §7.4 (pattern NK) and §12 (25519, ChaChaPoly, SHA256).
 * This file is a direct transcription of those sections, kept free of TNP
 * specifics so it can be checked against the published test vectors
 * (noise.test.ts). TNP's prologue, message-size rules and session framing
 * live in session.ts.
 *
 *   NK:
 *     <- s
 *     ...
 *     -> e, es
 *     <- e, ee
 *
 * Not exported from `@tnp/protocol/v1`: callers use ClientHandshake and
 * ServerHandshake, which accept only a verified key-agreement key.
 */

import {
  aeadOpen,
  aeadSeal,
  hkdfSha256,
  sha256,
  wipe,
  x25519,
  type X25519KeyPair,
} from '@tnp/crypto/primitives';
import { NOISE_PROTOCOL_NAME } from './constants.js';

const HASHLEN = 32;
const DHLEN = 32;
const EMPTY = new Uint8Array(0);

/** A Noise operation failed. `kind` lets session.ts map it to a protocol error code. */
export class NoiseError extends Error {
  constructor(
    message: string,
    readonly kind: 'decrypt' | 'dh' | 'state',
  ) {
    super(message);
    this.name = 'NoiseError';
  }
}

/** Noise ChaChaPoly nonce (§12.3): 32 zero bits, then the 64-bit counter little-endian. */
export function noiseNonce(n: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, n, true);
  return nonce;
}

export function encryptWithAd(
  k: Uint8Array,
  n: bigint,
  ad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  return aeadSeal(k, noiseNonce(n), ad, plaintext);
}

export function decryptWithAd(
  k: Uint8Array,
  n: bigint,
  ad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array | null {
  return aeadOpen(k, noiseNonce(n), ad, ciphertext);
}

const MAX_NONCE = 0xffffffffffffffffn;

/** REKEY(k) (§4.2): the first 32 bytes of ENCRYPT(k, 2^64 − 1, ε, 0^32). One-way. */
export function rekey(k: Uint8Array): Uint8Array {
  return encryptWithAd(k, MAX_NONCE, EMPTY, new Uint8Array(32)).slice(0, 32);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** HKDF(ck, ikm, 2) (§4.3): RFC 5869 with salt = ck and empty info, split in two. */
function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const out = hkdfSha256(ikm, ck, EMPTY, 2 * HASHLEN);
  return [out.slice(0, HASHLEN), out.slice(HASHLEN)];
}

/** SymmetricState (§5.2), with its embedded CipherState. */
class SymmetricState {
  private ck: Uint8Array;
  private h: Uint8Array;
  private k: Uint8Array | null = null;
  private n = 0n;

  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    if (name.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(name);
    } else {
      this.h = sha256(name);
    }
    this.ck = this.h.slice();
  }

  get handshakeHash(): Uint8Array {
    return this.h.slice();
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data));
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = hkdf2(this.ck, ikm);
    wipe(this.ck);
    if (this.k) wipe(this.k);
    this.ck = ck;
    this.k = tempK;
    this.n = 0n;
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.k ? encryptWithAd(this.k, this.n++, this.h, plaintext) : plaintext;
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    let plaintext = ciphertext;
    if (this.k) {
      const opened = decryptWithAd(this.k, this.n, this.h, ciphertext);
      if (!opened) throw new NoiseError('handshake payload failed authentication', 'decrypt');
      this.n++;
      plaintext = opened;
    }
    this.mixHash(ciphertext);
    return plaintext;
  }

  /** Split() (§5.2): [initiator→responder key, responder→initiator key]. Wipes ck and k. */
  split(): [Uint8Array, Uint8Array] {
    const keys = hkdf2(this.ck, EMPTY);
    wipe(this.ck);
    if (this.k) wipe(this.k);
    this.k = null;
    return keys;
  }
}

/** What a completed handshake hands to the transport phase. */
export interface NoiseSplit {
  sendKey: Uint8Array;
  receiveKey: Uint8Array;
  /** Final `h`: a unique, public identifier of this session, usable as channel binding. */
  handshakeHash: Uint8Array;
}

function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  try {
    return x25519(secretKey, publicKey);
  } catch (err) {
    throw new NoiseError((err as Error).message, 'dh');
  }
}

/** NK initiator: knows the responder's static key in advance; has none of its own. */
export class NkInitiator {
  private readonly ss: SymmetricState;
  private readonly rs: Uint8Array;
  private readonly e: X25519KeyPair;
  private step: 'write1' | 'read2' | 'done' = 'write1';

  constructor(prologue: Uint8Array, responderStatic: Uint8Array, ephemeral: X25519KeyPair) {
    this.ss = new SymmetricState(NOISE_PROTOCOL_NAME);
    this.rs = responderStatic.slice();
    this.e = { publicKey: ephemeral.publicKey.slice(), secretKey: ephemeral.secretKey.slice() };
    this.ss.mixHash(prologue);
    this.ss.mixHash(this.rs); // pre-message: <- s
  }

  /** -> e, es, payload */
  writeMessage1(payload: Uint8Array): Uint8Array {
    if (this.step !== 'write1') throw new NoiseError('message 1 already written', 'state');
    this.step = 'read2';
    this.ss.mixHash(this.e.publicKey);
    this.ss.mixKey(dh(this.e.secretKey, this.rs));
    return concat(this.e.publicKey, this.ss.encryptAndHash(payload));
  }

  /** <- e, ee, payload */
  readMessage2(message: Uint8Array): { payload: Uint8Array; split: NoiseSplit } {
    if (this.step !== 'read2') throw new NoiseError('not expecting message 2', 'state');
    this.step = 'done';
    try {
      if (message.length < DHLEN) throw new NoiseError('message 2 too short', 'decrypt');
      const re = message.slice(0, DHLEN);
      this.ss.mixHash(re);
      this.ss.mixKey(dh(this.e.secretKey, re));
      const payload = this.ss.decryptAndHash(message.subarray(DHLEN));
      const handshakeHash = this.ss.handshakeHash;
      const [k1, k2] = this.ss.split();
      return { payload, split: { sendKey: k1, receiveKey: k2, handshakeHash } };
    } finally {
      wipe(this.e.secretKey);
    }
  }
}

/** NK responder: holds the static key the initiator already trusts. */
export class NkResponder {
  private readonly ss: SymmetricState;
  private readonly s: X25519KeyPair;
  private readonly e: X25519KeyPair;
  private step: 'read1' | 'write2' | 'done' = 'read1';

  constructor(prologue: Uint8Array, staticKey: X25519KeyPair, ephemeral: X25519KeyPair) {
    this.ss = new SymmetricState(NOISE_PROTOCOL_NAME);
    this.s = staticKey;
    this.e = { publicKey: ephemeral.publicKey.slice(), secretKey: ephemeral.secretKey.slice() };
    this.ss.mixHash(prologue);
    this.ss.mixHash(this.s.publicKey); // pre-message: <- s
  }

  private re: Uint8Array | null = null;

  /** -> e, es, payload */
  readMessage1(message: Uint8Array): Uint8Array {
    if (this.step !== 'read1') throw new NoiseError('message 1 already read', 'state');
    this.step = 'write2';
    try {
      if (message.length < DHLEN) throw new NoiseError('message 1 too short', 'decrypt');
      const re = message.slice(0, DHLEN);
      this.ss.mixHash(re);
      this.ss.mixKey(dh(this.s.secretKey, re));
      const payload = this.ss.decryptAndHash(message.subarray(DHLEN));
      this.re = re;
      return payload;
    } catch (err) {
      // A failed handshake never reaches message 2; its ephemeral is dead.
      wipe(this.e.secretKey);
      throw err;
    }
  }

  /** <- e, ee, payload */
  writeMessage2(payload: Uint8Array): { message: Uint8Array; split: NoiseSplit } {
    if (this.step !== 'write2' || !this.re) {
      throw new NoiseError('not ready to write message 2', 'state');
    }
    this.step = 'done';
    try {
      this.ss.mixHash(this.e.publicKey);
      this.ss.mixKey(dh(this.e.secretKey, this.re));
      const message = concat(this.e.publicKey, this.ss.encryptAndHash(payload));
      const handshakeHash = this.ss.handshakeHash;
      const [k1, k2] = this.ss.split();
      return { message, split: { sendKey: k2, receiveKey: k1, handshakeHash } };
    } finally {
      wipe(this.e.secretKey);
    }
  }
}
