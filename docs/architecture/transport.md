# Transport — TNP wire protocol v1

**Status: specification. Not implemented.** The code today speaks an unversioned
5-byte-header protocol (`packages/protocol/src/frames.ts`) with none of the
properties below. This document defines what replaces it in Phase 3, as a clean
cut across the client, relay and service node together.

---

## 1. Design constraints

1. **Versioned from the first byte.** A peer must be able to reject an
   incompatible peer before parsing anything else.
2. **Transport-agnostic.** The protocol is defined over an abstract reliable,
   ordered, message-oriented channel. WebSocket-over-TLS is the first binding
   because it traverses NAT and corporate middleboxes today — it is not the
   protocol. QUIC and WebTransport bindings must not require a protocol change.
3. **Bounded everywhere.** Every length has a maximum. Every queue has a
   capacity. There is no unbounded buffer anywhere in a conforming
   implementation.
4. **Structured errors.** Codes, not free-form strings. A string in an error
   frame is a debugging hint, never the thing the peer branches on.
5. **Onion-ready.** Circuit and stream identifiers, layered encryption and
   incremental circuit extension are in v1's frame space even though the
   multi-hop path lands in Phase 6. Retrofitting them later means a second
   breaking change.

## 2. Transport abstraction

```ts
interface TnpTransport {
  readonly kind: "websocket-tls" | "tcp-tls" | "quic" | "webtransport";
  send(message: Uint8Array): Promise<void>;   // rejects when the peer is backed up
  receive(): AsyncIterable<Uint8Array>;       // one message per frame
  close(code: number, reason?: string): Promise<void>;
  readonly bufferedBytes: number;             // for backpressure decisions
}
```

Everything above this interface is portable. Only the binding below it is
platform- or runtime-specific.

## 3. Frame format

All integers big-endian. Frames are carried one per transport message.

```
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|  version (8)  |   type (8)    |          flags (16)           |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        circuitId (64)                         |
|                                                               |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                        streamId (32)                          |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                     payloadLength (32)                        |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
|                     payload (payloadLength)                   |
+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
```

Header is 22 bytes fixed.

| Field | Size | Notes |
|---|---|---|
| `version` | 1 | `0x01` for v1. A peer that does not recognise it closes with `UNSUPPORTED_VERSION` and sends nothing else. |
| `type` | 1 | §4 |
| `flags` | 2 | Type-specific. Unknown bits must be zero on send and **rejected** on receive, so a future flag cannot be silently ignored by an old peer. |
| `circuitId` | 8 | **Connection-scoped**, generated from a CSPRNG by the side that initiates. Never a counter, never global. This is the fix for audit finding S1. |
| `streamId` | 4 | Scoped to its circuit. `0` = circuit-level control. |
| `payloadLength` | 4 | Bounded by `MAX_FRAME_PAYLOAD`. |

### Hard limits

| Limit | Value | Rationale |
|---|---|---|
| `MAX_FRAME_PAYLOAD` | 65535 B | Exceeding it is a protocol violation, not a fragmentation hint. |
| `MAX_STREAMS_PER_CIRCUIT` | 256 | |
| `MAX_CIRCUITS_PER_CONNECTION` | 64 | |
| `MAX_PENDING_OPENS` | 32 | |
| `STREAM_WINDOW_INITIAL` | 256 KiB | |
| `CIRCUIT_WINDOW_INITIAL` | 1 MiB | |
| `HANDSHAKE_TIMEOUT` | 10 s | |
| `IDLE_TIMEOUT` | 120 s | Keepalive at 30 s. |

A peer that exceeds any limit is closed with the matching error code. Limits are
constants in the protocol package, shared by every implementation — never
per-application values.

## 4. Frame types

### Connection control (`circuitId = 0`, `streamId = 0`)

| Type | Name | Direction | Purpose |
|---|---|---|---|
| `0x01` | `HELLO` | initiator → responder | Version, capability set, node identity, nonce |
| `0x02` | `HELLO_ACK` | responder → initiator | Selected version, capabilities, identity, signature over both nonces |
| `0x03` | `AUTH` | either | Proof of node key possession |
| `0x04` | `AUTH_OK` | either | Accepted |
| `0x05` | `PING` | either | Keepalive; echoed as `PONG` |
| `0x06` | `PONG` | either | |
| `0x07` | `GOAWAY` | either | Graceful shutdown with a last-accepted circuit ID |

### Circuit control (`streamId = 0`)

| Type | Name | Purpose |
|---|---|---|
| `0x10` | `CIRCUIT_CREATE` | Create a circuit to the next hop, carrying the initiator's ephemeral key |
| `0x11` | `CIRCUIT_CREATED` | Accepted, with the responder's ephemeral key and a key-confirmation tag |
| `0x12` | `CIRCUIT_EXTEND` | Extend an existing circuit one hop further (Phase 6) |
| `0x13` | `CIRCUIT_EXTENDED` | |
| `0x14` | `CIRCUIT_DESTROY` | Tear down, with a reason code |
| `0x15` | `CIRCUIT_PADDING` | Cover traffic (Phase 6). Payload is discarded. |

### Stream

| Type | Name | Purpose |
|---|---|---|
| `0x20` | `STREAM_OPEN` | Open a stream to a target (TNP domain, or host:port at an exit) |
| `0x21` | `STREAM_OPENED` | Accepted |
| `0x22` | `STREAM_DATA` | Payload |
| `0x23` | `STREAM_WINDOW` | Flow-control credit |
| `0x24` | `STREAM_CLOSE` | Half-close in one direction — `flags` bit 0 says which |
| `0x25` | `STREAM_RESET` | Abort with an error code |

### Error

| Type | Name | Purpose |
|---|---|---|
| `0x30` | `ERROR` | Structured error: `{ code: u16, scope: u8, detail: utf8[] }` |

`detail` is diagnostic text with a 256-byte cap. It must never contain a
hostname, a user identifier, key material, or anything else the receiving peer
was not already entitled to know.

## 5. Error codes

| Code | Name | Meaning |
|---|---|---|
| `0x0001` | `PROTOCOL_VIOLATION` | Malformed frame, unknown flag bit, limit exceeded |
| `0x0002` | `UNSUPPORTED_VERSION` | No shared version |
| `0x0003` | `UNSUPPORTED_CAPABILITY` | A required capability is absent |
| `0x0010` | `AUTH_REQUIRED` | |
| `0x0011` | `AUTH_FAILED` | Signature or identity check failed |
| `0x0012` | `AUTH_EXPIRED` | Credential expired mid-connection |
| `0x0013` | `REVOKED` | The presented key is revoked |
| `0x0020` | `CIRCUIT_UNKNOWN` | |
| `0x0021` | `CIRCUIT_LIMIT` | |
| `0x0022` | `CIRCUIT_REJECTED` | Policy refusal |
| `0x0030` | `STREAM_UNKNOWN` | |
| `0x0031` | `STREAM_LIMIT` | |
| `0x0032` | `STREAM_REFUSED` | Exit policy or destination refusal |
| `0x0040` | `FLOW_CONTROL` | Window violated |
| `0x0041` | `RATE_LIMIT` | |
| `0x0042` | `RESOURCE_EXHAUSTED` | |
| `0x0050` | `TARGET_UNREACHABLE` | |
| `0x0051` | `TARGET_REFUSED` | |
| `0x0060` | `REPLAY_DETECTED` | |
| `0x0061` | `DOWNGRADE_DETECTED` | |

## 6. Connection handshake

```
initiator                                     responder
    │                                              │
    │──── HELLO {ver, caps, nodeId, nonceI} ──────▶│
    │                                              │
    │◀─── HELLO_ACK {ver, caps, nodeId,            │
    │       nonceR, sig(transcript)} ──────────────│
    │                                              │
    │──── AUTH {sig(transcript)} ─────────────────▶│
    │                                              │
    │◀─── AUTH_OK ─────────────────────────────────│
```

- `transcript` is the canonical concatenation of every handshake byte seen so
  far, both nonces included. Signing the transcript rather than a nonce is what
  makes a downgrade detectable: an attacker who strips a capability from `HELLO`
  changes the transcript and the signature no longer verifies.
- The version and capability set are **frozen** at `HELLO_ACK`. A later frame
  implying a different version is `DOWNGRADE_DETECTED`.
- Both nonces are 32 CSPRNG bytes. A repeated nonce from a peer is
  `REPLAY_DETECTED`.
- No frame other than `HELLO`/`HELLO_ACK`/`AUTH`/`AUTH_OK`/`ERROR` is processed
  before `AUTH_OK`. This is what closes audit finding S2 — a relay currently
  accepts an unauthenticated socket that claims any domain.

## 7. Flow control

Credit-based, at two levels, because one level is not enough: a per-stream window
alone lets a peer open many streams to evade the limit, and a per-circuit window
alone lets one stream starve the others.

- Receiver advertises an initial window; sender may have at most that many
  unacknowledged payload bytes outstanding.
- `STREAM_WINDOW` grants more credit as the receiver consumes.
- Sending past the window is `FLOW_CONTROL` and closes the circuit.
- The local socket pump **pauses** when the window is exhausted or when
  `transport.bufferedBytes` exceeds the high-water mark, and resumes on drain.
  Today neither pump ever pauses (audit S6).

## 8. Reconnection and migration

- **Connection loss** does not by itself destroy circuits. A circuit may be
  resumed on a new connection to the same relay within a resumption window, using
  a resumption token bound to the circuit's key material.
- **Resumption is refused** when it cannot be made replay-safe. A refused
  resumption is a clean rebuild, not a silent downgrade.
- **Network migration** (Wi-Fi ↔ cellular) is a reconnect plus a resume. Whether
  a migration is safe is decided by the security layer, not by the transport.
- Reconnect uses exponential backoff with jitter and a cap. Thundering-herd
  reconnects after a relay restart are a self-inflicted denial of service.

## 9. Cryptographic binding

Frame confidentiality and integrity are the security layer's job
([`security.md`](./security.md)). The transport guarantees only:

- Every frame carrying a payload is authenticated; a failed authentication is a
  circuit-level error, never a silently dropped frame.
- Each hop has independent key material.
- Frames carry a per-direction monotonic counter inside the authenticated
  envelope, so a replayed frame is detected and answered with `REPLAY_DETECTED`.
  The protocol today has no counter and no replay defence at all.

## 10. Compatibility

- **Major version** (`version` byte): incompatible. No negotiation, no fallback,
  no shim. Peers that do not share a major version do not talk.
- **Capabilities**: additive, negotiated in the handshake, each named and
  independently gated.
- A capability may be **required**; a peer lacking a required capability is
  refused with `UNSUPPORTED_CAPABILITY` rather than served a degraded path.
- **Security capabilities can only be added, never removed by negotiation.** An
  attacker must not be able to negotiate away replay protection.
