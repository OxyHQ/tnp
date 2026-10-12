/**
 * One end of an end-to-end circuit: the session (`@tnp/protocol/v1`), the
 * stream messages inside it, flow control and close semantics. Used by both
 * the client (`tunnel.ts`) and the service node (`service-node.ts`).
 *
 * Normative spec: docs/architecture/transport.md §11.
 *
 * Every record is a sealed STREAM_DATA frame on stream E2E_STREAM_ID; the
 * relay forwards it and can do nothing else with it. Inside, in order:
 *
 *   client → service   OPEN(port)  DATA…  FIN          WINDOW…   CLOSE
 *   service → client   OPENED      DATA…  FIN          WINDOW…   CLOSE
 *
 * (or RESET(code) then CLOSE, from either side, to abort).
 *
 *  - Replay, reordering, reflection or tampering by the relay kills the
 *    session (`SessionCipher.open` throws), and the circuit ends with that
 *    error — never with silently altered data.
 *  - Data ends only at an authenticated FIN. A relay that cuts the circuit
 *    before the peer's FIN produces TRUNCATED, and the local socket is
 *    destroyed rather than ended, so the application sees an error and not a
 *    clean end of stream.
 *  - Each direction has a STREAM_WINDOW_INITIAL credit window. A peer sending
 *    past the credit it was granted is a FLOW_CONTROL violation; the local
 *    pump stops when credit runs out or the connection's send buffer is above
 *    its high-water mark, and resumes on `onWritable`.
 *  - On clean completion only the CLIENT sends CIRCUIT_DESTROY, so the relay
 *    sees one teardown per circuit.
 */

import {
  DESTROY_NORMAL,
  decodeStreamMessage,
  E2E_STREAM_ID,
  encodeDestroy,
  encodeFrame,
  encodeStreamMessage,
  ErrorCode,
  type ErrorCodeValue,
  type Frame,
  FrameDecodeError,
  FrameType,
  FlowWindow,
  MAX_STREAM_DATA,
  type RecordHeader,
  RekeyRequiredError,
  SessionError,
  type SessionCipher,
  type StreamMessage,
  STREAM_WINDOW_INITIAL,
} from '@tnp/protocol/v1';

const RECORD_HEADER: RecordHeader = {
  type: FrameType.STREAM_DATA,
  flags: 0,
  streamId: E2E_STREAM_ID,
};

/** Credit is returned in batches of at least this much. */
const GRANT_THRESHOLD = STREAM_WINDOW_INITIAL / 4;

/** What a circuit needs from the connection it runs over. */
export interface CircuitLink {
  /** Send one frame. False when the connection is gone. */
  send(frame: Uint8Array): boolean;
  /** Whether the connection's send buffer is above its high-water mark. */
  congested(): boolean;
}

/** Lifecycle hooks, fixed when the circuit is created. */
export interface SecureCircuitHooks {
  /** Service side: the client asked for `port`. Answer with `accept()` or `reset()`. */
  onOpen?(port: number): void;
  /** Client side: the service node connected to its target. */
  onOpened?(): void;
  /** The circuit is over (after `onClose`). For the owner's bookkeeping. */
  onDone?(error: SessionError | null): void;
}

/**
 * The data path, bound once the local socket exists (`pipeSocket`). Anything
 * that arrives before `bind` is held and replayed in order -- bounded by the
 * flow-control window, since no credit is returned until it is consumed.
 */
export interface SecureCircuitEvents {
  onData(data: Uint8Array): void;
  /** The peer's authenticated FIN: no more data will arrive. */
  onEnd(): void;
  /** More can be written (credit arrived or the connection drained). */
  onWritable(): void;
  /**
   * The circuit is over. `null` is a clean finish; otherwise the reason: a
   * `SessionError` whose `code` says what (REPLAY_DETECTED, DECRYPT_FAILED,
   * TRUNCATED, the peer's RESET code, and so on).
   */
  onClose(error: SessionError | null): void;
}

type Backlog =
  | { kind: 'data'; data: Uint8Array }
  | { kind: 'end' }
  | { kind: 'close'; error: SessionError | null };

export class SecureCircuit {
  private readonly sendWindow = new FlowWindow(STREAM_WINDOW_INITIAL);
  private receivedUngranted = 0;
  private consumedUngranted = 0;
  private started = false;
  private sentOpened = false;
  private sentFin = false;
  private peerFin = false;
  private sentClose = false;
  private peerClose = false;
  private done = false;

  constructor(
    readonly id: bigint,
    private readonly session: SessionCipher,
    private readonly link: CircuitLink,
    private readonly role: 'client' | 'service',
    private readonly hooks: SecureCircuitHooks = {},
  ) {}

  private events: SecureCircuitEvents | null = null;
  private backlog: Backlog[] = [];

  /** Attach the data path; replays anything that arrived first. */
  bind(events: SecureCircuitEvents): void {
    this.events = events;
    const backlog = this.backlog;
    this.backlog = [];
    for (const item of backlog) {
      if (item.kind === 'data') events.onData(item.data);
      else if (item.kind === 'end') events.onEnd();
      else events.onClose(item.error);
    }
    if (!this.done) events.onWritable();
  }

  /** The connection drained: let a paused writer retry. */
  poke(): void {
    if (!this.done) this.events?.onWritable();
  }

  get closed(): boolean {
    return this.done;
  }

  /** Bytes `write` will take now. */
  get writable(): number {
    if (this.done || this.sentFin || this.link.congested()) return 0;
    if (this.role === 'service' && !this.sentOpened) return 0;
    return Math.min(this.sendWindow.remaining, MAX_STREAM_DATA);
  }

  /** Client: ask the service node for `port`. Sent first, before any data. */
  open(port: number): void {
    if (this.role !== 'client') throw new Error('only the client opens');
    this.sendMessage({ type: 'open', port });
  }

  /** Service: the target accepted. */
  accept(): void {
    if (this.role !== 'service' || this.sentOpened) return;
    this.sentOpened = true;
    this.sendMessage({ type: 'opened' });
    this.events?.onWritable();
  }

  /** Write as much of `data` as credit allows; returns the number of bytes taken. */
  write(data: Uint8Array): number {
    let offset = 0;
    while (offset < data.length) {
      const room = this.writable;
      if (room === 0) break;
      const n = Math.min(room, data.length - offset);
      if (!this.sendWindow.consume(n)) break;
      if (!this.sendMessage({ type: 'data', data: data.subarray(offset, offset + n) })) break;
      offset += n;
    }
    return offset;
  }

  /** The local consumer has taken `n` delivered bytes: return credit to the peer. */
  consumed(n: number): void {
    if (this.done || this.peerFin || this.sentClose) return;
    this.consumedUngranted += n;
    if (this.consumedUngranted >= GRANT_THRESHOLD) {
      const credit = Math.min(this.consumedUngranted, this.receivedUngranted);
      this.consumedUngranted = 0;
      if (credit <= 0) return;
      this.receivedUngranted -= credit;
      this.sendMessage({ type: 'window', credit });
    }
  }

  /** No more data from this side (half-close). */
  end(): void {
    if (this.done || this.sentFin) return;
    this.sentFin = true;
    this.sendMessage({ type: 'fin' });
    this.maybeClose();
  }

  /**
   * Abort with `code` (sealed — the relay never sees it). Codes are generic
   * protocol codes; never a hostname, an address or an error string.
   */
  reset(code: number): void {
    if (this.done) return;
    this.sendMessage({ type: 'reset', code });
    this.sendSessionClose();
    // Either side releases the relay's state for an abort; a duplicate destroy
    // from the peer is dropped by the relay at no cost.
    this.finish(null, true, true);
  }

  /** Tear down locally (shutdown, link lost on our side). */
  abort(): void {
    if (this.done) return;
    this.finish(new SessionError('circuit aborted locally', ErrorCode.TRUNCATED), true);
  }

  /** A frame for this circuit arrived from the relay. */
  receive(frame: Frame): void {
    if (this.done) return;
    if (frame.type === FrameType.CIRCUIT_DESTROY) {
      this.remoteDestroyed();
      return;
    }
    if (
      frame.type !== FrameType.STREAM_DATA ||
      frame.streamId !== E2E_STREAM_ID ||
      frame.flags !== 0
    ) {
      this.fail(
        new SessionError('unexpected frame on an open circuit', ErrorCode.PROTOCOL_VIOLATION),
      );
      return;
    }
    let opened: ReturnType<SessionCipher['open']>;
    try {
      opened = this.session.open(frame.payload, frame);
    } catch (err) {
      this.fail(
        err instanceof SessionError
          ? err
          : new SessionError('record refused', ErrorCode.PROTOCOL_VIOLATION),
      );
      return;
    }
    if (opened.type === 'key-update') return;
    if (opened.type === 'close') {
      this.peerClose = true;
      if (!this.peerFin) {
        // A CLOSE without a FIN is legitimate only after a RESET, which
        // finishes the circuit on arrival; here it means data was cut short.
        this.fail(new SessionError('peer closed without finishing its data', ErrorCode.TRUNCATED));
        return;
      }
      this.maybeComplete();
      return;
    }
    let message: StreamMessage;
    try {
      message = decodeStreamMessage(opened.plaintext);
    } catch (err) {
      this.fail(
        new SessionError(
          'malformed stream message',
          err instanceof FrameDecodeError ? err.code : ErrorCode.PROTOCOL_VIOLATION,
        ),
      );
      return;
    }
    this.handleMessage(message);
  }

  /** The relay destroyed the circuit or the connection to it was lost. */
  remoteDestroyed(): void {
    if (this.done) return;
    if (this.peerFin) {
      // Everything the peer meant to send arrived, authenticated, up to its
      // FIN. Our own unsent tail is the only casualty.
      this.finish(null, false);
      return;
    }
    this.finish(
      new SessionError('circuit ended before the peer finished', ErrorCode.TRUNCATED),
      false,
    );
  }

  // -------------------------------------------------------------------------

  private handleMessage(message: StreamMessage): void {
    const first = !this.started;
    this.started = true;
    switch (message.type) {
      case 'open':
        if (this.role !== 'service' || !first) {
          this.violation();
          return;
        }
        this.hooks.onOpen?.(message.port);
        return;
      case 'opened':
        if (this.role !== 'client' || !first) {
          this.violation();
          return;
        }
        this.hooks.onOpened?.();
        this.events?.onWritable();
        return;
      case 'reset':
        this.finish(
          new SessionError('peer reset the stream', message.code as ErrorCodeValue),
          true,
        );
        return;
      case 'window':
        if (first && this.role === 'service') {
          this.violation();
          return;
        }
        this.sendWindow.grant(message.credit);
        this.events?.onWritable();
        return;
      case 'data': {
        if (first || this.peerFin) {
          this.violation();
          return;
        }
        const n = message.data.length;
        if (this.receivedUngranted + n > STREAM_WINDOW_INITIAL) {
          this.fail(
            new SessionError('peer exceeded its flow-control window', ErrorCode.FLOW_CONTROL),
          );
          return;
        }
        this.receivedUngranted += n;
        if (this.events) this.events.onData(message.data);
        else this.backlog.push({ kind: 'data', data: message.data.slice() });
        return;
      }
      case 'fin':
        if (first || this.peerFin) {
          this.violation();
          return;
        }
        this.peerFin = true;
        if (this.events) this.events.onEnd();
        else this.backlog.push({ kind: 'end' });
        this.maybeClose();
        return;
    }
  }

  private violation(): void {
    this.fail(new SessionError('stream message out of order', ErrorCode.PROTOCOL_VIOLATION));
  }

  /** Seal and send one stream message. */
  private sendMessage(message: StreamMessage): boolean {
    if (this.done || this.sentClose) return false;
    try {
      if (this.session.needsKeyUpdate) this.sendRecord(this.session.updateKey(RECORD_HEADER));
      let record: Uint8Array;
      try {
        record = this.session.seal(encodeStreamMessage(message), RECORD_HEADER);
      } catch (err) {
        if (!(err instanceof RekeyRequiredError)) throw err;
        this.sendRecord(this.session.updateKey(RECORD_HEADER));
        record = this.session.seal(encodeStreamMessage(message), RECORD_HEADER);
      }
      return this.sendRecord(record);
    } catch (err) {
      this.fail(
        err instanceof SessionError
          ? err
          : new SessionError('send failed', ErrorCode.PROTOCOL_VIOLATION),
      );
      return false;
    }
  }

  private sendRecord(record: Uint8Array): boolean {
    const ok = this.link.send(
      encodeFrame({
        type: FrameType.STREAM_DATA,
        circuitId: this.id,
        streamId: E2E_STREAM_ID,
        payload: record,
      }),
    );
    if (!ok)
      this.finish(new SessionError('connection to the relay lost', ErrorCode.TRUNCATED), false);
    return ok;
  }

  private sendSessionClose(): void {
    if (this.sentClose || this.done) return;
    try {
      this.sendRecord(this.session.close(RECORD_HEADER));
    } catch {
      // A dead session cannot close; finishing handles the rest.
    }
    this.sentClose = true;
  }

  /** Both FINs exchanged: nothing more to say, so close the session. */
  private maybeClose(): void {
    if (this.sentFin && this.peerFin && !this.sentClose) {
      this.sendSessionClose();
      this.maybeComplete();
    }
  }

  private maybeComplete(): void {
    if (this.sentClose && this.peerClose) this.finish(null, true);
  }

  private fail(error: SessionError): void {
    // A session failure is announced to the relay from either side, so its
    // state is released even if the peer never learns of it.
    this.finish(error, true, true);
  }

  private finish(error: SessionError | null, notifyRelay: boolean, force = false): void {
    if (this.done) return;
    this.done = true;
    // The client tears the circuit down at the relay; the service node does
    // so only for a failure it detected (`force`), so a clean circuit is
    // destroyed exactly once.
    if (notifyRelay && (this.role === 'client' || force)) {
      this.link.send(
        encodeFrame({
          type: FrameType.CIRCUIT_DESTROY,
          circuitId: this.id,
          payload: encodeDestroy(DESTROY_NORMAL),
        }),
      );
    }
    if (this.events) this.events.onClose(error);
    else this.backlog.push({ kind: 'close', error });
    this.hooks.onDone?.(error);
  }
}
