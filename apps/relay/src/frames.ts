/**
 * Binary frame protocol for relay communication.
 *
 * Frame layout (big-endian):
 *   [circuitId: 4 bytes (uint32)] [type: 1 byte] [payload: remaining bytes]
 *
 * Minimum frame size is 5 bytes (header only, empty payload).
 */

const HEADER_SIZE = 5;

export const enum FrameType {
  DATA = 0x01,
  OPEN = 0x02,
  OPENED = 0x03,
  CLOSE = 0x04,
  ERROR = 0x05,
}

export interface Frame {
  circuitId: number;
  type: FrameType;
  payload: Uint8Array;
}

/**
 * Encode a relay frame into a binary Uint8Array.
 */
export function encodeFrame(
  circuitId: number,
  type: FrameType,
  payload: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(HEADER_SIZE + payload.byteLength);
  const view = new DataView(frame.buffer);

  view.setUint32(0, circuitId, false);
  frame[4] = type;
  frame.set(payload, HEADER_SIZE);

  return frame;
}

/**
 * Decode a binary Uint8Array into a relay frame.
 * Throws if the data is too short to contain a valid header.
 */
export function decodeFrame(data: Uint8Array): Frame {
  if (data.byteLength < HEADER_SIZE) {
    throw new RangeError(
      `Frame too short: expected at least ${HEADER_SIZE} bytes, got ${data.byteLength}`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const circuitId = view.getUint32(0, false);
  const rawType = data[4];

  if (
    rawType !== FrameType.DATA &&
    rawType !== FrameType.OPEN &&
    rawType !== FrameType.OPENED &&
    rawType !== FrameType.CLOSE &&
    rawType !== FrameType.ERROR
  ) {
    throw new RangeError(`Unknown frame type: 0x${rawType.toString(16).padStart(2, "0")}`);
  }

  const type: FrameType = rawType;
  const payload = data.subarray(HEADER_SIZE);

  return { circuitId, type, payload };
}
