/**
 * Credit-based flow control.
 *
 * Two levels, because one is not enough: a per-stream window alone lets a peer
 * open many streams to evade the limit, and a per-circuit window alone lets one
 * stream starve every other on the same circuit.
 *
 * The transport had none. Neither the SOCKS5 pump nor the service-node pump
 * ever paused its socket or looked at how much was already buffered, so a fast
 * producer against a slow consumer grew the send buffer without limit
 * (audit S6).
 */

import { CIRCUIT_WINDOW_INITIAL, STREAM_WINDOW_INITIAL } from './constants.js';

/**
 * Largest credit a single grant, consume or window may express: 2^32 − 1,
 * so every credit value fits a u32 on the wire.
 */
export const MAX_WINDOW_CREDIT = 0xffffffff;

/**
 * Throw unless `bytes` is an integer in [0, MAX_WINDOW_CREDIT].
 *
 * The window arithmetic is only sound on integers. `grant(NaN)` used to make
 * `available` NaN — after which `bytes > available` is false for every
 * `bytes`, so the window silently stopped limiting anything. Negative,
 * fractional, infinite and out-of-range values are all refused the same way.
 */
function assertCredit(bytes: number, operation: string): void {
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_WINDOW_CREDIT) {
    throw new RangeError(
      `${operation}: credit must be an integer in [0, ${MAX_WINDOW_CREDIT}], got ${bytes}`,
    );
  }
}

/**
 * One direction of one window.
 *
 * A sender may have at most `available` unacknowledged payload bytes
 * outstanding. The receiver grants more as it consumes. Invariant, enforced
 * by every method: `0 <= available <= initial`, both integers.
 */
export class FlowWindow {
  private available: number;
  private readonly initial: number;

  constructor(initial: number) {
    assertCredit(initial, 'FlowWindow');
    if (initial === 0) throw new RangeError('FlowWindow: initial window must be positive');
    this.initial = initial;
    this.available = initial;
  }

  get remaining(): number {
    return this.available;
  }

  get exhausted(): boolean {
    return this.available === 0;
  }

  /**
   * Reserve credit for `bytes`.
   *
   * Returns false when the window cannot cover it. The caller must then pause
   * rather than send anyway — sending past the window is a `FLOW_CONTROL`
   * violation and closes the circuit. Throws on a non-integer or out-of-range
   * amount.
   */
  consume(bytes: number): boolean {
    assertCredit(bytes, 'consume');
    if (bytes > this.available) return false;
    this.available -= bytes;
    return true;
  }

  /**
   * Grant `bytes` of additional credit.
   *
   * Clamped to the initial window: a peer that grants more credit than it ever
   * advertised is either buggy or trying to make the sender exceed the bound
   * the window exists to enforce, and both are handled the same way. Throws on
   * a non-integer or out-of-range amount — a malformed grant from the wire is
   * a protocol violation, not "zero credit".
   */
  grant(bytes: number): void {
    assertCredit(bytes, 'grant');
    // Compared before adding, so the sum is never formed outside the range.
    this.available = bytes >= this.initial - this.available ? this.initial : this.available + bytes;
  }

  reset(): void {
    this.available = this.initial;
  }
}

/**
 * A stream's window, paired with its circuit's.
 *
 * Both must have credit for a write to proceed, and both are debited — which is
 * what makes the circuit window a real ceiling across all of its streams rather
 * than a per-stream limit wearing a different name.
 */
export class StreamFlow {
  readonly stream: FlowWindow;

  constructor(
    readonly circuit: FlowWindow,
    streamWindow: number = STREAM_WINDOW_INITIAL,
  ) {
    this.stream = new FlowWindow(streamWindow);
  }

  get sendable(): number {
    return Math.min(this.stream.remaining, this.circuit.remaining);
  }

  /** Debit both windows, or neither. Throws on a non-integer or out-of-range amount. */
  consume(bytes: number): boolean {
    assertCredit(bytes, 'consume');
    if (bytes > this.sendable) return false;
    // `sendable` already proved both can cover it, so neither can fail here and
    // leave the pair inconsistent.
    this.stream.consume(bytes);
    this.circuit.consume(bytes);
    return true;
  }

  grant(bytes: number): void {
    assertCredit(bytes, 'grant');
    this.stream.grant(bytes);
    this.circuit.grant(bytes);
  }
}

export function createCircuitWindow(size: number = CIRCUIT_WINDOW_INITIAL): FlowWindow {
  return new FlowWindow(size);
}
