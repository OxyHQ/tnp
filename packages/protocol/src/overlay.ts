/**
 * TNP wire protocol v1 — the single-hop overlay: what travels in the frames a
 * client, a relay and a service node exchange.
 *
 * Normative spec: docs/architecture/transport.md §11.
 *
 * What a relay can read is deliberately small:
 *
 *  - CIRCUIT_CREATE: a cleartext routing prefix — the destination NAME, which a
 *    single-hop relay needs to pick the service node — and the 48-byte Noise
 *    message 1. Nothing else.
 *  - CIRCUIT_CREATED: the 48-byte Noise message 2, produced by the service node.
 *    A relay that answers on its own fails key confirmation.
 *  - STREAM_DATA (stream E2E_STREAM_ID): one sealed record. Everything the two
 *    ends say to each other — which port to open, whether it opened, the bytes,
 *    flow-control credit, resets with their error codes, the authenticated
 *    close — is a `StreamMessage` INSIDE the record, so the relay cannot tell an
 *    open from data from a half-close.
 *  - CIRCUIT_DESTROY: a u16 reason. The ends send DESTROY_NORMAL only; the real
 *    reason, if any, travelled sealed.
 *
 * Service-node registration at a relay (relays.md §2) uses HELLO (relay →
 * node, 32-byte challenge), AUTH (node → relay, JSON proof) and AUTH_OK.
 */

import {
  ErrorCode,
  HANDSHAKE_MESSAGE_SIZE,
  MAX_FRAME_PAYLOAD,
  MAX_SEALED_PLAINTEXT,
} from './constants.js';
import { FrameDecodeError } from './frame.js';

/** The one stream every end-to-end record is carried on. Bound into each record's AD. */
export const E2E_STREAM_ID = 1;

/** CIRCUIT_DESTROY reason the ends always use: the real reason, if any, travelled sealed. */
export const DESTROY_NORMAL = 0;

/** Longest name in a routing prefix (DNS limit). */
export const MAX_ROUTING_NAME = 253;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isCanonicalName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_ROUTING_NAME &&
    value.split('.').every((label) => LABEL.test(label))
  );
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function violation(message: string): FrameDecodeError {
  return new FrameDecodeError(message, ErrorCode.PROTOCOL_VIOLATION);
}

// ---------------------------------------------------------------------------
// CIRCUIT_CREATE / CIRCUIT_CREATED / CIRCUIT_DESTROY
// ---------------------------------------------------------------------------

/** CIRCUIT_CREATE payload: u8 nameLength ‖ name (canonical, ASCII) ‖ Noise message 1. */
export function encodeCircuitCreate(name: string, message1: Uint8Array): Uint8Array {
  if (!isCanonicalName(name)) throw new RangeError('routing name is not a canonical name');
  if (message1.length !== HANDSHAKE_MESSAGE_SIZE) {
    throw new RangeError(`handshake message must be ${HANDSHAKE_MESSAGE_SIZE} bytes`);
  }
  const nameBytes = textEncoder.encode(name);
  const out = new Uint8Array(1 + nameBytes.length + HANDSHAKE_MESSAGE_SIZE);
  out[0] = nameBytes.length;
  out.set(nameBytes, 1);
  out.set(message1, 1 + nameBytes.length);
  return out;
}

export function decodeCircuitCreate(payload: Uint8Array): { name: string; message1: Uint8Array } {
  if (payload.length < 2 + HANDSHAKE_MESSAGE_SIZE) throw violation('CIRCUIT_CREATE too short');
  const nameLength = payload[0];
  if (nameLength === 0 || payload.length !== 1 + nameLength + HANDSHAKE_MESSAGE_SIZE) {
    throw violation('CIRCUIT_CREATE length does not match its routing prefix');
  }
  let name: string;
  try {
    name = textDecoder.decode(payload.subarray(1, 1 + nameLength));
  } catch {
    throw violation('CIRCUIT_CREATE routing name is not UTF-8');
  }
  if (!isCanonicalName(name)) throw violation('CIRCUIT_CREATE routing name is not canonical');
  return { name, message1: payload.slice(1 + nameLength) };
}

/** CIRCUIT_CREATED payload is exactly Noise message 2. */
export function decodeCircuitCreated(payload: Uint8Array): Uint8Array {
  if (payload.length !== HANDSHAKE_MESSAGE_SIZE) throw violation('CIRCUIT_CREATED wrong size');
  return payload;
}

/** CIRCUIT_DESTROY payload: u16 reason. */
export function encodeDestroy(reason: number): Uint8Array {
  if (!Number.isInteger(reason) || reason < 0 || reason > 0xffff) {
    throw new RangeError('destroy reason out of range');
  }
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, reason, false);
  return out;
}

export function decodeDestroy(payload: Uint8Array): number {
  if (payload.length !== 2) throw violation('CIRCUIT_DESTROY payload must be 2 bytes');
  return new DataView(payload.buffer, payload.byteOffset, 2).getUint16(0, false);
}

// ---------------------------------------------------------------------------
// Stream messages — the plaintext of every sealed DATA record
// ---------------------------------------------------------------------------

export const StreamMessageType = {
  /** client → service node, first record: u16 port. */
  OPEN: 0x01,
  /** service node → client, first record: the target accepted. */
  OPENED: 0x02,
  /** Application bytes. */
  DATA: 0x03,
  /** Abort: u16 error code. The sender then sends its authenticated close. */
  RESET: 0x04,
  /** Flow-control credit: u32 bytes. */
  WINDOW: 0x05,
  /**
   * The sender has no more application data (a half-close). Authenticated and
   * in sequence, so a relay that cuts a stream short cannot make it look
   * finished: data ends only at a FIN. The session's own CLOSE record follows
   * once both sides have sent FIN — it cannot carry the half-close, because a
   * side that has half-closed must still be able to send WINDOW credit.
   */
  FIN: 0x06,
} as const;

/** Largest application chunk one record carries. */
export const MAX_STREAM_DATA = MAX_SEALED_PLAINTEXT - 1;

export type StreamMessage =
  | { type: 'open'; port: number }
  | { type: 'opened' }
  | { type: 'data'; data: Uint8Array }
  | { type: 'reset'; code: number }
  | { type: 'window'; credit: number }
  | { type: 'fin' };

export function encodeStreamMessage(message: StreamMessage): Uint8Array {
  switch (message.type) {
    case 'open': {
      if (!Number.isInteger(message.port) || message.port < 1 || message.port > 0xffff) {
        throw new RangeError('port out of range');
      }
      const out = new Uint8Array(3);
      out[0] = StreamMessageType.OPEN;
      new DataView(out.buffer).setUint16(1, message.port, false);
      return out;
    }
    case 'opened':
      return Uint8Array.of(StreamMessageType.OPENED);
    case 'data': {
      if (message.data.length === 0 || message.data.length > MAX_STREAM_DATA) {
        throw new RangeError('data chunk empty or too large');
      }
      const out = new Uint8Array(1 + message.data.length);
      out[0] = StreamMessageType.DATA;
      out.set(message.data, 1);
      return out;
    }
    case 'reset': {
      if (!Number.isInteger(message.code) || message.code < 0 || message.code > 0xffff) {
        throw new RangeError('reset code out of range');
      }
      const out = new Uint8Array(3);
      out[0] = StreamMessageType.RESET;
      new DataView(out.buffer).setUint16(1, message.code, false);
      return out;
    }
    case 'fin':
      return Uint8Array.of(StreamMessageType.FIN);
    case 'window': {
      if (!Number.isInteger(message.credit) || message.credit < 1 || message.credit > 0xffffffff) {
        throw new RangeError('window credit out of range');
      }
      const out = new Uint8Array(5);
      out[0] = StreamMessageType.WINDOW;
      new DataView(out.buffer).setUint32(1, message.credit, false);
      return out;
    }
  }
}

/** Strict: every type has an exact length, unknown types are violations. */
export function decodeStreamMessage(plaintext: Uint8Array): StreamMessage {
  if (plaintext.length === 0) throw violation('empty stream message');
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  switch (plaintext[0]) {
    case StreamMessageType.OPEN: {
      if (plaintext.length !== 3) throw violation('OPEN wrong size');
      const port = view.getUint16(1, false);
      if (port === 0) throw violation('OPEN port 0');
      return { type: 'open', port };
    }
    case StreamMessageType.OPENED:
      if (plaintext.length !== 1) throw violation('OPENED wrong size');
      return { type: 'opened' };
    case StreamMessageType.DATA:
      if (plaintext.length < 2) throw violation('empty DATA');
      return { type: 'data', data: plaintext.subarray(1) };
    case StreamMessageType.RESET:
      if (plaintext.length !== 3) throw violation('RESET wrong size');
      return { type: 'reset', code: view.getUint16(1, false) };
    case StreamMessageType.WINDOW: {
      if (plaintext.length !== 5) throw violation('WINDOW wrong size');
      const credit = view.getUint32(1, false);
      if (credit === 0) throw violation('WINDOW of zero');
      return { type: 'window', credit };
    }
    case StreamMessageType.FIN:
      if (plaintext.length !== 1) throw violation('FIN wrong size');
      return { type: 'fin' };
    default:
      throw violation('unknown stream message type');
  }
}

// ---------------------------------------------------------------------------
// Relay identity (HELLO from a peer / HELLO_ACK from the relay), transport.md §6.2
// ---------------------------------------------------------------------------

/** HELLO from a client or service node to a relay: a fresh 32-byte nonce. */
export const RELAY_HELLO_NONCE_SIZE = 32;
/** HELLO_ACK from a relay: relay key (32) ‖ Ed25519 signature (64). */
export const RELAY_HELLO_ACK_SIZE = 96;

export function encodeRelayHello(nonce: Uint8Array): Uint8Array {
  if (nonce.length !== RELAY_HELLO_NONCE_SIZE) throw new RangeError('HELLO nonce must be 32 bytes');
  return nonce.slice();
}

export function decodeRelayHello(payload: Uint8Array): Uint8Array {
  if (payload.length !== RELAY_HELLO_NONCE_SIZE) throw violation('HELLO nonce wrong size');
  return payload.slice();
}

export function encodeRelayHelloAck(relayKey: Uint8Array, signature: Uint8Array): Uint8Array {
  if (relayKey.length !== 32 || signature.length !== 64) {
    throw new RangeError('HELLO_ACK needs a 32-byte key and a 64-byte signature');
  }
  const out = new Uint8Array(RELAY_HELLO_ACK_SIZE);
  out.set(relayKey, 0);
  out.set(signature, 32);
  return out;
}

export function decodeRelayHelloAck(payload: Uint8Array): {
  relayKey: Uint8Array;
  signature: Uint8Array;
} {
  if (payload.length !== RELAY_HELLO_ACK_SIZE) throw violation('HELLO_ACK wrong size');
  return { relayKey: payload.slice(0, 32), signature: payload.slice(32) };
}

// ---------------------------------------------------------------------------
// Service-node registration (HELLO / AUTH / AUTH_OK)
// ---------------------------------------------------------------------------

/** HELLO from a relay to a connecting service node: the 32-byte challenge. */
export const SERVICE_CHALLENGE_SIZE = 32;

export function decodeServiceHello(payload: Uint8Array): Uint8Array {
  if (payload.length !== SERVICE_CHALLENGE_SIZE) throw violation('HELLO challenge wrong size');
  return payload.slice();
}

/**
 * AUTH from a service node: which name it serves, the grant chain rooted at the
 * domain key, and its signature over the relay-auth statement
 * (`@tnp/crypto` `signServiceAuth`). The chain is passed through untouched; the
 * relay verifies it with `verifyChain`.
 */
export interface ServiceAuth {
  name: string;
  chain: unknown[];
  signature: string;
}

export function encodeServiceAuth(auth: ServiceAuth): Uint8Array {
  const bytes = textEncoder.encode(JSON.stringify(auth));
  if (bytes.length > MAX_FRAME_PAYLOAD) throw new RangeError('AUTH payload too large');
  return bytes;
}

export function decodeServiceAuth(payload: Uint8Array): ServiceAuth {
  let value: unknown;
  try {
    value = JSON.parse(textDecoder.decode(payload));
  } catch {
    throw violation('AUTH is not JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw violation('AUTH must be an object');
  }
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (key !== 'name' && key !== 'chain' && key !== 'signature') {
      throw violation('AUTH has an unexpected field');
    }
  }
  if (typeof v.name !== 'string' || !isCanonicalName(v.name)) throw violation('AUTH name invalid');
  if (!Array.isArray(v.chain) || v.chain.length === 0 || v.chain.length > 4) {
    throw violation('AUTH chain invalid');
  }
  if (typeof v.signature !== 'string' || v.signature.length > 128) {
    throw violation('AUTH signature invalid');
  }
  return { name: v.name, chain: v.chain, signature: v.signature };
}
