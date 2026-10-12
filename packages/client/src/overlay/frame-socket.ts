/**
 * A WebSocket to a relay carrying v1 frames, with a send-buffer high-water
 * mark. Used by the client's relay links and by the service node.
 *
 * The browser-style `WebSocket` Bun provides has no drain event, so when the
 * buffer is above the high-water mark a short poll waits for it to fall below
 * the low-water mark and then tells the owner to resume its pumps.
 */

import { decodeFrame, type Frame, MAX_FRAME_SIZE } from '@tnp/protocol/v1';

/** Above this many buffered bytes, pumps pause. */
export const SEND_HIGH_WATER = 1024 * 1024;
/** Pumps resume once the buffer falls below this. */
export const SEND_LOW_WATER = 256 * 1024;
const DRAIN_POLL_MS = 5;

export interface FrameSocketHandlers {
  onFrame(frame: Frame): void;
  onClose(): void;
  /** The buffer drained below the low-water mark after being congested. */
  onDrain(): void;
}

export class FrameSocket {
  private closed = false;
  private draining: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly ws: WebSocket,
    private handlers: FrameSocketHandlers,
  ) {
    ws.addEventListener('message', (event: MessageEvent) => {
      if (this.closed) return;
      const data = event.data;
      if (!(data instanceof ArrayBuffer) || data.byteLength > MAX_FRAME_SIZE) {
        this.close(1003, 'binary frames only');
        return;
      }
      let frame: Frame;
      try {
        frame = decodeFrame(new Uint8Array(data));
      } catch {
        // A relay speaking garbage is not a relay to keep talking to.
        this.close(1002, 'protocol error');
        return;
      }
      try {
        this.handlers.onFrame(frame);
      } catch (err) {
        // Nothing the relay sends may crash the process.
        console.error(`[tnp] dropped a relay frame: ${err instanceof Error ? err.name : 'error'}`);
      }
    });
    ws.addEventListener('close', () => this.markClosed());
    ws.addEventListener('error', () => this.markClosed());
  }

  /**
   * Open a socket to `url`. The instance exists at once — so a handler can
   * reply to the very first frame — and `ready` resolves once it is connected
   * (or rejects on failure or timeout).
   */
  static open(
    url: string,
    handlers: FrameSocketHandlers,
    timeoutMs: number,
    headers?: Record<string, string>,
  ): { socket: FrameSocket; ready: Promise<void> } {
    // `headers` is Bun's extension to the WebSocket constructor.
    const ws = headers
      ? new WebSocket(url, { headers } as unknown as string[])
      : new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const socket = new FrameSocket(ws, handlers);
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('relay connection timed out'));
      }, timeoutMs);
      const onError = () => {
        clearTimeout(timer);
        reject(new Error('could not connect to the relay'));
      };
      ws.addEventListener('error', onError, { once: true });
      ws.addEventListener('close', onError, { once: true });
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          ws.removeEventListener('error', onError);
          ws.removeEventListener('close', onError);
          resolve();
        },
        { once: true },
      );
    });
    return { socket, ready };
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  congested(): boolean {
    return this.ws.bufferedAmount > SEND_HIGH_WATER;
  }

  send(frame: Uint8Array): boolean {
    if (!this.isOpen) return false;
    this.ws.send(frame as Uint8Array<ArrayBuffer>);
    if (this.congested()) this.watchDrain();
    return true;
  }

  close(code = 1000, reason = ''): void {
    try {
      this.ws.close(code, reason);
    } catch {
      // already closing
    }
    this.markClosed();
  }

  private watchDrain(): void {
    if (this.draining) return;
    const poll = () => {
      this.draining = null;
      if (this.closed) return;
      if (this.ws.bufferedAmount < SEND_LOW_WATER) this.handlers.onDrain();
      else this.draining = setTimeout(poll, DRAIN_POLL_MS);
    };
    this.draining = setTimeout(poll, DRAIN_POLL_MS);
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.draining) clearTimeout(this.draining);
    this.handlers.onClose();
  }
}
