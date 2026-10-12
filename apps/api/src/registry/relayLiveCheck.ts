/**
 * The registry's own check that a community relay answers at its endpoint
 * with the key it registered (relays.md §2, step 4).
 *
 * A key proof sent with a registration shows the registrant holds a key; it
 * does not show that the machine at the endpoint is the one holding it. So
 * before a community relay is listed, the API connects to the endpoint itself
 * and asks it to prove its identity exactly as a client would (transport.md
 * §6.2): a fresh nonce in a HELLO, a HELLO_ACK whose key must be the
 * registered one and whose signature must cover this endpoint and nonce.
 *
 * It is an outbound connection the API makes on behalf of an account, so it is
 * fenced (SSRF): `wss://` only, a public host by the #91 rules, every address
 * the name resolves to public, a hard timeout, one frame out and one frame in.
 * What it cannot fence is DNS rebinding between the lookup and the connect;
 * TLS (the certificate must be valid for the name) is what makes that useless.
 */

import { lookup } from 'node:dns/promises';
import { bytesEqual, parsePublicKey, verifyRelayIdentity } from '@tnp/crypto';
import { randomBytes } from '@tnp/crypto/primitives';
import {
  decodeFrame,
  decodeRelayHelloAck,
  encodeFrame,
  encodeRelayHello,
  FrameType,
  RELAY_HELLO_NONCE_SIZE,
} from '@tnp/protocol/v1';
import {
  isNonPublicAddress,
  normalizeRelayEndpoint,
  publicRelayEndpointProblem,
} from '@tnp/shared-types';

/** True when the relay at `endpoint` proved `publicKey` just now. Never throws. */
export type RelayLiveCheck = (endpoint: string, publicKey: string) => Promise<boolean>;

export interface LiveCheckOptions {
  timeoutMs?: number;
  /** Every address `host` resolves to. Injected for tests. */
  resolve?: (host: string) => Promise<string[]>;
  /** Opens the WebSocket. Injected for tests (which cannot hold a public wss:// endpoint). */
  connect?: (url: string) => WebSocket;
}

async function resolveAll(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

export function relayLiveCheck(options: LiveCheckOptions = {}): RelayLiveCheck {
  const timeoutMs = options.timeoutMs ?? 5000;
  const resolve = options.resolve ?? resolveAll;
  const connect = options.connect ?? ((url: string) => new WebSocket(url));

  return async (endpoint, publicKey) => {
    let key: Uint8Array;
    try {
      key = parsePublicKey(publicKey);
    } catch {
      return false;
    }
    if (normalizeRelayEndpoint(endpoint) !== endpoint) return false;
    if (publicRelayEndpointProblem(endpoint) !== null) return false;
    const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, '');
    let addresses: string[];
    try {
      addresses = await resolve(host);
    } catch {
      return false;
    }
    if (addresses.length === 0 || addresses.some(isNonPublicAddress)) return false;

    const nonce = randomBytes(RELAY_HELLO_NONCE_SIZE);
    return new Promise<boolean>((done) => {
      let ws: WebSocket;
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // already closed
        }
        done(ok);
      };
      const timer = setTimeout(() => finish(false), timeoutMs);
      try {
        ws = connect(`${endpoint}/tunnel`);
      } catch {
        finish(false);
        return;
      }
      ws.binaryType = 'arraybuffer';
      ws.addEventListener('open', () => {
        ws.send(encodeFrame({ type: FrameType.HELLO, payload: encodeRelayHello(nonce) }));
      });
      ws.addEventListener('error', () => finish(false));
      ws.addEventListener('close', () => finish(false));
      ws.addEventListener('message', (event) => {
        try {
          const data = event.data;
          if (!(data instanceof ArrayBuffer) || data.byteLength > 256) return finish(false);
          const frame = decodeFrame(new Uint8Array(data));
          if (frame.type === FrameType.PING) return;
          if (frame.type !== FrameType.HELLO_ACK) return finish(false);
          const ack = decodeRelayHelloAck(frame.payload);
          finish(
            bytesEqual(ack.relayKey, key) &&
              verifyRelayIdentity({ endpoint, nonce, relayKey: key }, ack.signature),
          );
        } catch {
          finish(false);
        }
      });
    });
  };
}
