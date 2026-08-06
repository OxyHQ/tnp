/**
 * TNP wire protocol v1 — frame codec.
 *
 * Layout, all integers big-endian:
 *
 *   0        1        2        4                12          16          20
 *   +--------+--------+--------+----------------+-----------+-----------+
 *   |version | type   | flags  |   circuitId    | streamId  |  length   |
 *   +--------+--------+--------+----------------+-----------+-----------+
 *   |                        payload (length bytes)                     |
 *   +-------------------------------------------------------------------+
 *
 * Replaces a five-byte header with no version, no length field and a 32-bit
 * circuit id that clients allocated from a counter starting at 1 — so two
 * honest clients collided immediately and a hostile one could tear down
 * another's circuits by guessing a small integer (audit S1).
 *
 * `circuitId` is 64-bit and CONNECTION-SCOPED: the same numeric value on two
 * different connections refers to two unrelated circuits. Nothing in this file
 * enforces that — it is a property of how a relay keys its tables — but the
 * width exists so identifiers can be generated from a CSPRNG rather than
 * counted, which is what makes guessing infeasible.
 */

import {
  HEADER_SIZE,
  KNOWN_FLAGS,
  MAX_ERROR_DETAIL,
  MAX_FRAME_PAYLOAD,
  PROTOCOL_VERSION,
  ErrorCode,
  ErrorScope,
  FrameType,
  isFrameType,
  type ErrorCodeValue,
  type ErrorScopeValue,
  type FrameTypeValue,
} from "./constants.js";

export interface Frame {
  version: number;
  type: FrameTypeValue;
  flags: number;
  circuitId: bigint;
  streamId: number;
  payload: Uint8Array;
}

/**
 * A frame could not be decoded.
 *
 * Carries the protocol error code the peer should be sent, so a caller does not
 * have to map a message string back onto a code — which is how "structured
 * errors" degrade into string matching.
 */
export class FrameDecodeError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCodeValue,
  ) {
    super(message);
    this.name = "FrameDecodeError";
  }
}

export interface EncodeOptions {
  type: FrameTypeValue;
  circuitId?: bigint;
  streamId?: number;
  flags?: number;
  payload?: Uint8Array;
}

export function encodeFrame(options: EncodeOptions): Uint8Array<ArrayBuffer> {
  const payload = options.payload ?? EMPTY;
  const flags = options.flags ?? 0;
  const circuitId = options.circuitId ?? 0n;
  const streamId = options.streamId ?? 0;

  if (payload.byteLength > MAX_FRAME_PAYLOAD) {
    throw new RangeError(
      `Payload of ${payload.byteLength} bytes exceeds MAX_FRAME_PAYLOAD (${MAX_FRAME_PAYLOAD})`,
    );
  }
  if ((flags & ~KNOWN_FLAGS) !== 0) {
    // Caught on the way OUT as well as in: emitting a bit the peer will reject
    // is a bug worth failing on locally, where the stack trace still exists.
    throw new RangeError(`Unknown flag bits set: 0x${(flags & ~KNOWN_FLAGS).toString(16)}`);
  }
  if (circuitId < 0n || circuitId > MAX_UINT64) {
    throw new RangeError(`circuitId out of range: ${circuitId}`);
  }
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new RangeError(`streamId out of range: ${streamId}`);
  }

  const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
  const view = new DataView(frame.buffer);

  frame[0] = PROTOCOL_VERSION;
  frame[1] = options.type;
  view.setUint16(2, flags, false);
  view.setBigUint64(4, circuitId, false);
  view.setUint32(12, streamId, false);
  view.setUint32(16, payload.byteLength, false);
  // Bytes 20..21 are the tail of the length field's 32-bit slot at offset 16;
  // the header is 22 bytes so payload begins at HEADER_SIZE.
  frame.set(payload, HEADER_SIZE);

  return frame;
}

export function decodeFrame(data: Uint8Array): Frame {
  if (data.byteLength < HEADER_SIZE) {
    throw new FrameDecodeError(
      `Frame too short: ${data.byteLength} bytes, need at least ${HEADER_SIZE}`,
      ErrorCode.PROTOCOL_VIOLATION,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const version = data[0];
  if (version !== PROTOCOL_VERSION) {
    // Checked first and reported distinctly: a peer speaking another major
    // version needs to be told that, not handed a generic parse failure it
    // cannot act on.
    throw new FrameDecodeError(
      `Unsupported protocol version 0x${version.toString(16).padStart(2, "0")}`,
      ErrorCode.UNSUPPORTED_VERSION,
    );
  }

  const rawType = data[1];
  if (!isFrameType(rawType)) {
    throw new FrameDecodeError(
      `Unknown frame type 0x${rawType.toString(16).padStart(2, "0")}`,
      ErrorCode.PROTOCOL_VIOLATION,
    );
  }

  const flags = view.getUint16(2, false);
  if ((flags & ~KNOWN_FLAGS) !== 0) {
    throw new FrameDecodeError(
      `Unknown flag bits set: 0x${(flags & ~KNOWN_FLAGS).toString(16)}`,
      ErrorCode.PROTOCOL_VIOLATION,
    );
  }

  const circuitId = view.getBigUint64(4, false);
  const streamId = view.getUint32(12, false);
  const length = view.getUint32(16, false);

  if (length > MAX_FRAME_PAYLOAD) {
    throw new FrameDecodeError(
      `Declared payload of ${length} bytes exceeds MAX_FRAME_PAYLOAD (${MAX_FRAME_PAYLOAD})`,
      ErrorCode.PROTOCOL_VIOLATION,
    );
  }

  // The declared length must match what arrived exactly. Accepting a short
  // frame and reading `length` bytes anyway is how a parser reads adjacent
  // memory; accepting a long one silently discards data the sender meant to
  // send.
  if (data.byteLength !== HEADER_SIZE + length) {
    throw new FrameDecodeError(
      `Frame length mismatch: header declares ${length} payload bytes, frame carries ${
        data.byteLength - HEADER_SIZE
      }`,
      ErrorCode.PROTOCOL_VIOLATION,
    );
  }

  return {
    version,
    type: rawType,
    flags,
    circuitId,
    streamId,
    // A view, not a copy: the caller owns the lifetime of `data`.
    payload: data.subarray(HEADER_SIZE, HEADER_SIZE + length),
  };
}

// ---------------------------------------------------------------------------
// ERROR frames
// ---------------------------------------------------------------------------

export interface ProtocolError {
  code: ErrorCodeValue;
  scope: ErrorScopeValue;
  /** Diagnostic text. Never carries anything the peer is not entitled to know. */
  detail: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const EMPTY = new Uint8Array(0);
const MAX_UINT64 = 0xffffffffffffffffn;

/**
 * ERROR payload: code(2) scope(1) detail(rest).
 *
 * No length field for the detail: the frame header already carries the payload
 * length, so a second one would be redundant AND a hazard — an earlier draft
 * used a single byte here, which silently encoded a 256-byte detail as zero
 * length and dropped it entirely. One length, in one place.
 */
export function encodeError(
  error: ProtocolError,
  circuitId = 0n,
  streamId = 0,
): Uint8Array<ArrayBuffer> {
  const detailBytes = truncateUtf8(error.detail, MAX_ERROR_DETAIL);
  const payload = new Uint8Array(3 + detailBytes.byteLength);
  const view = new DataView(payload.buffer);

  view.setUint16(0, error.code, false);
  payload[2] = error.scope;
  payload.set(detailBytes, 3);

  return encodeFrame({ type: FrameType.ERROR, circuitId, streamId, payload });
}

export function decodeError(payload: Uint8Array): ProtocolError {
  if (payload.byteLength < 3) {
    throw new FrameDecodeError(
      `ERROR payload too short: ${payload.byteLength} bytes, need at least 3`,
      ErrorCode.PROTOCOL_VIOLATION,
    );
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  return {
    code: view.getUint16(0, false) as ErrorCodeValue,
    scope: payload[2] as ErrorScopeValue,
    detail: textDecoder.decode(payload.subarray(3)),
  };
}

/**
 * Encode `value` to UTF-8, truncated to `maxBytes` on a character boundary.
 *
 * Slicing the STRING to a byte budget is wrong — a multi-byte character can
 * straddle the cut, and the result is either over budget or ends in a broken
 * sequence. Encode first, then walk back off any continuation byte.
 */
function truncateUtf8(value: string, maxBytes: number): Uint8Array {
  const encoded = textEncoder.encode(value);
  if (encoded.byteLength <= maxBytes) return encoded;

  let end = maxBytes;
  // 0b10xxxxxx is a continuation byte; back up to the start of its sequence.
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end);
}

export { ErrorCode, ErrorScope, FrameType };
