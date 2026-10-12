/**
 * Smoke test against a RUNNING relay, from inside its container (CI):
 *
 *   docker exec <relay> bun apps/relay/src/self-test.ts
 *
 * Reads the same environment the relay does, connects to
 * ws://127.0.0.1:$RELAY_PORT/tunnel, sends a HELLO with a fresh nonce and
 * checks the HELLO_ACK: the key must be RELAY_KEY_SEED's public half and the
 * signature must cover RELAY_ENDPOINT and the nonce — exactly what a client
 * checks against the signed directory. Exits 0 on success, 1 otherwise.
 */

import { bytesEqual, verifyRelayIdentity } from '@tnp/crypto';
import {
  decodeFrame,
  decodeRelayHelloAck,
  encodeFrame,
  encodeRelayHello,
  FrameType,
} from '@tnp/protocol/v1';
import { loadRelayConfig } from './config.js';

const loaded = loadRelayConfig(process.env);
if (!loaded.ok) {
  for (const error of loaded.errors) console.error(`[self-test] ${error}`);
  process.exit(1);
}
const { endpoint, identity, port } = loaded.config;
const nonce = crypto.getRandomValues(new Uint8Array(32));

const verdict = await new Promise<string | null>((resolve) => {
  const timer = setTimeout(() => resolve('no HELLO_ACK within 5 s'), 5000);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/tunnel`);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () =>
    ws.send(encodeFrame({ type: FrameType.HELLO, payload: encodeRelayHello(nonce) })),
  );
  ws.addEventListener('error', () => resolve('could not connect to the relay'));
  ws.addEventListener('message', (event) => {
    clearTimeout(timer);
    ws.close();
    try {
      const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
      if (frame.type !== FrameType.HELLO_ACK)
        return resolve(`expected HELLO_ACK, got ${frame.type}`);
      const ack = decodeRelayHelloAck(frame.payload);
      if (!bytesEqual(ack.relayKey, identity.publicKey)) return resolve('wrong relay key');
      if (!verifyRelayIdentity({ endpoint, nonce, relayKey: ack.relayKey }, ack.signature)) {
        return resolve('identity proof does not verify for RELAY_ENDPOINT');
      }
      resolve(null);
    } catch (err) {
      resolve(err instanceof Error ? err.message : 'malformed reply');
    }
  });
});

if (verdict) {
  console.error(`[self-test] FAILED: ${verdict}`);
  process.exit(1);
}
console.log(`[self-test] ok: the relay proved its key for ${endpoint}`);
process.exit(0);
