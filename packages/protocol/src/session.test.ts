import { describe, expect, test } from 'bun:test';
import {
  encodeBase64,
  GrantPurpose,
  KeyAgreementRole,
  signGrant,
  signKeyAgreementCertificate,
  type VerifiedKeyAgreementKey,
  verifyKeyAgreementCertificate,
} from '@tnp/crypto';
import { generateX25519KeyPair, type X25519KeyPair } from '@tnp/crypto/primitives';
import nacl from 'tweetnacl';
import {
  ErrorCode,
  type ErrorCodeValue,
  Flags,
  FrameType,
  HANDSHAKE_MESSAGE_SIZE,
  MAX_FRAME_PAYLOAD,
  MAX_SEALED_PLAINTEXT,
  SEALED_RECORD_OVERHEAD,
} from './constants';
import { decodeFrame, encodeFrame } from './frame';
import {
  ClientHandshake,
  frameAssociatedData,
  RekeyRequiredError,
  ServerHandshake,
  type SessionCipher,
  SessionError,
  type SessionLimits,
} from './session';

const NOW = 1_800_000_000;
const NAME = 'example.ox';
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/**
 * A real chain: identity → device → node (Ed25519) → certified X25519 key,
 * verified the way the client will verify it. The handshake accepts nothing
 * else, so the tests cannot cheat with a bare key.
 */
function certifiedServer(name = NAME, role: 'service-node' | 'relay' = 'service-node') {
  const identity = nacl.sign.keyPair();
  const device = nacl.sign.keyPair();
  const node = nacl.sign.keyPair();
  const staticKey = generateX25519KeyPair();
  const b64 = encodeBase64;
  const deviceGrant = signGrant(
    {
      issuer: b64(identity.publicKey),
      subject: b64(device.publicKey),
      purposes: [GrantPurpose.DELEGATE, GrantPurpose.SERVICE_NODE, GrantPurpose.RELAY],
      notBefore: NOW - 1000,
      notAfter: NOW + 1_000_000,
      serial: 1,
    },
    identity.secretKey,
  );
  const nodeGrant = signGrant(
    {
      issuer: b64(device.publicKey),
      subject: b64(node.publicKey),
      purposes: [role === 'relay' ? GrantPurpose.RELAY : GrantPurpose.SERVICE_NODE],
      notBefore: NOW - 1000,
      notAfter: NOW + 1_000_000,
      serial: 1,
      scope: name,
    },
    device.secretKey,
  );
  const cert = signKeyAgreementCertificate(
    {
      signer: b64(node.publicKey),
      key: b64(staticKey.publicKey),
      role,
      scope: name,
      notBefore: NOW - 100,
      notAfter: NOW + 86_400,
      serial: 1,
    },
    node.secretKey,
  );
  const result = verifyKeyAgreementCertificate(cert, [nodeGrant, deviceGrant], {
    trustedRoots: [b64(identity.publicKey)],
    now: NOW,
    role,
    name,
  });
  if (!result.ok) throw new Error(`fixture failed to verify: ${result.detail}`);
  return { serverKey: result.key, staticKey };
}

function handshake(
  options: {
    serverKey?: VerifiedKeyAgreementKey;
    staticKey?: X25519KeyPair;
    serverName?: string;
    limits?: SessionLimits;
  } = {},
) {
  const fixture = certifiedServer();
  const client = new ClientHandshake({
    serverKey: options.serverKey ?? fixture.serverKey,
    name: NAME,
    now: NOW,
    limits: options.limits,
  });
  const server = new ServerHandshake({
    staticKey: options.staticKey ?? fixture.staticKey,
    name: options.serverName ?? NAME,
    limits: options.limits,
  });
  const m1 = client.start();
  const { message: m2, session: serverSession } = server.respond(m1);
  const clientSession = client.finish(m2);
  return { client: clientSession, server: serverSession, m1, m2, fixture };
}

function expectSessionError(fn: () => unknown, code: ErrorCodeValue) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).code).toBe(code);
    return;
  }
  throw new Error('expected a SessionError');
}

function openData(session: SessionCipher, record: Uint8Array, ad?: Uint8Array): string {
  const opened = session.open(record, ad);
  if (opened.type !== 'data') throw new Error(`expected data, got ${opened.type}`);
  return text(opened.plaintext);
}

describe('handshake', () => {
  test('succeeds, and both directions carry data', () => {
    const { client, server, m1, m2 } = handshake();
    expect(m1.length).toBe(HANDSHAKE_MESSAGE_SIZE);
    expect(m2.length).toBe(HANDSHAKE_MESSAGE_SIZE);
    expect(encodeBase64(client.handshakeHash)).toBe(encodeBase64(server.handshakeHash));

    expect(openData(server, client.seal(bytes('GET / HTTP/1.1')))).toBe('GET / HTTP/1.1');
    expect(openData(client, server.seal(bytes('200 OK')))).toBe('200 OK');
    expect(openData(server, client.seal(bytes('second')))).toBe('second');
  });

  test('every session has fresh keys (forward secrecy from both ephemerals)', () => {
    const fixture = certifiedServer();
    const hashes = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const { client } = handshake({ serverKey: fixture.serverKey, staticKey: fixture.staticKey });
      hashes.add(encodeBase64(client.handshakeHash));
    }
    expect(hashes.size).toBe(3);
  });

  test('a server holding a different static key cannot complete it (wrong static key)', () => {
    // The client verified key A; whoever answers holds key B. Message 1 was
    // encrypted to A, so B cannot authenticate it.
    const other = certifiedServer();
    expectSessionError(() => handshake({ staticKey: other.staticKey }), ErrorCode.AUTH_FAILED);
  });

  test('a relay cannot man-in-the-middle: answering with its own keys fails key confirmation', () => {
    const { serverKey } = certifiedServer();
    const client = new ClientHandshake({ serverKey, name: NAME, now: NOW });
    const m1 = client.start();
    // The relay cannot read m1 (it lacks the static secret), so the best it can
    // do is run a responder with a key of its own and hope the client accepts.
    const relay = new ServerHandshake({ staticKey: generateX25519KeyPair(), name: NAME });
    expectSessionError(() => relay.respond(m1), ErrorCode.AUTH_FAILED);
    // Or fabricate message 2 outright.
    const forged = new Uint8Array(HANDSHAKE_MESSAGE_SIZE);
    forged.set(generateX25519KeyPair().publicKey);
    expectSessionError(() => client.finish(forged), ErrorCode.AUTH_FAILED);
  });

  test('the name is bound: a session routed to another name fails', () => {
    expectSessionError(() => handshake({ serverName: 'other.ox' }), ErrorCode.AUTH_FAILED);
  });

  test('the role is bound: a relay-role key cannot be used for a service-node session', () => {
    const relayKey = certifiedServer(NAME, KeyAgreementRole.RELAY);
    const client = new ClientHandshake({ serverKey: relayKey.serverKey, name: NAME, now: NOW });
    const server = new ServerHandshake({ staticKey: relayKey.staticKey, name: NAME });
    expectSessionError(() => server.respond(client.start()), ErrorCode.AUTH_FAILED);
  });

  test('a tampered handshake message fails', () => {
    const { serverKey, staticKey } = certifiedServer();
    for (let i = 0; i < HANDSHAKE_MESSAGE_SIZE; i += 7) {
      const client = new ClientHandshake({ serverKey, name: NAME, now: NOW });
      const server = new ServerHandshake({ staticKey, name: NAME });
      const m1 = client.start();
      m1[i] ^= 0x01;
      expect(() => server.respond(m1)).toThrow(SessionError);
    }
  });

  test('wrong-size handshake messages are protocol violations', () => {
    const { serverKey, staticKey } = certifiedServer();
    for (const size of [0, 32, HANDSHAKE_MESSAGE_SIZE - 1, HANDSHAKE_MESSAGE_SIZE + 1, 1000]) {
      const server = new ServerHandshake({ staticKey, name: NAME });
      expectSessionError(() => server.respond(new Uint8Array(size)), ErrorCode.PROTOCOL_VIOLATION);
      const client = new ClientHandshake({ serverKey, name: NAME, now: NOW });
      client.start();
      expectSessionError(() => client.finish(new Uint8Array(size)), ErrorCode.PROTOCOL_VIOLATION);
    }
  });

  test('handshakes are single use', () => {
    const { serverKey, staticKey } = certifiedServer();
    const client = new ClientHandshake({ serverKey, name: NAME, now: NOW });
    const server = new ServerHandshake({ staticKey, name: NAME });
    const m1 = client.start();
    expect(() => client.start()).toThrow(SessionError);
    const { message } = server.respond(m1);
    expect(() => server.respond(m1)).toThrow(SessionError);
    client.finish(message);
    expect(() => client.finish(message)).toThrow(SessionError);
  });
});

describe('the server key must be verified', () => {
  test('a look-alike object with the right fields is refused', () => {
    const { serverKey } = certifiedServer();
    const fake = {
      publicKey: serverKey.publicKey,
      role: serverKey.role,
      scope: serverKey.scope,
      notAfter: serverKey.notAfter,
    } as VerifiedKeyAgreementKey;
    expectSessionError(
      () => new ClientHandshake({ serverKey: fake, name: NAME, now: NOW }),
      ErrorCode.AUTH_FAILED,
    );
  });

  test('a key certified for another name is refused before anything is sent', () => {
    const { serverKey } = certifiedServer('other.ox');
    expectSessionError(
      () => new ClientHandshake({ serverKey, name: NAME, now: NOW }),
      ErrorCode.AUTH_FAILED,
    );
  });

  test('a key whose certificate expired since verification is refused', () => {
    const { serverKey } = certifiedServer();
    expectSessionError(
      () => new ClientHandshake({ serverKey, name: NAME, now: serverKey.notAfter }),
      ErrorCode.AUTH_EXPIRED,
    );
  });
});

describe('low-order and all-zero X25519 keys are rejected', () => {
  const LOW_ORDER = [
    new Uint8Array(32),
    Uint8Array.from([1, ...new Array(31).fill(0)]),
    Uint8Array.from([0xec, ...new Array(30).fill(0xff), 0x7f]),
  ];

  test('as the client ephemeral in message 1', () => {
    const { staticKey } = certifiedServer();
    for (const point of LOW_ORDER) {
      const server = new ServerHandshake({ staticKey, name: NAME });
      const m1 = new Uint8Array(HANDSHAKE_MESSAGE_SIZE);
      m1.set(point);
      expectSessionError(() => server.respond(m1), ErrorCode.PROTOCOL_VIOLATION);
    }
  });

  test('as the server ephemeral in message 2', () => {
    const { serverKey } = certifiedServer();
    for (const point of LOW_ORDER) {
      const client = new ClientHandshake({ serverKey, name: NAME, now: NOW });
      client.start();
      const m2 = new Uint8Array(HANDSHAKE_MESSAGE_SIZE);
      m2.set(point);
      expectSessionError(() => client.finish(m2), ErrorCode.PROTOCOL_VIOLATION);
    }
  });

  test('as the server static key', () => {
    expect(
      () =>
        new ServerHandshake({
          staticKey: { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) },
          name: NAME,
        }),
    ).toThrow();
  });
});

describe('records: what a hostile relay can try', () => {
  test('replaying a record is REPLAY_DETECTED', () => {
    const { client, server } = handshake();
    const r0 = client.seal(bytes('pay alice 10'));
    openData(server, r0);
    expectSessionError(() => server.open(r0), ErrorCode.REPLAY_DETECTED);
  });

  test('reordering records is rejected', () => {
    const { client, server } = handshake();
    const r0 = client.seal(bytes('first'));
    const r1 = client.seal(bytes('second'));
    expectSessionError(() => server.open(r1), ErrorCode.PROTOCOL_VIOLATION);
    // ...and the session is now dead: the "right" record is refused too.
    expect(() => server.open(r0)).toThrow(SessionError);
  });

  test('dropping a record is detected at the next one', () => {
    const { client, server } = handshake();
    client.seal(bytes('dropped by the relay'));
    expectSessionError(() => server.open(client.seal(bytes('next'))), ErrorCode.PROTOCOL_VIOLATION);
  });

  test("reflecting the client's own record back to it fails authentication", () => {
    const { client } = handshake();
    const r0 = client.seal(bytes('to the server'));
    // Same counter (0) the client expects next, but sealed under the
    // client→server key, which the client never decrypts with.
    expectSessionError(() => client.open(r0), ErrorCode.DECRYPT_FAILED);
  });

  test('a tampered byte anywhere in a record is rejected', () => {
    const r = handshake();
    const record = r.client.seal(bytes('integrity matters'));
    // Counter bytes (0–7) report as a replay/gap; everything after as DECRYPT_FAILED.
    for (let i = 0; i < record.length; i++) {
      const { client, server } = handshake();
      const fresh = client.seal(bytes('integrity matters'));
      fresh[i] ^= 0x80;
      expect(() => server.open(fresh)).toThrow(SessionError);
    }
    expect(record.length).toBe(SEALED_RECORD_OVERHEAD + 'integrity matters'.length);
  });

  test('moving a record to another stream or frame type breaks it (frame header is AD)', () => {
    const { client, server } = handshake();
    const ad = frameAssociatedData(FrameType.STREAM_DATA, 0, 7);
    const record = client.seal(bytes('for stream 7'), ad);
    expectSessionError(
      () => server.open(record, frameAssociatedData(FrameType.STREAM_DATA, 0, 8)),
      ErrorCode.DECRYPT_FAILED,
    );
    const again = handshake();
    const r2 = again.client.seal(bytes('data'), frameAssociatedData(FrameType.STREAM_DATA, 0, 7));
    expectSessionError(
      () =>
        again.server.open(r2, frameAssociatedData(FrameType.STREAM_CLOSE, Flags.CLOSE_WRITE, 7)),
      ErrorCode.DECRYPT_FAILED,
    );
  });

  test('a record from another session is rejected', () => {
    const a = handshake();
    const b = handshake();
    expectSessionError(() => b.server.open(a.client.seal(bytes('x'))), ErrorCode.DECRYPT_FAILED);
  });

  test('after any failure the session is dead in both directions', () => {
    const { client, server } = handshake();
    const r0 = client.seal(bytes('a'));
    const bad = r0.slice();
    bad[bad.length - 1] ^= 1;
    expect(() => server.open(bad)).toThrow(SessionError);
    expect(() => server.open(r0)).toThrow(SessionError);
    expect(() => server.seal(bytes('reply'))).toThrow(SessionError);
  });

  test('impossible record sizes are rejected without decrypting', () => {
    const { server } = handshake();
    expectSessionError(
      () => server.open(new Uint8Array(SEALED_RECORD_OVERHEAD - 1)),
      ErrorCode.PROTOCOL_VIOLATION,
    );
    const { server: s2 } = handshake();
    expectSessionError(
      () => s2.open(new Uint8Array(MAX_FRAME_PAYLOAD + 1)),
      ErrorCode.PROTOCOL_VIOLATION,
    );
  });
});

describe('authenticated close', () => {
  test('a clean end requires the close record', () => {
    const { client, server } = handshake();
    openData(server, client.seal(bytes('last data')));
    expect(server.open(client.close()).type).toBe('close');
    expect(server.peerClosed).toBe(true);
    server.transportEnded(); // does not throw
  });

  test('truncation without an authenticated close is detected', () => {
    const { client, server } = handshake();
    openData(server, client.seal(bytes('partial respon')));
    client.close(); // the relay drops this and closes the socket
    expectSessionError(() => server.transportEnded(), ErrorCode.TRUNCATED);
  });

  test('nothing is accepted after close, and nothing can be sent after sending it', () => {
    const { client, server } = handshake();
    const close = client.close();
    expect(() => client.seal(bytes('more'))).toThrow(SessionError);
    expect(() => client.updateKey()).toThrow(SessionError);
    server.open(close);
    expectSessionError(() => server.open(close), ErrorCode.PROTOCOL_VIOLATION);
  });

  test('close is a half-close: the other direction keeps working', () => {
    const { client, server } = handshake();
    server.open(client.close());
    expect(openData(client, server.seal(bytes('still talking')))).toBe('still talking');
  });

  test('the close record cannot be forged', () => {
    const { client, server } = handshake();
    const data = client.seal(new Uint8Array(0)); // same length as a close record
    const close = client.close();
    expect(data.length).toBe(close.length);
    // A relay cannot tell which is which, and cannot fabricate either.
    const forged = close.slice();
    forged[9] ^= 1;
    expect(() => server.open(forged)).toThrow(SessionError);
  });
});

describe('record limits and rekeying', () => {
  const limits = { maxRecordsPerKey: 4, keyUpdateInterval: 2 };

  test('counter exhaustion requires a key update before more data', () => {
    const { client, server } = handshake({ limits });
    for (let i = 0; i < 3; i++) openData(server, client.seal(bytes(`r${i}`)));
    expect(client.needsKeyUpdate).toBe(true);
    // Counter 3 is the reserved last slot: data is refused...
    expect(() => client.seal(bytes('r3'))).toThrow(RekeyRequiredError);
    // ...but a key update fits in it, and data flows again under the new key.
    expect(server.open(client.updateKey()).type).toBe('key-update');
    expect(client.needsKeyUpdate).toBe(false);
    for (let i = 0; i < 3; i++)
      expect(openData(server, client.seal(bytes(`k1-${i}`)))).toBe(`k1-${i}`);
  });

  test('a record sealed under the old key after an update is rejected', () => {
    const { client, server } = handshake({ limits });
    const update = client.updateKey();
    const afterUpdate = client.seal(bytes('new key'));
    server.open(update);
    expect(openData(server, afterUpdate)).toBe('new key');

    // Replaying the update record: its counter belongs to the old key epoch,
    // but the receiver is at counter 1 of the new one.
    expect(() => server.open(update)).toThrow(SessionError);
  });

  test('a receiver refuses data in the reserved last slot from a peer ignoring the limit', () => {
    // The sender believes the limit is higher; the receiver enforces its own.
    const fixture = certifiedServer();
    const client = new ClientHandshake({
      serverKey: fixture.serverKey,
      name: NAME,
      now: NOW,
      limits: { maxRecordsPerKey: 100 },
    });
    const server = new ServerHandshake({ staticKey: fixture.staticKey, name: NAME, limits });
    const { message, session: serverSession } = server.respond(client.start());
    const clientSession = client.finish(message);
    for (let i = 0; i < 3; i++) openData(serverSession, clientSession.seal(bytes(`r${i}`)));
    expectSessionError(
      () => serverSession.open(clientSession.seal(bytes('r3'))),
      ErrorCode.PROTOCOL_VIOLATION,
    );
  });

  test('limits can only be lowered', () => {
    const fixture = certifiedServer();
    for (const bad of [
      { maxRecordsPerKey: 2 ** 33 },
      { maxRecordsPerKey: 1 },
      { keyUpdateInterval: 0 },
    ]) {
      expect(
        () => new ServerHandshake({ staticKey: fixture.staticKey, name: NAME, limits: bad }),
      ).toThrow(RangeError);
    }
  });
});

describe('sealed records fit in frames', () => {
  test('the largest plaintext seals to exactly MAX_FRAME_PAYLOAD and round-trips through a frame', () => {
    const { client, server } = handshake();
    const plaintext = new Uint8Array(MAX_SEALED_PLAINTEXT).fill(0xab);
    const ad = frameAssociatedData(FrameType.STREAM_DATA, 0, 1);
    const record = client.seal(plaintext, ad);
    expect(record.length).toBe(MAX_FRAME_PAYLOAD);
    const frame = decodeFrame(
      encodeFrame({ type: FrameType.STREAM_DATA, circuitId: 9n, streamId: 1, payload: record }),
    );
    const opened = server.open(
      frame.payload,
      frameAssociatedData(frame.type, frame.flags, frame.streamId),
    );
    expect(opened.type === 'data' && opened.plaintext.length).toBe(MAX_SEALED_PLAINTEXT);
  });

  test('one byte more is refused before sealing', () => {
    const { client } = handshake();
    expect(() => client.seal(new Uint8Array(MAX_SEALED_PLAINTEXT + 1))).toThrow(RangeError);
  });

  test('frameAssociatedData refuses values the header could not carry', () => {
    expect(() => frameAssociatedData(0xff as never, 0, 0)).toThrow(RangeError);
    expect(() => frameAssociatedData(FrameType.STREAM_DATA, 0x8000, 0)).toThrow(RangeError);
    expect(() => frameAssociatedData(FrameType.STREAM_DATA, 0, 2 ** 32)).toThrow(RangeError);
  });
});
