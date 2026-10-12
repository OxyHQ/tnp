# Transport — TNP wire protocol v1

**Status: specification; library implemented, not deployed.** The code today
speaks an unversioned 5-byte-header protocol (`packages/protocol/src/frames.ts`)
with none of the properties below. This document defines what replaces it in
Phase 3, as a clean cut across the client, relay and service node together.
The frame codec, limits, flow-control windows and the end-to-end session
cryptography (§9) exist as a library under `@tnp/protocol/v1`, with the key
material it trusts in `@tnp/crypto`; **no component uses them yet**. The
connection handshake (§6) and resumption (§8) are not implemented at all.

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

Header is **20 bytes** fixed — exactly the sum of its fields, with no padding
and no reserved bytes. (An earlier draft said 22 and never wrote or checked the
last two: an unauthenticated 16-bit field in every frame that any relay could
set freely, which is a ready-made channel for tagging a circuit's frames so a
colluding hop recognises them. A future field arrives with a new major version,
not in a gap.)

| Field | Size | Notes |
|---|---|---|
| `version` | 1 | `0x01` for v1. A peer that does not recognise it closes with `UNSUPPORTED_VERSION` and sends nothing else. |
| `type` | 1 | §4 |
| `flags` | 2 | Type-specific, checked against the mask for the frame's own type (only `STREAM_CLOSE` defines flags in v1: `CLOSE_WRITE` 0x0001, `CLOSE_READ` 0x0002; every other type carries none). Any other bit must be zero on send and is **rejected** on receive, so a future flag cannot be silently ignored by an old peer, and a flag cannot appear on a type it means nothing for. |
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
| `0x10` | `CIRCUIT_CREATE` | Create a circuit; carries handshake message 1 (the initiator's ephemeral key, §9.2) |
| `0x11` | `CIRCUIT_CREATED` | Accepted; carries handshake message 2 (the responder's ephemeral key and key-confirmation tag, §9.2) |
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

`detail` is diagnostic text with a 256-byte cap, enforced on decode as well as
encode — an ERROR payload longer than 3 + 256 bytes is a `PROTOCOL_VIOLATION`.
`detail` must never contain a hostname, a user identifier, key material, or
anything else the receiving peer was not already entitled to know.

The encoder refuses an unknown frame type, an unknown flag bit or an
out-of-range field locally, before anything is sent.

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
| `0x0060` | `REPLAY_DETECTED` | A sealed record's counter was already used (§9.3) |
| `0x0061` | `DOWNGRADE_DETECTED` | |
| `0x0062` | `DECRYPT_FAILED` | A sealed record's AEAD tag did not verify: tampering, reflection, or the wrong key (§9.3) |
| `0x0063` | `TRUNCATED` | The circuit ended without the peer's authenticated close (§9.4) |

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
- Credit amounts are integers in [0, 2³² − 1] (`MAX_WINDOW_CREDIT`), and a
  window never exceeds its initial size: a grant beyond it is clamped. `FlowWindow`
  and `StreamFlow` throw on any other value — `NaN`, negative, fractional,
  infinite or out of range — rather than entering a state where the window no
  longer limits anything (`grant(NaN)` used to do exactly that).
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

## 9. Session cryptography

**Status: implemented as a library — `ClientHandshake`, `ServerHandshake` and
`SessionCipher` in `@tnp/protocol/v1` (`src/noise.ts`, `src/session.ts`). No
component uses it yet; the protocol in use today has no session crypto, no
counter and no replay defence at all.**

This section is the end-to-end layer between a client and a service node,
through a relay that is assumed hostile: it carries every byte and is trusted
for none of them. Per-hop layers for multi-hop circuits are Phase 6
([`onion-routing.md`](./onion-routing.md)); they will reuse this handshake with
the `relay` key role.

Primitives are those of [`security.md`](./security.md) §3: X25519 (tweetnacl),
ChaCha20-Poly1305 and HKDF-SHA256 / SHA-256 (`@noble/ciphers` 1.3.0 and
`@noble/hashes` 1.8.0, pinned exactly), all behind `@tnp/crypto/primitives`.

### 9.1 Which key the client trusts

The service node holds a static X25519 key, certified by a **key-agreement
certificate** signed by its node key ([`security.md`](./security.md) §1). The
client verifies the certificate and the grant chain behind it with
`verifyKeyAgreementCertificate(cert, chain, { role: 'service-node', name,
trustedRoots, now, revoked?, knownSerials? })`. `ClientHandshake` accepts only
the `VerifiedKeyAgreementKey` that call returns — checked at run time, so a
look-alike object with the right fields is refused (`AUTH_FAILED`) — and
refuses it again if `name` differs from the certified scope (`AUTH_FAILED`) or
the certificate has expired by `now` (`AUTH_EXPIRED`).

How the client obtains the certificate and chain (inside the domain's signed
record set, [`naming.md`](./naming.md) §5) is **not yet specified**; it is a
precondition of the Phase 3 cutover, not of this library.

### 9.2 Handshake: `Noise_NK_25519_ChaChaPoly_SHA256`

The handshake is Noise pattern NK, exactly as in The Noise Protocol Framework
revision 34, with no TNP modification to the Noise processing rules. The
implementation is checked byte for byte against the published cacophony test
vector for this protocol name.

```
NK:
  <- s                 the client already knows the service node's static key
  ...
  -> e, es             message 1: client ephemeral; DH(e_c, s)
  <- e, ee             message 2: service ephemeral; DH(e_c, e_s)
```

Why NK: the client has **no static key** and can stay anonymous to the service
node; the service node is authenticated by `es` (only the holder of the
certified static secret can read message 1 and therefore derive the keys that
authenticate message 2 — that tag is the **key confirmation**); and `ee` gives
**forward secrecy** (the session keys depend on two ephemerals, so a static key
stolen later decrypts nothing recorded earlier). A relay that answers with
its own keys fails key confirmation; it never learns the client's ephemeral
secret, so it cannot complete either half.

**Prologue** (mixed into the transcript before anything else; both sides must
compute identical bytes or the handshake fails):

```
u32 len ‖ "tnp-session-v1"
u8       PROTOCOL_VERSION (0x01)
u32 len ‖ role             ("service-node")
u32 len ‖ name             (the exact name being connected to, e.g. "example.ox")
```

The transcript hash therefore binds the Noise protocol name (no suite
negotiation exists to downgrade), the protocol version, the key role, the
destination name, the service node's static key, both ephemerals and both
tags. A relay that routes a client's handshake to another name, or presents
another role's key, produces a failed handshake — never a weaker session.

**Messages.** Both payloads are empty, so each message is exactly
`HANDSHAKE_MESSAGE_SIZE` = 48 bytes (ephemeral 32 + tag 16); any other length
is `PROTOCOL_VIOLATION`. Message 1 is the `CIRCUIT_CREATE` payload, message 2
the `CIRCUIT_CREATED` payload. Data is never carried in message 1: it would be
replayable and encrypted only to the static key, so not forward-secret.

| Failure | Who detects it | Code |
|---|---|---|
| Message 1 not encrypted to this static key, name, role or version | service node | `AUTH_FAILED` |
| Message 2 tag does not verify (responder lacks the certified key) | client | `AUTH_FAILED` |
| A peer ephemeral that is non-canonical (u ≥ 2²⁵⁵ − 19 or top bit set) or of small order (all-zero DH output) | either | `PROTOCOL_VIOLATION` |
| Wrong message length; handshake object reused | either | `PROTOCOL_VIOLATION` |

Every DH output is checked to be non-zero, which rejects all small-order
points including the all-zero key (tweetnacl alone computes with them and
yields an all-zero, attacker-known secret). Certified static keys are checked
for small order when they are certified.

**Outputs.** Noise `Split()` yields two independent keys — client→service and
service→client — so neither side ever decrypts with the key it encrypts with.
The final handshake hash is exposed as `SessionCipher.handshakeHash`, a public
value unique to the session, for channel binding by application-layer
authentication run inside it.

A replayed message 1 makes the service node derive a session nobody can use
(the replayer lacks the client's ephemeral secret); its cost is one DH, bounded
by the relay's handshake rate limit ([`security.md`](./security.md) §9).
`HANDSHAKE_TIMEOUT` applies to the exchange.

### 9.3 Sealed records

After the handshake each direction has a key `k` and a counter starting at 0.
A **sealed record** — the payload of the frame that carries it — is:

```
counter (u64, big-endian)
‖ ChaCha20-Poly1305( k, nonce = 0x00000000 ‖ counter (u64, little-endian),
                     AD,
                     record type (u8) ‖ body )
```

The nonce encoding is Noise's (§12.3 of the framework). Overhead is
`SEALED_RECORD_OVERHEAD` = 25 bytes, so the largest body is
`MAX_SEALED_PLAINTEXT` = 65510 and the largest record is exactly
`MAX_FRAME_PAYLOAD`: a sealed record always fits one frame.

| Record type | Name | Body |
|---|---|---|
| `0x00` | `DATA` | Application bytes |
| `0x01` | `CLOSE` | Empty. Authenticated half-close (§9.4) |
| `0x02` | `KEY_UPDATE` | Empty. Rekey (§9.5) |

The type is inside the encryption, so a relay cannot tell a close from an
empty data record.

**Associated data** is `frameAssociatedData(type, flags, streamId)` of the
frame carrying the record: `version (u8) ‖ type (u8) ‖ flags (u16) ‖ streamId
(u32)`, big-endian — the header minus `circuitId`, which is connection-scoped
and legitimately differs on each side of a relay, and minus `payloadLength`,
which the record implies. So a relay cannot move a record to another stream,
turn `STREAM_DATA` into `STREAM_CLOSE`, or flip a half-close flag. The binding
is not optional: `seal`, `close`, `updateKey` and `open` each take the frame
header (`{ type, flags, streamId }` — a decoded `Frame` qualifies) and compute
this AD themselves, so there is no call that produces an unbound record.
**Which frame
types carry sealed records end to end, and whether stream control
(`STREAM_OPEN` and its target) travels inside them, is decided by the Phase 3
cutover and is not yet specified.**

**Receiving** is strictly in order. A record is accepted only if every check
passes, in this order:

1. The session has not failed, and the peer has not already sent `CLOSE`
   (`PROTOCOL_VIOLATION`).
2. `25 ≤ length ≤ MAX_FRAME_PAYLOAD` (`PROTOCOL_VIOLATION`).
3. `counter` equals the expected counter. Below it: `REPLAY_DETECTED`. Above
   it — a dropped or reordered record: `PROTOCOL_VIOLATION`.
4. The AEAD tag verifies under this direction's key (`DECRYPT_FAILED`). A
   record reflected back to its sender fails here, because the two directions
   have different keys.
5. The type is known; a `CLOSE` or `KEY_UPDATE` has an empty body; a `DATA`
   record is not in the reserved last slot (§9.5) (`PROTOCOL_VIOLATION`).

Any failure **kills the session in both directions** and wipes its keys; there
is no skipping a bad record. The side that detects it destroys the circuit with
the code above. This is what the `replay-protection` capability (§10) means.

### 9.4 Authenticated close and truncation

`CLOSE` is a half-close: after sending it a side seals nothing more; after
receiving it a side accepts nothing more in that direction, while the other
direction keeps working. When the transport or circuit ends, the receiver calls
`transportEnded()`, which fails with `TRUNCATED` unless the peer's `CLOSE` was
received — otherwise a relay that cuts a stream after a partial response is
indistinguishable from the service finishing.

### 9.5 Record limits and key update

- `MAX_RECORDS_PER_KEY` = 2³² records per direction per key. The last counter
  value is reserved for `KEY_UPDATE` or `CLOSE`; sealing `DATA` there throws
  `RekeyRequiredError` locally, and a receiver refuses `DATA` there
  (`PROTOCOL_VIOLATION`). Counters therefore never approach 2⁶⁴ − 1, the nonce
  Noise reserves for rekeying.
- `KEY_UPDATE_INTERVAL` = 2²⁴ records: after that many, `needsKeyUpdate` is true
  and the sender should send `KEY_UPDATE`.
- Both limits are protocol constants. A handshake's optional `limits` may only
  **lower** them (tests use this); a value above either constant is refused.
- `KEY_UPDATE` is sealed under the current key. Then, for that direction only,
  both sides set `k ← REKEY(k)` — Noise's rekey, the first 32 bytes of
  `ENCRYPT(k, 2⁶⁴ − 1, ε, 0³²)` — and reset the counter to 0. The old key is
  wiped. `REKEY` is one-way, so a key captured now does not decrypt records
  sent before the last update.

### 9.6 What this does not do

- **No metadata protection.** The relay sees timing, sizes and which service a
  client reaches ([`threat-model.md`](./threat-model.md) §2).
- **No client authentication.** NK leaves the client anonymous to the service
  node; a service that needs client identity authenticates it inside the
  session, bound to `handshakeHash`.
- **No 0-RTT data and no resumption.** §8's resumption tokens are unspecified.
- **Single layer.** One relay between client and service node; multi-hop
  layering is Phase 6.

## 10. Compatibility

- **Major version** (`version` byte): incompatible. No negotiation, no fallback,
  no shim. Peers that do not share a major version do not talk.
- **Capabilities**: additive, negotiated in the handshake, each named and
  independently gated.
- A capability may be **required**; a peer lacking a required capability is
  refused with `UNSUPPORTED_CAPABILITY` rather than served a degraded path.
- **Security capabilities can only be added, never removed by negotiation.** An
  attacker must not be able to negotiate away replay protection.
