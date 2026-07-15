import { describe, expect, test } from "bun:test";
import { decodeFrame, encodeFrame, FrameType } from "./frames";

const ALL_TYPES: ReadonlyArray<[string, FrameType]> = [
  ["DATA", FrameType.DATA],
  ["OPEN", FrameType.OPEN],
  ["OPENED", FrameType.OPENED],
  ["CLOSE", FrameType.CLOSE],
  ["ERROR", FrameType.ERROR],
];

describe("encodeFrame layout", () => {
  test("writes a 5-byte header before the payload", () => {
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const frame = encodeFrame(1, FrameType.DATA, payload);
    expect(frame.byteLength).toBe(5 + payload.byteLength);
  });

  test("encodes circuitId as a big-endian uint32", () => {
    const frame = encodeFrame(0x01020304, FrameType.OPEN, new Uint8Array(0));
    expect(Array.from(frame.subarray(0, 4))).toEqual([0x01, 0x02, 0x03, 0x04]);
  });

  test("writes the frame type in byte index 4", () => {
    const frame = encodeFrame(0, FrameType.CLOSE, new Uint8Array(0));
    expect(frame[4]).toBe(FrameType.CLOSE);
  });

  test("copies the payload starting at byte index 5", () => {
    const payload = new Uint8Array([9, 8, 7]);
    const frame = encodeFrame(0, FrameType.DATA, payload);
    expect(Array.from(frame.subarray(5))).toEqual([9, 8, 7]);
  });

  test("produces a 5-byte frame for an empty payload", () => {
    const frame = encodeFrame(42, FrameType.OPENED, new Uint8Array(0));
    expect(frame.byteLength).toBe(5);
  });
});

describe("encode/decode round-trip", () => {
  for (const [label, type] of ALL_TYPES) {
    test(`round-trips a ${label} frame`, () => {
      const payload = new TextEncoder().encode(`payload-for-${label}`);
      const decoded = decodeFrame(encodeFrame(7, type, payload));
      expect(decoded.circuitId).toBe(7);
      expect(decoded.type).toBe(type);
      expect(new TextDecoder().decode(decoded.payload)).toBe(`payload-for-${label}`);
    });
  }

  test("preserves the maximum uint32 circuitId (0xFFFFFFFF)", () => {
    const decoded = decodeFrame(encodeFrame(0xffffffff, FrameType.DATA, new Uint8Array(0)));
    expect(decoded.circuitId).toBe(0xffffffff);
  });

  test("preserves a zero circuitId", () => {
    const decoded = decodeFrame(encodeFrame(0, FrameType.DATA, new Uint8Array(0)));
    expect(decoded.circuitId).toBe(0);
  });

  test("round-trips a large 64 KiB payload byte-for-byte", () => {
    const payload = new Uint8Array(65536);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const decoded = decodeFrame(encodeFrame(123, FrameType.DATA, payload));
    expect(decoded.payload).toEqual(payload);
  });

  test("decodes an empty payload as a zero-length array", () => {
    const decoded = decodeFrame(encodeFrame(1, FrameType.CLOSE, new Uint8Array(0)));
    expect(decoded.payload.byteLength).toBe(0);
  });
});

describe("decodeFrame with a byte offset", () => {
  test("decodes a frame embedded inside a larger buffer", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const frame = encodeFrame(55, FrameType.OPEN, payload);
    // Place the frame at offset 8 inside a larger backing buffer so that
    // byteOffset != 0 — exercises the DataView(offset, length) path.
    const backing = new Uint8Array(frame.byteLength + 8);
    backing.set(frame, 8);
    const view = backing.subarray(8);
    const decoded = decodeFrame(view);
    expect(decoded.circuitId).toBe(55);
    expect(decoded.type).toBe(FrameType.OPEN);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3]);
  });
});

describe("decodeFrame rejects malformed input", () => {
  test("throws when the buffer is shorter than the 5-byte header", () => {
    expect(() => decodeFrame(new Uint8Array(4))).toThrow(RangeError);
    expect(() => decodeFrame(new Uint8Array(0))).toThrow(
      "Frame too short: expected at least 5 bytes, got 0",
    );
  });

  test("throws on an unknown frame type byte", () => {
    const frame = encodeFrame(1, FrameType.DATA, new Uint8Array(0));
    frame[4] = 0x00;
    expect(() => decodeFrame(frame)).toThrow("Unknown frame type: 0x00");
  });

  test("throws on a frame type byte above the defined range", () => {
    const frame = encodeFrame(1, FrameType.DATA, new Uint8Array(0));
    frame[4] = 0xff;
    expect(() => decodeFrame(frame)).toThrow("Unknown frame type: 0xff");
  });
});
