# Security architecture

**Status: specification. Largely not implemented.** The code uses correct
primitives (NaCl via tweetnacl) but has no identity binding, no signatures, no
replay defence, no rotation and no revocation. Findings S1–S3 and S5 in the
[audit](./audit-2026-08-06.md) are the concrete gaps.

---

## 1. Key hierarchy

The rule this exists to enforce: **the Oxy identity key is never a transport
key.** It authorizes; it does not encrypt traffic. A key that is used on the wire
is a key that is exposed to protocol bugs, and the Oxy identity is the user's
whole account.

```
Oxy identity key                      long-lived, held by Oxy, never on the wire
      │ authorizes (signed grant)
      ▼
Device identity key                   per-device, generated on-device, never leaves
      │ authorizes (signed grant)
      ├──────────────┬────────────────┐
      ▼              ▼                ▼
Node key         Domain signing   Client key
(service node   key (signs        (opens circuits)
 or relay)       record sets)
      │
      ▼
Session keys                          per circuit, per hop, ephemeral, never stored
```

| Key | Lifetime | Storage | Revocation |
|---|---|---|---|
| Oxy identity | Account lifetime | Oxy | Account recovery |
| Device identity | Until device removal | Strongest platform keystore available | Owner revokes the device; the directory carries the revocation |
| Node key | Rotated on a schedule | Node's local secure storage | Owner or operator revokes; propagated in the signed directory |
| Domain signing key | Rotated on a schedule | Owner's device or Oxy-held custody | Owner revokes |
| Session key | One circuit | Memory only | Circuit teardown |

### Grants

A grant is a signed statement: *this key authorizes that key, for these
purposes, until this time.* It carries the parent public key, the child public
key, a purpose set, a validity window, a monotonic serial and a signature.

A verifier walks the chain to the Oxy identity, checks every signature, every
validity window, every purpose, and the revocation state of every link. A chain
with one unverifiable link is rejected — never partially trusted.

### What this replaces

Today a service node generates a fresh X25519 keypair at every start, `POST`s it
to the API, and the API hands it to whoever asks. Nothing signs it, nothing binds
it to the domain or its owner, and the client verifies nothing (audit S3). The
API is an unaudited man-in-the-middle for every "end-to-end encrypted" tunnel.
Under this hierarchy, the transport key is published inside a record set signed
by the domain signing key, chained to the owner's Oxy identity, and the client
verifies that chain before deriving anything.

The current code also generates an Ed25519 identity keypair, prints its public
key, and **never uses it for anything**. That plumbing is replaced, not extended.

## 2. Storage

| Platform | Device identity storage |
|---|---|
| Linux | Kernel keyring or an encrypted file with a passphrase from the platform secret service; `0600` at minimum |
| macOS | Keychain, non-exportable |
| Windows | DPAPI / CNG key storage |
| Android | Android Keystore, hardware-backed where available |
| iOS | Secure Enclave / Keychain with the strictest usable accessibility class |

Requirements: keys are never logged, never included in diagnostics, never
serialized into telemetry, and never written to a temporary directory. On mobile,
tunnel-side secrets live where the tunnel extension can reach them without the
app process being alive — an App Group container on iOS, and the shared keystore
on Android.

## 3. Cryptographic primitives

| Purpose | Primitive |
|---|---|
| Signatures | Ed25519 |
| Key agreement | X25519 |
| AEAD | XChaCha20-Poly1305 |
| KDF | HKDF-SHA256, with a distinct `info` string per purpose |
| Hash | SHA-256 |
| Randomness | Platform CSPRNG only |

Rules:

- **Key separation by purpose.** Every derived key comes from HKDF with an
  explicit purpose label. The same bytes are never reused for two purposes.
- **Never reuse a nonce under a key.** Where a counter is used it is per-direction
  and monotonic; where a random nonce is used the nonce space must be large
  enough that birthday collisions are negligible (XChaCha20's 192-bit nonce
  qualifies; a 96-bit one does not).
- **No custom constructions.** If a construction is not a standard one, it needs
  a written rationale and external review before it ships.
- **Constant-time comparison** for every secret comparison. `!==` on a token is a
  timing oracle.
- **Versioned envelopes.** Every ciphertext carries the algorithm version it was
  produced under, so rotating an algorithm does not require guessing.

## 4. Authentication

| Party | Authenticates as | To |
|---|---|---|
| Client | Device identity (or anonymously, when the mode permits) | Guard relay |
| Service node | Node key, chained to a device that the domain owner authorized | Relay, and to clients through the signed record set |
| Relay | Node key listed in the signed directory | Clients, service nodes, other relays |
| Exit | Node key + published exit policy | Clients |
| API caller | Oxy bearer token | API |

**A service credential can never stand in for a user's intent.** Any operation
performed on a user's behalf must be authorized by that user's own credential.

**Anonymous client authentication in private mode.** A client using private mode
must not have to identify itself to a guard, or the mode is pointless. That
requires either an unauthenticated client path with its own rate-limiting story,
or a blinded token. This is an open design question for Phase 6 and must be
resolved before private mode ships — not after.

## 5. Replay, downgrade and substitution

| Attack | Defence |
|---|---|
| Replay of a recorded frame | Per-direction monotonic counter inside the AEAD envelope; a repeat is `REPLAY_DETECTED`. |
| Replay of a handshake | 32-byte CSPRNG nonces from both peers, bound into the signed transcript. |
| Downgrade of version or capabilities | The handshake signature covers the whole transcript, so any modification breaks it. Security capabilities are never negotiable downward. |
| Key substitution | Every key is used only via a verified grant chain to an Oxy identity. An unchained key is not usable. |
| Directory substitution | The directory is signed; clients pin the directory signing key and reject an unsigned or stale directory rather than falling back. |
| Rollback to an old signed record set | Monotonic serials; a client refuses a serial lower than the highest it has seen for that name. |

None of these defences exist today.

## 6. Rotation and revocation

- Rotation is routine and scheduled, not an incident response. A node that cannot
  rotate on schedule is degraded and reported.
- Rotation overlaps: the new key is published and accepted before the old one is
  withdrawn, so rotation is never an outage.
- Revocation is published in the signed directory with a serial and an effective
  time, and propagates within a bounded, documented window.
- A revoked key fails **closed** everywhere. A verifier that cannot reach the
  revocation list treats a key it cannot check as untrusted for
  security-sensitive operations, rather than assuming it is fine.
- Losing a device revokes its device identity and every node and domain key
  chained under it, in one operation.

## 7. Update security

- Every release artefact is signed; the client verifies before installing.
- Three channels — development, preview, production — with independent signing.
- Version and protocol-version metadata is signed alongside the artefact.
- **Downgrade protection**: the client refuses an update whose protocol version
  or security-capability set is lower than what it currently runs.
- Rollback is an operator action to a specific signed version, never an automatic
  fallback to "the last one that started".
- **Mobile OTA constraint**: an Expo OTA update must not be able to ship
  JavaScript incompatible with the installed native tunnel module. The JS bundle
  declares the native protocol version it requires and the native module refuses
  to load a bundle outside its supported range. Detail:
  [`mobile-expo.md`](./mobile-expo.md).

## 8. Local security boundaries

- The privileged daemon and the unprivileged UI are separate processes with a
  narrow, authenticated IPC channel.
- The daemon's control socket is owner-only and authenticated. A local
  unprivileged process must not be able to reconfigure routing, install an
  override, or read key material.
- Configuration is `0600` and owned by the daemon user. State that must survive a
  reboot goes in the data directory, not a world-writable temporary directory —
  the kill-switch marker currently lives in `/tmp` (audit S10).
- Diagnostics are redacted at the point of generation. A redaction step applied
  at display time is a redaction step that will eventually be skipped.

## 9. Denial of service

| Vector | Defence |
|---|---|
| Unbounded frames | `MAX_FRAME_PAYLOAD`; anything larger is a protocol violation |
| Unbounded queues | Every queue has a capacity; a full queue applies backpressure or closes |
| Circuit exhaustion | Per-connection and per-identity circuit caps |
| Connection floods | Per-IP and per-identity rate limits at the relay |
| Memory growth | Bounded caches with eviction; bounded pending-open tables |
| CPU exhaustion via crypto | Rate-limit handshakes before doing the expensive part |
| Sybil in the directory | Operator diversity requirements and registration cost — [`relays.md`](./relays.md) |

## 10. Security testing

Required before any privacy claim is made publicly:

- Fuzz targets for the frame parser, the DNS parser and the directory parser.
- Integration tests for authentication failure, revoked keys, replayed frames,
  downgrade attempts and malformed input at every parser.
- Dependency, secret and static analysis running in CI. **No CI currently runs
  tests at all** (audit §1).
- A reproducible environment that stands up a client, two relays, a service node
  and an exit, including deliberately hostile variants of each.
- External cryptographic review of the protocol before private mode ships.

Detail and ownership: [`threat-model.md`](./threat-model.md).
