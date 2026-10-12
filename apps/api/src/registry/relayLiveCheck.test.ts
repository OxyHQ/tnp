import { afterEach, describe, expect, test } from 'bun:test';
import { encodeBase64, generateSigningKeyPair, signRelayIdentity } from '@tnp/crypto';
import {
  decodeFrame,
  decodeRelayHello,
  encodeFrame,
  encodeRelayHelloAck,
  FrameType,
} from '@tnp/protocol/v1';
import { relayLiveCheck } from './relayLiveCheck.js';

const ENDPOINT = 'wss://relay.example.org';
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/**
 * A loopback relay stand-in that signs as `signAs` for `signedEndpoint`. The
 * check is pointed at it through the injected `connect`, since a test cannot
 * hold a public wss:// endpoint.
 */
function fakeRelay(
  signAs: { publicKey: Uint8Array; secretKey: Uint8Array } | null,
  signedEndpoint = ENDPOINT,
) {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req, srv) {
      return srv.upgrade(req, { data: undefined })
        ? undefined
        : new Response('no', { status: 400 });
    },
    websocket: {
      message(ws, msg) {
        const frame = decodeFrame(new Uint8Array(msg as Buffer));
        if (frame.type !== FrameType.HELLO || !signAs) return;
        const nonce = decodeRelayHello(frame.payload);
        const sig = signRelayIdentity(
          { endpoint: signedEndpoint, nonce, relayKey: signAs.publicKey },
          signAs.secretKey,
        );
        ws.sendBinary(
          encodeFrame({
            type: FrameType.HELLO_ACK,
            payload: encodeRelayHelloAck(signAs.publicKey, sig),
          }),
        );
      },
    },
  });
  servers.push(server);
  return server;
}

function check(
  port: number | undefined,
  resolve = async () => ['93.184.216.34'],
  timeoutMs = 2000,
) {
  return relayLiveCheck({
    timeoutMs,
    resolve,
    connect: () => new WebSocket(`ws://127.0.0.1:${port}/tunnel`),
  });
}

describe('the registry live check of a community relay', () => {
  test('passes only when the relay at the endpoint proves the registered key', async () => {
    const key = generateSigningKeyPair();
    const relay = fakeRelay(key);
    expect(await check(relay.port)(ENDPOINT, encodeBase64(key.publicKey))).toBe(true);
    // Someone else's key at that endpoint (squatting): refused.
    expect(
      await check(relay.port)(ENDPOINT, encodeBase64(generateSigningKeyPair().publicKey)),
    ).toBe(false);
  });

  test('a proof made for another endpoint, or silence, fails', async () => {
    const key = generateSigningKeyPair();
    const elsewhere = fakeRelay(key, 'wss://other.example.org');
    expect(await check(elsewhere.port)(ENDPOINT, encodeBase64(key.publicKey))).toBe(false);
    const silent = fakeRelay(null);
    expect(await check(silent.port, undefined, 300)(ENDPOINT, encodeBase64(key.publicKey))).toBe(
      false,
    );
  });

  test('SSRF fence: never connects to ws://, private literals, or names resolving privately', async () => {
    const key = encodeBase64(generateSigningKeyPair().publicKey);
    let connected = 0;
    const counting = (resolve: (host: string) => Promise<string[]>) =>
      relayLiveCheck({
        resolve,
        connect: () => {
          connected++;
          throw new Error('must not connect');
        },
      });
    const publicDns = async () => ['93.184.216.34'];
    for (const endpoint of [
      'ws://relay.example.org',
      'wss://127.0.0.1',
      'wss://10.1.2.3',
      'wss://[::1]',
      'wss://localhost',
      'wss://relay.internal',
      'wss://Relay.Example.org/', // not canonical
    ]) {
      expect(await counting(publicDns)(endpoint, key)).toBe(false);
    }
    for (const addresses of [['10.0.0.5'], ['93.184.216.34', '169.254.169.254'], ['::1'], []]) {
      expect(await counting(async () => addresses)(ENDPOINT, key)).toBe(false);
    }
    expect(
      await counting(async () => {
        throw new Error('NXDOMAIN');
      })(ENDPOINT, key),
    ).toBe(false);
    expect(await counting(publicDns)(ENDPOINT, 'not-a-key')).toBe(false);
    expect(connected).toBe(0);
  });
});
