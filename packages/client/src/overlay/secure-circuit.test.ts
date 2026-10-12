import { describe, expect, test } from 'bun:test';
import { KeyAgreementRole, verifyKeyAgreementCertificate } from '@tnp/crypto';
import { makeTestCredentials } from '@tnp/crypto/testing';
import {
  ClientHandshake,
  decodeFrame,
  ErrorCode,
  type Frame,
  FrameType,
  ServerHandshake,
  type SessionError,
  STREAM_WINDOW_INITIAL,
} from '@tnp/protocol/v1';
import { SecureCircuit, type SecureCircuitEvents } from './secure-circuit';

const NAME = 'example.ox';

/** Two circuit ends joined by an in-memory link the test can inspect and tamper with. */
function pair(opts: { congested?: () => boolean } = {}) {
  const creds = makeTestCredentials(NAME);
  const now = Math.floor(Date.now() / 1000);
  const verified = verifyKeyAgreementCertificate(creds.kaCert, creds.chain, {
    trustedRoots: [creds.domainKeyB64],
    role: KeyAgreementRole.SERVICE_NODE,
    name: NAME,
    now,
  });
  if (!verified.ok) throw new Error('fixture does not verify');
  const hs = new ClientHandshake({ serverKey: verified.key, name: NAME, now });
  const { message, session: serverSession } = new ServerHandshake({
    staticKey: creds.staticKey,
    name: NAME,
  }).respond(hs.start());
  const clientSession = hs.finish(message);

  const toServer: Frame[] = [];
  const toClient: Frame[] = [];
  const opened: number[] = [];
  const client = new SecureCircuit(
    1n,
    clientSession,
    {
      send: (f) => {
        toServer.push(decodeFrame(f));
        return true;
      },
      congested: opts.congested ?? (() => false),
    },
    'client',
  );
  const server = new SecureCircuit(
    2n,
    serverSession,
    {
      send: (f) => {
        toClient.push(decodeFrame(f));
        return true;
      },
      congested: () => false,
    },
    'service',
    { onOpen: (port) => opened.push(port) },
  );
  return { client, server, toServer, toClient, opened };
}

function recorder() {
  const events = {
    data: [] as Uint8Array[],
    ended: false,
    closed: undefined as SessionError | null | undefined,
  };
  const handlers: SecureCircuitEvents = {
    onData: (d) => events.data.push(d.slice()),
    onEnd: () => {
      events.ended = true;
    },
    onWritable: () => {},
    onClose: (e) => {
      events.closed = e;
    },
  };
  return { events, handlers };
}

function deliver(frames: Frame[], to: SecureCircuit): void {
  for (const f of frames.splice(0)) to.receive(f);
}

describe('SecureCircuit', () => {
  test('open, data both ways, half-closes, clean finish', () => {
    const { client, server, toServer, toClient, opened } = pair();
    const c = recorder();
    const s = recorder();
    client.bind(c.handlers);
    server.bind(s.handlers);
    client.open(443);
    client.write(new TextEncoder().encode('request'));
    client.end();
    deliver(toServer, server);
    expect(opened).toEqual([443]);
    server.accept();
    server.write(new TextEncoder().encode('response'));
    server.end();
    deliver(toClient, client);
    deliver(toServer, server);
    deliver(toClient, client);
    expect(new TextDecoder().decode(s.events.data[0])).toBe('request');
    expect(new TextDecoder().decode(c.events.data[0])).toBe('response');
    expect(c.events.closed).toBeNull();
    expect(s.events.closed).toBeNull();
    // On a clean finish only the client tears the circuit down at the relay.
    expect(toServer.filter((f) => f.type === FrameType.CIRCUIT_DESTROY).length).toBeLessThanOrEqual(
      1,
    );
  });

  test('every record is a STREAM_DATA frame on stream 1: the relay cannot tell open from data from close', () => {
    const { client, server, toServer, toClient } = pair();
    client.open(80);
    client.write(new Uint8Array([1]));
    client.end();
    expect(new Set(toServer.map((f) => `${f.type}/${f.streamId}/${f.flags}`))).toEqual(
      new Set([`${FrameType.STREAM_DATA}/1/0`]),
    );
    deliver(toServer, server);
    server.accept();
    expect(toClient.every((f) => f.type === FrameType.STREAM_DATA)).toBe(true);
  });

  test('a peer that sends past its window is a FLOW_CONTROL violation', () => {
    const { client, server, toServer } = pair();
    const s = recorder();
    server.bind(s.handlers);
    client.open(80);
    deliver(toServer, server);
    server.accept();
    // Ignore the window: force-grant the client unlimited credit.
    (
      client as unknown as { sendWindow: { grant(n: number): void; consume(n: number): boolean } }
    ).sendWindow = {
      grant() {},
      consume: () => true,
      get remaining() {
        return 65_000;
      },
    } as never;
    const chunk = new Uint8Array(60_000);
    for (let sent = 0; sent <= STREAM_WINDOW_INITIAL; sent += chunk.length) client.write(chunk);
    deliver(toServer, server);
    expect(s.events.closed?.code).toBe(ErrorCode.FLOW_CONTROL);
  });

  test('the writer stops at the window and resumes on credit', () => {
    const { client, server, toServer, toClient } = pair();
    const s = recorder();
    server.bind(s.handlers);
    client.open(80);
    deliver(toServer, server);
    server.accept();
    deliver(toClient, client);
    const big = new Uint8Array(STREAM_WINDOW_INITIAL + 100_000);
    const taken = client.write(big);
    expect(taken).toBe(STREAM_WINDOW_INITIAL);
    expect(client.writable).toBe(0);
    deliver(toServer, server);
    server.consumed(STREAM_WINDOW_INITIAL);
    deliver(toClient, client);
    expect(client.writable).toBeGreaterThan(0);
  });

  test('a congested connection pauses the writer', () => {
    let congested = true;
    const { client } = pair({ congested: () => congested });
    expect(client.writable).toBe(0);
    congested = false;
    expect(client.writable).toBeGreaterThan(0);
  });

  test('data before OPEN, or a second OPEN, is a protocol violation', () => {
    const { client, server, toServer } = pair();
    const s = recorder();
    server.bind(s.handlers);
    client.open(80);
    client.open(81);
    deliver(toServer, server);
    expect(s.events.closed?.code).toBe(ErrorCode.PROTOCOL_VIOLATION);
  });

  test('the service node cannot send data before it accepted', () => {
    const { server } = pair();
    expect(server.writable).toBe(0);
  });

  test('a destroy before the peer FIN is TRUNCATED; after it, clean', () => {
    const a = pair();
    const rec = recorder();
    a.client.bind(rec.handlers);
    a.client.remoteDestroyed();
    expect(rec.events.closed?.code).toBe(ErrorCode.TRUNCATED);

    const b = pair();
    const rec2 = recorder();
    b.client.bind(rec2.handlers);
    b.client.open(80);
    deliver(b.toServer, b.server);
    b.server.accept();
    b.server.end();
    deliver(b.toClient, b.client);
    b.client.remoteDestroyed();
    expect(rec2.events.closed).toBeNull();
  });

  test('a peer RESET carries its sealed code and ends the circuit', () => {
    const { client, server, toServer, toClient } = pair();
    const c = recorder();
    client.bind(c.handlers);
    client.open(80);
    deliver(toServer, server);
    server.reset(ErrorCode.TARGET_REFUSED);
    deliver(toClient, client);
    expect(c.events.closed?.code).toBe(ErrorCode.TARGET_REFUSED);
  });

  test('events that arrive before bind are replayed in order', () => {
    const { client, server, toServer, toClient } = pair();
    client.open(80);
    deliver(toServer, server);
    server.accept();
    server.write(new Uint8Array([7, 7]));
    server.end();
    deliver(toClient, client);
    const c = recorder();
    client.bind(c.handlers);
    expect(c.events.data[0]).toEqual(new Uint8Array([7, 7]));
    expect(c.events.ended).toBe(true);
  });
});
