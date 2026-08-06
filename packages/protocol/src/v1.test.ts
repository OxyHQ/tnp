import { describe, expect, test } from "bun:test";
import {
  Capability,
  ErrorCode,
  ErrorScope,
  Flags,
  FrameType,
  HEADER_SIZE,
  MAX_ERROR_DETAIL,
  MAX_FRAME_PAYLOAD,
  PROTOCOL_VERSION,
  REQUIRED_CAPABILITIES,
} from "./constants";
import { decodeError, decodeFrame, encodeError, encodeFrame, FrameDecodeError } from "./frame";
import { CircuitTable, generateCircuitId, generateStreamId } from "./circuit-id";
import { createCircuitWindow, FlowWindow, StreamFlow } from "./flow-control";

describe("frame codec", () => {
  test("round-trips every field", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const frame = decodeFrame(
      encodeFrame({
        type: FrameType.STREAM_DATA,
        circuitId: 0x0123456789abcdefn,
        streamId: 0xdeadbeef,
        flags: Flags.CLOSE_WRITE,
        payload,
      }),
    );

    expect(frame.version).toBe(PROTOCOL_VERSION);
    expect(frame.type).toBe(FrameType.STREAM_DATA);
    expect(frame.circuitId).toBe(0x0123456789abcdefn);
    expect(frame.streamId).toBe(0xdeadbeef);
    expect(frame.flags).toBe(Flags.CLOSE_WRITE);
    expect([...frame.payload]).toEqual([1, 2, 3, 4, 5]);
  });

  test("carries the full 64-bit circuit id without loss", () => {
    // The old header had 32 bits. Truncation here would silently alias two
    // circuits onto one id.
    const max = 0xffffffffffffffffn;
    expect(decodeFrame(encodeFrame({ type: FrameType.PING, circuitId: max })).circuitId).toBe(max);
  });

  test("an empty payload is valid", () => {
    const frame = decodeFrame(encodeFrame({ type: FrameType.PING }));
    expect(frame.payload.byteLength).toBe(0);
    expect(frame.circuitId).toBe(0n);
  });

  test("header is exactly HEADER_SIZE bytes", () => {
    expect(encodeFrame({ type: FrameType.PING }).byteLength).toBe(HEADER_SIZE);
  });
});

describe("frame decoding rejects malformed input", () => {
  test("a short frame", () => {
    expect(() => decodeFrame(new Uint8Array(HEADER_SIZE - 1))).toThrow(FrameDecodeError);
  });

  test("a wrong version, distinctly from a parse failure", () => {
    // A peer on another major version has to be told THAT, not handed a generic
    // violation it cannot act on.
    const frame = encodeFrame({ type: FrameType.PING });
    frame[0] = 0x02;
    try {
      decodeFrame(frame);
      throw new Error("expected a decode error");
    } catch (err) {
      expect(err).toBeInstanceOf(FrameDecodeError);
      expect((err as FrameDecodeError).code).toBe(ErrorCode.UNSUPPORTED_VERSION);
    }
  });

  test("an unknown frame type", () => {
    const frame = encodeFrame({ type: FrameType.PING });
    frame[1] = 0xff;
    expect(() => decodeFrame(frame)).toThrow(/Unknown frame type/);
  });

  test("an unknown flag bit, rather than ignoring it", () => {
    // A peer that ignores a flag it does not understand cannot tell a future
    // extension from a corrupted frame.
    const frame = encodeFrame({ type: FrameType.PING });
    frame[2] = 0x80;
    try {
      decodeFrame(frame);
      throw new Error("expected a decode error");
    } catch (err) {
      expect((err as FrameDecodeError).code).toBe(ErrorCode.PROTOCOL_VIOLATION);
    }
  });

  test("a declared length larger than the frame", () => {
    // Reading `length` bytes from a shorter buffer is how a parser reads
    // adjacent memory.
    const frame = encodeFrame({ type: FrameType.STREAM_DATA, payload: new Uint8Array(4) });
    new DataView(frame.buffer).setUint32(16, 1000, false);
    expect(() => decodeFrame(frame)).toThrow(/length mismatch/);
  });

  test("a declared length smaller than the frame", () => {
    // Accepting this would silently discard bytes the sender meant to send.
    const frame = encodeFrame({ type: FrameType.STREAM_DATA, payload: new Uint8Array(8) });
    new DataView(frame.buffer).setUint32(16, 2, false);
    expect(() => decodeFrame(frame)).toThrow(/length mismatch/);
  });

  test("a declared length beyond MAX_FRAME_PAYLOAD", () => {
    // The bound the old protocol did not have: without it a receiver grows a
    // buffer to whatever a sender declares.
    const frame = encodeFrame({ type: FrameType.STREAM_DATA });
    new DataView(frame.buffer).setUint32(16, MAX_FRAME_PAYLOAD + 1, false);
    expect(() => decodeFrame(frame)).toThrow(/exceeds MAX_FRAME_PAYLOAD/);
  });

  test("encoding refuses an oversized payload locally", () => {
    expect(() =>
      encodeFrame({ type: FrameType.STREAM_DATA, payload: new Uint8Array(MAX_FRAME_PAYLOAD + 1) }),
    ).toThrow(/exceeds MAX_FRAME_PAYLOAD/);
  });

  test("encoding refuses an unknown flag bit locally", () => {
    expect(() => encodeFrame({ type: FrameType.PING, flags: 0x8000 })).toThrow(/Unknown flag bits/);
  });
});

describe("structured errors", () => {
  test("round-trip code, scope and detail", () => {
    const decoded = decodeError(
      decodeFrame(
        encodeError({
          code: ErrorCode.CIRCUIT_UNKNOWN,
          scope: ErrorScope.CIRCUIT,
          detail: "no such circuit",
        }),
      ).payload,
    );

    expect(decoded.code).toBe(ErrorCode.CIRCUIT_UNKNOWN);
    expect(decoded.scope).toBe(ErrorScope.CIRCUIT);
    expect(decoded.detail).toBe("no such circuit");
  });

  test("every code is distinct", () => {
    const values = Object.values(ErrorCode);
    expect(new Set(values).size).toBe(values.length);
  });

  test("detail is capped, and cut on a character boundary", () => {
    // Slicing the STRING to a byte budget can straddle a multi-byte character
    // and produce a broken sequence; the cap has to be applied to the bytes.
    const detail = "é".repeat(MAX_ERROR_DETAIL);
    const decoded = decodeError(decodeFrame(encodeError({
      code: ErrorCode.PROTOCOL_VIOLATION,
      scope: ErrorScope.CONNECTION,
      detail,
    })).payload);

    expect(new TextEncoder().encode(decoded.detail).byteLength).toBeLessThanOrEqual(MAX_ERROR_DETAIL);
    expect(decoded.detail).not.toContain("�");
    expect(decoded.detail.startsWith("é")).toBe(true);
  });

  test("a truncated error payload is rejected", () => {
    expect(() => decodeError(new Uint8Array(2))).toThrow(FrameDecodeError);
    // Three bytes is the minimum: code(2) + scope(1), with an empty detail.
    expect(decodeError(new Uint8Array(3)).detail).toBe("");
  });
});

describe("circuit identifiers", () => {
  test("are never the reserved zero", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateCircuitId()).not.toBe(0n);
      expect(generateStreamId()).not.toBe(0);
    }
  });

  test("are not sequential", () => {
    // The whole defect: ids came from a counter starting at 1, so two honest
    // clients collided immediately and a hostile one could guess.
    const ids = Array.from({ length: 50 }, () => generateCircuitId());
    expect(new Set(ids).size).toBe(ids.length);

    const consecutive = ids.slice(1).filter((id, i) => id === ids[i] + 1n).length;
    expect(consecutive).toBe(0);

    // A counter from 1 would put every id in the low range; random 64-bit ids
    // essentially never land there.
    expect(ids.filter((id) => id < 1_000_000n).length).toBe(0);
  });

  test("span the full 64-bit space", () => {
    const ids = Array.from({ length: 100 }, () => generateCircuitId());
    expect(ids.some((id) => id > 0x7fffffffffffffffn)).toBe(true);
  });
});

describe("CircuitTable", () => {
  test("is per connection: the same id in two tables is two circuits", () => {
    // This is the property that makes cross-circuit injection impossible. Two
    // peers may legitimately pick the same number; a global table conflated them.
    const a = new CircuitTable<string>(10);
    const b = new CircuitTable<string>(10);

    expect(a.add(42n, "alice's circuit")).toBe(true);
    expect(b.add(42n, "bob's circuit")).toBe(true);

    expect(a.get(42n)).toBe("alice's circuit");
    expect(b.get(42n)).toBe("bob's circuit");
  });

  test("refuses a duplicate rather than evicting the incumbent", () => {
    // The old relay closed the existing circuit and replaced it, which is how
    // one peer could displace another's.
    const table = new CircuitTable<string>(10);
    expect(table.add(1n, "first")).toBe(true);
    expect(table.add(1n, "second")).toBe(false);
    expect(table.get(1n)).toBe("first");
  });

  test("enforces its capacity", () => {
    const table = new CircuitTable<number>(3);
    expect([1n, 2n, 3n].every((id) => table.add(id, Number(id)))).toBe(true);
    expect(table.add(4n, 4)).toBe(false);
    expect(table.size).toBe(3);
  });

  test("refuses the reserved zero id", () => {
    expect(new CircuitTable<string>(10).add(0n, "control")).toBe(false);
  });

  test("drain empties the table and returns everything, for teardown", () => {
    const table = new CircuitTable<string>(10);
    table.add(1n, "a");
    table.add(2n, "b");
    expect(table.drain().sort()).toEqual(["a", "b"]);
    expect(table.size).toBe(0);
  });
});

describe("flow control", () => {
  test("a sender cannot exceed its window", () => {
    const window = new FlowWindow(100);
    expect(window.consume(60)).toBe(true);
    expect(window.remaining).toBe(40);
    expect(window.consume(50)).toBe(false);
    expect(window.remaining).toBe(40);
  });

  test("credit is granted back as the receiver consumes", () => {
    const window = new FlowWindow(100);
    window.consume(100);
    expect(window.exhausted).toBe(true);
    window.grant(30);
    expect(window.consume(30)).toBe(true);
  });

  test("a grant beyond the initial window is clamped", () => {
    // A peer granting more than it advertised is either buggy or trying to make
    // the sender exceed the bound this exists to enforce.
    const window = new FlowWindow(100);
    window.grant(1_000_000);
    expect(window.remaining).toBe(100);
  });

  test("the circuit window is a real ceiling across its streams", () => {
    // A per-stream window alone lets a peer open many streams to evade the
    // limit. Both windows are debited, so the circuit total holds.
    const circuit = createCircuitWindow(1000);
    const one = new StreamFlow(circuit, 800);
    const two = new StreamFlow(circuit, 800);

    expect(one.consume(800)).toBe(true);
    // 200 left on the circuit, though this stream's own window has 800.
    expect(two.sendable).toBe(200);
    expect(two.consume(800)).toBe(false);
    expect(two.consume(200)).toBe(true);
    expect(circuit.exhausted).toBe(true);
  });

  test("a failed consume debits neither window", () => {
    const circuit = createCircuitWindow(100);
    const flow = new StreamFlow(circuit, 100);
    expect(flow.consume(200)).toBe(false);
    expect(flow.stream.remaining).toBe(100);
    expect(circuit.remaining).toBe(100);
  });

  test("negative amounts are rejected rather than granting credit", () => {
    const window = new FlowWindow(100);
    expect(() => window.consume(-50)).toThrow(RangeError);
    expect(() => window.grant(-50)).toThrow(RangeError);
  });
});

describe("capabilities", () => {
  test("replay protection and flow control are required, not negotiable away", () => {
    // Security capabilities can only be ADDED by negotiation. An attacker must
    // not be able to negotiate replay protection away.
    expect(REQUIRED_CAPABILITIES).toContain(Capability.REPLAY_PROTECTION);
    expect(REQUIRED_CAPABILITIES).toContain(Capability.FLOW_CONTROL);
  });

  test("onion routing is NOT required — it is not implemented", () => {
    expect(REQUIRED_CAPABILITIES).not.toContain(Capability.ONION_ROUTING);
  });
});
