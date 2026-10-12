# Transport — TNP wire protocol v1

**Status: implemented for the single-hop overlay (Phase 3); not deployed.**
The client (`packages/client/src/tunnel.ts`, `socks.ts`), the service node
(`service-node.ts`), the standalone relay (`apps/relay`) and the relay in the
`tnp` binary (`relay-node.ts`) all speak v1 and nothing else, through one relay
implementation, `@tnp/relay-core`. The unversioned five-byte v0 codec was
deleted, not deprecated: a v1 peer refuses a v0 peer at the version byte. What
is implemented: the frame codec and limits (§3–§5), service-node
authentication to a relay (§6, partially), end-to-end flow control (§7, §11),
the session cryptography (§9) and the overlay framing (§11). Not implemented:
the mutual, transcript-signed connection handshake of §6, relay authentication
to clients (it needs the signed directory, Phase 5), capability negotiation
(§10) and resumption (§8). The relay remains parked
([`relays.md`](./relays.md) §8).

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
| `0x0014` | `ALREADY_REGISTERED` | A relay already serves this name from a different authenticated node key; the incumbent stays (§6) |
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
  before `AUTH_OK`. This is what closes audit finding S2 — the prototype relay
  accepted an unauthenticated socket that claimed any domain.

### 6.1 What is implemented: service-node authentication

The full handshake above — both sides with node identities, a signed
transcript, frozen capabilities — is **not implemented**: authenticating the
relay to its peers needs a key the peer can check, which is the signed
directory (Phase 5). What runs today is the half that closes S2, on the
relay's `/service` endpoint (`packages/relay-core/src/core.ts`):

```
service node                                   relay
    │◀─── HELLO {challenge: 32 CSPRNG bytes} ──────│   sent on connect
    │──── AUTH {name, chain, signature} ──────────▶│   JSON, strict fields
    │◀─── AUTH_OK ─────────────────────────────────│   or ERROR, then close
```

- `signature` is the node key's Ed25519 signature over
  `u32 len ‖ "tnp-relay-service-auth-v1" ‖ u32 len ‖ name ‖ u32 len ‖ relay
  endpoint ‖ challenge (32) ‖ node key (32)` (`@tnp/crypto`
  `signServiceAuth`). The endpoint is the normalized URL the node dialed and
  must equal the relay's configured public endpoint, so a hostile relay cannot
  relay its challenge from another relay; the challenge makes a recorded proof
  useless.
- `chain` must verify with `verifyChain` to the **domain key** the registry
  publishes for `name` (`GET /domain-keys/:name`), with the `service-node`
  purpose and a leaf scoped to exactly `name`, and its leaf subject must be the
  key that signed. No registered key, a registry error, a bad chain or a bad
  signature: `ERROR` (`AUTH_FAILED`, `AUTH_EXPIRED` or `REVOKED`) and close.
- Nothing but `AUTH` is processed before `AUTH_OK` (`AUTH_REQUIRED`), and a
  node that has not authenticated within `HANDSHAKE_TIMEOUT` (10 s) is closed.
- A second node for a name with a **different** node key is refused with
  `ALREADY_REGISTERED`; the incumbent is not evicted. The **same** node key
  reconnecting replaces its own older connection (only the holder of that key
  can do this).
- The relay re-reads the domain key every 10 minutes and drops a node whose
  name's key has changed (`REVOKED`), and drops it when its grant expires
  (`AUTH_EXPIRED`).

Clients connecting to `/tunnel` do not authenticate: there is no client
identity and no client handshake. They are rate-limited per address instead
([`relays.md`](./relays.md) §3).

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

**Implemented (§11):** one level only, per circuit, end to end, because a
circuit carries exactly one stream. Both pumps — the SOCKS side and the
service node's target side (`packages/client/src/overlay/pipe.ts`) — pause
when credit runs out or the WebSocket's buffered amount exceeds 1 MiB, and
resume below 256 KiB or on new credit. Credit is returned only once the local
socket has flushed the bytes.

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

**Status:** resumption and migration are **not implemented**; a lost
connection ends its circuits (the applications see a reset). The service node
reconnects with exponential backoff (2 s doubling to 60 s) and ±50% jitter.

## 9. Session cryptography

**Status: implemented and in use — `ClientHandshake`, `ServerHandshake` and
`SessionCipher` in `@tnp/protocol/v1` (`src/noise.ts`, `src/session.ts`), run
by the client and the service node for every circuit (§11).**

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

**Where the certificate and chain come from.** The `/dns/resolve` response for
a name with an online service node carries an `overlay` block: `{ relay,
available, domainKey, rotations, chain, kaCert }` (`DnsResolveOverlay` in
`@tnp/shared-types`). The service node publishes `chain` and `kaCert` with
`POST /nodes/register`, and the registry verifies them against the domain key
before storing them — but the client trusts none of it
(`packages/client/src/overlay/verify.ts`):

1. It derives the service name itself from what it was asked to reach — the
   last two labels (`www.example.ox` → `example.ox`) — and never takes a name
   from the response, so a valid chain for `attacker.ox` cannot answer for
   `victim.ox`.
2. `domainKey` must equal the client's **pin** for that name, or be reached
   from the pin through `rotations` each signed by the key it retires. A name
   with no pin is pinned on its first successful verification (trust on first
   use). A different key without such a path is refused, fail-closed, with a
   message naming the risk.
3. `kaCert` and `chain` are verified as above with `trustedRoots: [domainKey]`
   and the pin's rollback high-water marks as `knownSerials`.

Pinning is specified in [`security.md`](./security.md) §1 ("Domain keys and
pinning"). The signed record set of [`naming.md`](./naming.md) §5 does not
exist yet; until it does, the overlay block is the only path.

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
**Every end-to-end record travels in a `STREAM_DATA` frame on stream
`E2E_STREAM_ID` (1) with flags 0, and stream control — the target port, the
open/opened exchange, credit, resets and the half-close — travels inside the
records (§11).** A relay therefore sees one frame type for everything a
circuit's two ends say to each other.

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
- **Half-close is not `CLOSE`.** The overlay half-closes with a sealed `FIN`
  message and sends the session `CLOSE` only once both sides have sent `FIN`
  (§11.4).
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

## 11. Single-hop overlay (Phase 3)

How a client reaches a service node through one relay with everything above.
Code: `@tnp/protocol/v1` (`src/overlay.ts`), `@tnp/relay-core`,
`packages/client/src/{tunnel,service-node,socks}.ts` and
`packages/client/src/overlay/`.

### 11.1 Circuits

A circuit carries exactly **one stream**: one SOCKS connection is one circuit.
A client connection to a relay holds at most `MAX_CIRCUITS_PER_CONNECTION` (64)
circuits and `MAX_PENDING_OPENS` (32) unanswered ones; the client opens up to 8
connections per relay, so at most 512 concurrent streams per relay.

```
client                       relay                         service node
  │ CIRCUIT_CREATE(c)          │                                │
  │  {name, Noise msg1} ──────▶│ CIRCUIT_CREATE(s) {same payload}│
  │                            │───────────────────────────────▶│ ServerHandshake
  │                            │ CIRCUIT_CREATED(s) {msg2}       │
  │ CIRCUIT_CREATED(c) {msg2} ◀│◀───────────────────────────────│
  │ STREAM_DATA(c, 1) sealed ─▶│ STREAM_DATA(s, 1) sealed ─────▶│
```

- **Circuit ids are connection-scoped and CSPRNG-chosen.** The client picks
  `c` (64-bit, `generateCircuitId`) on its connection; the relay picks its own
  `s` on the service node's connection. Each connection has its own
  `CircuitTable`; a frame is looked up only in the table of the connection it
  arrived on, so a frame naming another connection's circuit reaches nothing
  and is dropped, never forwarded. Data or destroy frames for an unknown
  circuit are dropped without penalty (frames in flight when the other side
  tears a circuit down arrive like this on honest connections); frame types a
  peer may not send at all are counted, and past 64 the connection is closed.
  A colliding `CIRCUIT_CREATE` id is refused, never evicts (S1).
- **`CIRCUIT_CREATE` payload** = `u8 nameLength ‖ name ‖ Noise message 1 (48)`.
  `name` is a canonical lowercase name of 1–253 bytes. This routing prefix is
  the only cleartext the relay reads from a client; it needs the name to pick
  the service node. A payload whose length does not match exactly — including
  the old v0 `domain\0base64key` — is refused for that circuit with
  `CIRCUIT_DESTROY(PROTOCOL_VIOLATION)`.
- **`CIRCUIT_CREATED`** (exactly 48 bytes, Noise message 2) comes only from the
  service node; the relay never synthesizes it. A relay that answers on its own
  cannot produce message 2's tag, and the client fails key confirmation
  (`AUTH_FAILED`).
- The service node checks that `name` is the name it serves and runs the NK
  responder against each of its still-certified X25519 keys, newest first (at
  most two during a certificate rotation). A message 1 that no key accepts is
  answered with `CIRCUIT_DESTROY`.
- A circuit not answered within `HANDSHAKE_TIMEOUT` (10 s) is destroyed by the
  relay (`TARGET_UNREACHABLE`). `STREAM_DATA` from a client before
  `CIRCUIT_CREATED` destroys the circuit (`PROTOCOL_VIOLATION`).
- The relay forwards a frame by rewriting only its circuit id.

### 11.2 Stream messages

After the handshake every frame either end sends is a `STREAM_DATA` frame on
stream 1, flags 0, whose payload is one sealed record (§9.3). The plaintext of
each sealed `DATA` record is one stream message, each with an exact length:

| Type | Name | Body | Direction, rule |
|---|---|---|---|
| `0x01` | `OPEN` | u16 port (≠ 0) | client → node, first message only |
| `0x02` | `OPENED` | — | node → client, first message only |
| `0x03` | `DATA` | 1 … 65509 bytes | both; the node sends none before `OPENED` |
| `0x04` | `RESET` | u16 error code | either; aborts the stream |
| `0x05` | `WINDOW` | u32 credit (≠ 0) | both |
| `0x06` | `FIN` | — | either; no more `DATA` from the sender |

Any other type or length, a second `OPEN`/`OPENED`, `DATA` before the first
message or after `FIN` is `PROTOCOL_VIOLATION` and kills the session. The
target port therefore travels sealed: the relay never sees it.

### 11.3 Flow control

Each direction has a credit window of `STREAM_WINDOW_INITIAL` (256 KiB). The
sender may have at most that many `DATA` bytes unacknowledged; the receiver
returns credit with `WINDOW` once the local socket has flushed the bytes,
batched in grants of at least 64 KiB. A peer that sends more than it was
granted is `FLOW_CONTROL`. Honest ends therefore never have more than 256 KiB
per circuit per direction in flight, which is what the relay's buffer limits
are sized on ([`relays.md`](./relays.md) §3).

### 11.4 Half-close, close and teardown

- `FIN` is the half-close. Application data ends **only** at an authenticated
  `FIN`, in sequence, so a relay cannot make a cut stream look finished.
- The session's `CLOSE` record (§9.4) is sent only once a side has both sent
  and received `FIN`. It cannot carry the half-close itself: a side that has
  finished sending must still be able to send `WINDOW` credit for the data it
  is receiving, and nothing can be sealed after `CLOSE`.
- A `CLOSE` received without the peer's `FIN` is `TRUNCATED`. So is a
  `CIRCUIT_DESTROY` (or a lost connection) before the peer's `FIN`. After the
  peer's `FIN` a teardown is a clean end. On any failure the local socket is
  **reset** (`resetAndDestroy`), never ended, so the application sees an error
  rather than a clean end of stream.
- `RESET(code)` is followed by the sender's `CLOSE`; the receiver ends the
  stream with that code. Codes are generic protocol codes — e.g.
  `TARGET_REFUSED` or `TARGET_UNREACHABLE` from a service node whose target
  failed — never an address or an error string.
- On a clean finish **only the client** sends `CIRCUIT_DESTROY`, so the relay
  sees one teardown per circuit. A service node sends one for a failure it
  detected and after its own `RESET` (so relay state is released even if the
  client never answers); a duplicate destroy is dropped by the relay at no
  cost. A service node also resets a circuit whose client has not sent `OPEN`
  within 10 s, so a silent client cannot hold its circuit slots. The ends always send reason `DESTROY_NORMAL` (0); whatever really
  happened travelled sealed. The relay uses real codes only for what it decided
  itself (`CIRCUIT_REJECTED`, `CIRCUIT_LIMIT`, `RATE_LIMIT`,
  `RESOURCE_EXHAUSTED`, `TARGET_UNREACHABLE`, `PROTOCOL_VIOLATION`).

### 11.5 What the relay sees

The client's IP address; the destination **name** (the routing prefix); when
each circuit is created and destroyed; the size and timing of every frame;
which service node connection serves which name. Not the port, not any byte of
data, not whether a record is data, credit, a half-close or a reset, and not
why a stream failed. This is single-hop: the relay sees both who connects and
which service they reach ([`privacy-model.md`](./privacy-model.md)).
