import { describe, expect, test } from 'bun:test';
import { ErrorCode, HANDSHAKE_MESSAGE_SIZE } from './constants';
import { FrameDecodeError } from './frame';
import {
  decodeCircuitCreate,
  decodeCircuitCreated,
  decodeDestroy,
  decodeRelayHello,
  decodeRelayHelloAck,
  decodeServiceAuth,
  decodeServiceHello,
  decodeStreamMessage,
  encodeCircuitCreate,
  encodeDestroy,
  encodeRelayHello,
  encodeRelayHelloAck,
  encodeServiceAuth,
  encodeStreamMessage,
  MAX_STREAM_DATA,
  type StreamMessage,
} from './overlay';

const msg1 = new Uint8Array(HANDSHAKE_MESSAGE_SIZE).fill(7);

function violation(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(FrameDecodeError);
    expect((err as FrameDecodeError).code).toBe(ErrorCode.PROTOCOL_VIOLATION);
    return;
  }
  throw new Error('expected a protocol violation');
}

describe('CIRCUIT_CREATE routing prefix', () => {
  test('round-trips the name and message 1', () => {
    const decoded = decodeCircuitCreate(encodeCircuitCreate('example.ox', msg1));
    expect(decoded.name).toBe('example.ox');
    expect(decoded.message1).toEqual(msg1);
  });

  test('refuses non-canonical names on both sides', () => {
    expect(() => encodeCircuitCreate('Example.ox', msg1)).toThrow(RangeError);
    const bad = encodeCircuitCreate('example.ox', msg1);
    bad[1] = 'E'.charCodeAt(0);
    violation(() => decodeCircuitCreate(bad));
  });

  test('refuses a payload whose length does not match its prefix', () => {
    const good = encodeCircuitCreate('example.ox', msg1);
    violation(() => decodeCircuitCreate(good.subarray(0, good.length - 1)));
    violation(() => decodeCircuitCreate(new Uint8Array([...good, 0])));
    const zero = good.slice();
    zero[0] = 0;
    violation(() => decodeCircuitCreate(zero));
    violation(() => decodeCircuitCreate(new Uint8Array(3)));
  });

  test('the old v0 OPEN payload (domain\\0base64key) is refused', () => {
    violation(() => decodeCircuitCreate(new TextEncoder().encode('example.ox\0AAAA')));
  });

  test('CIRCUIT_CREATED is exactly message 2', () => {
    expect(decodeCircuitCreated(msg1)).toEqual(msg1);
    violation(() => decodeCircuitCreated(new Uint8Array(47)));
  });
});

describe('CIRCUIT_DESTROY', () => {
  test('round-trips a u16 and refuses other lengths', () => {
    expect(decodeDestroy(encodeDestroy(0x22))).toBe(0x22);
    violation(() => decodeDestroy(new Uint8Array(3)));
    expect(() => encodeDestroy(70000)).toThrow(RangeError);
  });
});

describe('stream messages', () => {
  const cases: StreamMessage[] = [
    { type: 'open', port: 443 },
    { type: 'opened' },
    { type: 'data', data: new Uint8Array([1, 2, 3]) },
    { type: 'reset', code: ErrorCode.TARGET_REFUSED },
    { type: 'window', credit: 65536 },
    { type: 'fin' },
  ];
  for (const message of cases) {
    test(`${message.type} round-trips`, () => {
      expect(decodeStreamMessage(encodeStreamMessage(message))).toEqual(message);
    });
  }

  test('every type has an exact length', () => {
    violation(() => decodeStreamMessage(new Uint8Array([0x01, 0, 80, 0])));
    violation(() => decodeStreamMessage(new Uint8Array([0x01, 0, 0])));
    violation(() => decodeStreamMessage(new Uint8Array([0x02, 0])));
    violation(() => decodeStreamMessage(new Uint8Array([0x03])));
    violation(() => decodeStreamMessage(new Uint8Array([0x04, 0])));
    violation(() => decodeStreamMessage(new Uint8Array([0x05, 0, 0, 0, 0])));
    violation(() => decodeStreamMessage(new Uint8Array([0x06, 0])));
    violation(() => decodeStreamMessage(new Uint8Array([0x09])));
    violation(() => decodeStreamMessage(new Uint8Array(0)));
  });

  test('a data chunk is bounded so a record always fits one frame', () => {
    expect(() =>
      encodeStreamMessage({ type: 'data', data: new Uint8Array(MAX_STREAM_DATA + 1) }),
    ).toThrow(RangeError);
    expect(
      encodeStreamMessage({ type: 'data', data: new Uint8Array(MAX_STREAM_DATA) }).length,
    ).toBe(MAX_STREAM_DATA + 1);
  });
});

describe('service registration', () => {
  test('HELLO carries exactly a 32-byte challenge', () => {
    expect(decodeServiceHello(new Uint8Array(32)).length).toBe(32);
    violation(() => decodeServiceHello(new Uint8Array(31)));
  });

  test('AUTH is strict JSON', () => {
    const auth = { name: 'example.ox', chain: [{}], signature: 'AAAA' };
    expect(decodeServiceAuth(encodeServiceAuth(auth))).toEqual(auth);
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    violation(() => decodeServiceAuth(enc({ ...auth, extra: 1 })));
    violation(() => decodeServiceAuth(enc({ ...auth, chain: [] })));
    violation(() => decodeServiceAuth(enc({ ...auth, chain: [1, 2, 3, 4, 5] })));
    violation(() => decodeServiceAuth(enc({ ...auth, name: 'NOPE' })));
    violation(() => decodeServiceAuth(new TextEncoder().encode('{')));
    violation(() => decodeServiceAuth(new Uint8Array([0xff, 0xfe])));
  });
});

describe('relay identity', () => {
  test('HELLO is exactly a 32-byte nonce', () => {
    const nonce = new Uint8Array(32).fill(3);
    expect(decodeRelayHello(encodeRelayHello(nonce))).toEqual(nonce);
    violation(() => decodeRelayHello(new Uint8Array(33)));
    expect(() => encodeRelayHello(new Uint8Array(31))).toThrow(RangeError);
  });

  test('HELLO_ACK is exactly key (32) and signature (64)', () => {
    const key = new Uint8Array(32).fill(1);
    const sig = new Uint8Array(64).fill(2);
    expect(decodeRelayHelloAck(encodeRelayHelloAck(key, sig))).toEqual({
      relayKey: key,
      signature: sig,
    });
    violation(() => decodeRelayHelloAck(new Uint8Array(95)));
    violation(() => decodeRelayHelloAck(new Uint8Array(97)));
    expect(() => encodeRelayHelloAck(key, new Uint8Array(63))).toThrow(RangeError);
  });
});
