/**
 * Making a relay prove it holds the key the signed directory lists for the
 * endpoint we dialed (transport.md §6.2).
 *
 *   peer  ── HELLO {nonce: 32 CSPRNG bytes} ──────────────▶ relay
 *   peer  ◀─ HELLO_ACK {relayKey, sig(endpoint, nonce)} ── relay
 *
 * The peer — a client's relay link or a service node — sends nothing else on
 * the connection until the proof verifies: the key must equal the directory's
 * key for this endpoint, and the signature must cover the endpoint this peer
 * dialed and the nonce it chose for this connection. A forged proof, one
 * replayed from another connection, or one made for another endpoint (a relay
 * relaying someone else's proof) fails here.
 *
 * What it does not do: bind the proof to the TLS channel. A party that can
 * terminate TLS for the endpoint AND forward to the genuine relay gets no more
 * than a network observer — circuits are end-to-end encrypted to the service
 * node's certified key — but it is not detected by this check.
 */

import { bytesEqual, encodeBase64, verifyRelayIdentity } from '@tnp/crypto';
import { randomBytes } from '@tnp/crypto/primitives';
import {
  decodeRelayHelloAck,
  encodeFrame,
  encodeRelayHello,
  type Frame,
  FrameType,
  RELAY_HELLO_NONCE_SIZE,
} from '@tnp/protocol/v1';
import { FrameSocket } from './frame-socket';

/** The relay did not prove the identity the directory lists for it. */
export class RelayIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayIdentityError';
  }
}

/** One connection's challenge. Construct per connection; never reuse. */
export class RelayIdentityCheck {
  readonly nonce = randomBytes(RELAY_HELLO_NONCE_SIZE);

  constructor(
    /** The normalized endpoint this peer dialed. */
    readonly endpoint: string,
    /** The relay key the signed directory lists for that endpoint. */
    readonly expectedKey: Uint8Array,
  ) {}

  helloFrame(): Uint8Array {
    return encodeFrame({ type: FrameType.HELLO, payload: encodeRelayHello(this.nonce) });
  }

  /** Throws `RelayIdentityError` unless `frame` is a valid proof for this connection. */
  verify(frame: Frame): void {
    if (frame.type !== FrameType.HELLO_ACK || frame.circuitId !== 0n) {
      throw new RelayIdentityError('the relay sent something else before proving its identity');
    }
    let ack: { relayKey: Uint8Array; signature: Uint8Array };
    try {
      ack = decodeRelayHelloAck(frame.payload);
    } catch {
      throw new RelayIdentityError('the relay sent a malformed identity proof');
    }
    if (!bytesEqual(ack.relayKey, this.expectedKey)) {
      throw new RelayIdentityError(
        `the relay at ${this.endpoint} presented key ${encodeBase64(ack.relayKey)}, ` +
          `not the key the signed directory lists (${encodeBase64(this.expectedKey)})`,
      );
    }
    if (
      !verifyRelayIdentity(
        { endpoint: this.endpoint, nonce: this.nonce, relayKey: this.expectedKey },
        ack.signature,
      )
    ) {
      throw new RelayIdentityError(
        `the relay at ${this.endpoint} did not prove possession of its directory key for this connection`,
      );
    }
  }
}

/**
 * Connect to `endpoint`'s `/tunnel`, make it prove its identity, and report
 * how long that took (ms), or null when it could not be reached or failed
 * the proof. Used to rank relays by latency; the proof makes a relay that
 * cannot prove its key rank as unreachable rather than fast.
 */
export async function probeRelay(
  endpoint: string,
  expectedKey: Uint8Array,
  timeoutMs = 5_000,
): Promise<number | null> {
  const check = new RelayIdentityCheck(endpoint, expectedKey);
  const started = performance.now();
  return new Promise<number | null>((resolve) => {
    let settled = false;
    let opened: { socket: FrameSocket; ready: Promise<void> } | null = null;
    const finish = (result: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opened?.socket.close();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      opened = FrameSocket.open(
        `${endpoint}/tunnel`,
        {
          onFrame: (frame) => {
            if (frame.type === FrameType.PING) return;
            try {
              check.verify(frame);
              finish(Math.round(performance.now() - started));
            } catch {
              finish(null);
            }
          },
          onClose: () => finish(null),
          onDrain: () => {},
        },
        timeoutMs,
      );
    } catch {
      finish(null);
      return;
    }
    const socket = opened.socket;
    opened.ready.then(
      () => {
        if (!socket.send(check.helloFrame())) finish(null);
      },
      () => finish(null),
    );
  });
}
