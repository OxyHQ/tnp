/**
 * Join a local TCP socket to a `SecureCircuit`, with backpressure both ways.
 *
 * Used on both ends: the SOCKS client's application socket, and the service
 * node's socket to its target. Neither pump used to pause (audit S6): a fast
 * producer and a slow consumer grew the WebSocket send buffer without limit.
 *
 *  - socket → circuit: a chunk is written only as far as the circuit's credit
 *    and the connection's high-water mark allow; the rest is held and the
 *    socket PAUSED until `onWritable`. At most one chunk is ever held.
 *  - circuit → socket: credit goes back to the peer only when the socket has
 *    flushed the bytes (the write callback), so a local reader that stops
 *    reading stops the far end within one window.
 *  - A clean end is a half-close in each direction. A failed circuit
 *    (truncation, replay, reset) DESTROYS the socket, so the application sees
 *    an error rather than a clean end of stream.
 */

import type net from 'node:net';
import type { SessionError } from '@tnp/protocol/v1';
import type { SecureCircuit } from './secure-circuit';

export interface PipeOptions {
  /** Bytes already read from the socket (SOCKS early data). */
  early?: Uint8Array;
  /** Code sent sealed to the peer when the local socket fails. */
  abortCode: number;
  onClose?: (error: SessionError | null) => void;
}

/** After a clean close, an application that never closes its socket is cut off after this. */
const LINGER_MS = 30_000;

export function pipeSocket(socket: net.Socket, circuit: SecureCircuit, options: PipeOptions): void {
  let held: Uint8Array | null = options.early && options.early.length > 0 ? options.early : null;
  let socketEnded = false;
  let peerEnded = false;
  let finished = false;

  const flush = (): void => {
    if (finished) return;
    while (held) {
      const n = circuit.write(held);
      if (n === held.length) {
        held = null;
      } else {
        held = held.subarray(n);
        socket.pause();
        return;
      }
    }
    if (socketEnded) circuit.end();
    else if (socket.isPaused()) socket.resume();
  };

  circuit.bind({
    onData(data) {
      if (socket.destroyed) return;
      // Copied: the record buffer is not ours to hold while the socket queues it.
      const copy = Buffer.from(data);
      socket.write(copy, () => circuit.consumed(copy.length));
    },
    onEnd() {
      peerEnded = true;
      if (!socket.destroyed) socket.end();
    },
    onWritable: flush,
    onClose(error) {
      finished = true;
      held = null;
      if (error) {
        // A reset, not a FIN: closing normally could still look like a clean
        // end of stream to the application.
        if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
        else socket.destroy();
      } else if (!socket.destroyed) {
        socket.end();
        setTimeout(() => socket.destroy(), LINGER_MS).unref?.();
      }
      options.onClose?.(error);
    },
  });

  socket.on('data', (chunk: Buffer) => {
    if (finished) return;
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    if (held) {
      const merged = new Uint8Array(held.length + bytes.length);
      merged.set(held);
      merged.set(bytes, held.length);
      held = merged;
    } else {
      held = bytes.slice();
    }
    flush();
  });
  socket.on('end', () => {
    socketEnded = true;
    if (!held) circuit.end();
  });
  socket.on('error', () => {
    // 'close' follows with hadError; handled there.
  });
  socket.on('close', (hadError: boolean) => {
    if (circuit.closed) return;
    // Closed before both directions finished: the peer must not keep sending
    // into a socket nobody reads (it would wait on credit forever).
    if (hadError || !socketEnded || !peerEnded) circuit.reset(options.abortCode);
  });

  flush();
}
