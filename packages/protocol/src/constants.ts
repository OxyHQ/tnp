/**
 * TNP wire protocol v1 — constants and limits.
 *
 * Normative spec: docs/architecture/transport.md.
 *
 * Every limit here is a hard bound, not a hint. The protocol this replaces had
 * a five-byte header, no version, no maximum frame size, no bounded queues and
 * no flow control — so a single client could exhaust a shared relay's memory,
 * and two honest clients collided on circuit IDs immediately (audit S1, S6).
 */

/** Protocol major version. A peer that does not recognise it must not proceed. */
export const PROTOCOL_VERSION = 0x01;

/** Fixed header size: version(1) type(1) flags(2) circuitId(8) streamId(4) length(4). */
export const HEADER_SIZE = 22;

/**
 * Largest payload a single frame may carry.
 *
 * Exceeding it is a protocol violation, not a hint to fragment: a receiver that
 * grows a buffer to whatever a sender declares has no memory bound at all.
 */
export const MAX_FRAME_PAYLOAD = 65535;

export const MAX_FRAME_SIZE = HEADER_SIZE + MAX_FRAME_PAYLOAD;

/** Per-connection and per-circuit resource ceilings. */
export const MAX_STREAMS_PER_CIRCUIT = 256;
export const MAX_CIRCUITS_PER_CONNECTION = 64;
export const MAX_PENDING_OPENS = 32;

/** Credit-based flow control, in bytes. */
export const STREAM_WINDOW_INITIAL = 256 * 1024;
export const CIRCUIT_WINDOW_INITIAL = 1024 * 1024;

/** Timeouts, in milliseconds. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;
export const IDLE_TIMEOUT_MS = 120_000;
export const KEEPALIVE_INTERVAL_MS = 30_000;

/** Handshake nonce length, in bytes. */
export const NONCE_SIZE = 32;

/**
 * Cap on the human-readable part of an ERROR frame.
 *
 * Diagnostic text only. It must never carry a hostname, a user identifier, key
 * material, or anything else the receiving peer was not already entitled to
 * know — an error is not a channel for leaking what a relay can see.
 */
export const MAX_ERROR_DETAIL = 256;

/**
 * Frame types.
 *
 * Grouped by scope: connection control uses circuitId 0 and streamId 0, circuit
 * control uses streamId 0, stream frames use both.
 */
export const FrameType = {
  // Connection control
  HELLO: 0x01,
  HELLO_ACK: 0x02,
  AUTH: 0x03,
  AUTH_OK: 0x04,
  PING: 0x05,
  PONG: 0x06,
  GOAWAY: 0x07,

  // Circuit control
  CIRCUIT_CREATE: 0x10,
  CIRCUIT_CREATED: 0x11,
  CIRCUIT_EXTEND: 0x12,
  CIRCUIT_EXTENDED: 0x13,
  CIRCUIT_DESTROY: 0x14,
  CIRCUIT_PADDING: 0x15,

  // Stream
  STREAM_OPEN: 0x20,
  STREAM_OPENED: 0x21,
  STREAM_DATA: 0x22,
  STREAM_WINDOW: 0x23,
  STREAM_CLOSE: 0x24,
  STREAM_RESET: 0x25,

  // Error
  ERROR: 0x30,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

const FRAME_TYPE_VALUES: ReadonlySet<number> = new Set(Object.values(FrameType));

export function isFrameType(value: number): value is FrameTypeValue {
  return FRAME_TYPE_VALUES.has(value);
}

/** Reverse lookup, for diagnostics. Never used for control flow. */
export const FRAME_TYPE_NAMES: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(FrameType).map(([name, value]) => [value, name])),
);

/**
 * Flag bits.
 *
 * Unknown bits must be zero on send and are REJECTED on receive: a peer that
 * ignores a flag it does not understand cannot tell a future extension from a
 * corrupted frame, and silently misreads the second as the first.
 */
export const Flags = {
  /** STREAM_CLOSE: this side is done sending. Half-close, not teardown. */
  CLOSE_WRITE: 0x0001,
  /** STREAM_CLOSE: this side is done receiving. */
  CLOSE_READ: 0x0002,
} as const;

/** Every flag bit defined in v1. Anything outside this mask is a violation. */
export const KNOWN_FLAGS = Flags.CLOSE_WRITE | Flags.CLOSE_READ;

/**
 * Structured error codes.
 *
 * Peers branch on the code. The accompanying text is for a human reading a log.
 */
export const ErrorCode = {
  PROTOCOL_VIOLATION: 0x0001,
  UNSUPPORTED_VERSION: 0x0002,
  UNSUPPORTED_CAPABILITY: 0x0003,

  AUTH_REQUIRED: 0x0010,
  AUTH_FAILED: 0x0011,
  AUTH_EXPIRED: 0x0012,
  REVOKED: 0x0013,

  CIRCUIT_UNKNOWN: 0x0020,
  CIRCUIT_LIMIT: 0x0021,
  CIRCUIT_REJECTED: 0x0022,

  STREAM_UNKNOWN: 0x0030,
  STREAM_LIMIT: 0x0031,
  STREAM_REFUSED: 0x0032,

  FLOW_CONTROL: 0x0040,
  RATE_LIMIT: 0x0041,
  RESOURCE_EXHAUSTED: 0x0042,

  TARGET_UNREACHABLE: 0x0050,
  TARGET_REFUSED: 0x0051,

  REPLAY_DETECTED: 0x0060,
  DOWNGRADE_DETECTED: 0x0061,
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_CODE_NAMES: Readonly<Record<number, string>> = Object.freeze(
  Object.fromEntries(Object.entries(ErrorCode).map(([name, value]) => [value, name])),
);

/** Scope an error applies to, so a peer knows what to tear down. */
export const ErrorScope = {
  CONNECTION: 0x01,
  CIRCUIT: 0x02,
  STREAM: 0x03,
} as const;

export type ErrorScopeValue = (typeof ErrorScope)[keyof typeof ErrorScope];

/**
 * Named, individually gated capabilities.
 *
 * Security capabilities can only be ADDED by negotiation, never removed — an
 * attacker must not be able to negotiate away replay protection.
 */
export const Capability = {
  /** Per-direction monotonic counters inside the AEAD envelope. */
  REPLAY_PROTECTION: "replay-protection",
  /** Credit-based flow control at stream and circuit level. */
  FLOW_CONTROL: "flow-control",
  /** Incremental multi-hop circuit construction (Phase 6). */
  ONION_ROUTING: "onion-routing",
  /** Circuit resumption across a reconnect. */
  RESUMPTION: "resumption",
} as const;

export type CapabilityValue = (typeof Capability)[keyof typeof Capability];

/**
 * Capabilities a v1 peer must support. Absence is fatal, not degrading:
 * a peer lacking one is refused rather than served a weaker path.
 */
export const REQUIRED_CAPABILITIES: readonly CapabilityValue[] = [
  Capability.REPLAY_PROTECTION,
  Capability.FLOW_CONTROL,
];
