# Security architecture

**Status: specification. Largely not implemented in the running system.** The
deployed code uses correct primitives (NaCl via tweetnacl) but has no identity
binding, no signatures, no replay defence, no rotation and no revocation.
Findings S1–S3 and S5 in the [audit](./audit-2026-08-06.md) are the concrete
gaps. Grant chains, key-agreement certificates (`@tnp/crypto`) and the
end-to-end session ([`transport.md`](./transport.md) §9, `@tnp/protocol/v1`)
are implemented as libraries, exactly as specified below, but **no component
uses them yet** — none of their protection is in effect until the Phase 3
cutover.

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
validity window, every purpose, every scope, and the revocation state of every
link — and that **each link is no broader than the one above it**. A chain with
one unverifiable link is rejected — never partially trusted. Implementation:
`verifyChain` in `@tnp/crypto` (`packages/crypto/src/grants.ts`).

**Purposes.** `delegate` (may sign further grants), `service-node` (terminates
end-to-end sessions for a name; may certify key-agreement keys for it),
`domain-records` (signs a record set), `relay` (a directory relay; may certify
key-agreement keys for its hostname), `client`. The first three after
`delegate` are **scoped purposes**.

**Scope.** A scope is a name in canonical form — lowercase ASCII LDH labels of
1–63 bytes joined by single dots, no leading or trailing dot, at most 253 bytes;
uppercase is refused, not folded, because a signature covers exact bytes. One
scope *covers* another when it is equal to it or a parent of it **at a label
boundary** (`example.ox` covers `www.example.ox`, not `badexample.ox`). A
non-delegating grant that carries a scoped purpose must have a scope; a
delegating grant may omit it, meaning unrestricted within what its own issuer
holds. Verifying a scoped purpose requires naming the scope being connected to
(`requireScope`) — enforced by the type of `VerifyOptions` and again at run time
— and the leaf's scope must **equal** it exactly: covering is for narrowing
between links, not for the key that is finally used.

**Narrowing.** For every grant `P` directly above a grant `C` in the chain:

1. `P` carries `delegate`.
2. `C`'s purposes are a subset of `P`'s — a device delegated for `client` use
   cannot mint a `service-node` key.
3. If `P` has a scope, `C` has one and `P`'s covers it — an intermediate scoped
   to `a.ox` cannot authorize a key for `b.ox`, and cannot authorize an
   unscoped (broader) key either.
4. `C`'s validity window lies inside `P`'s.

No key may appear twice in a chain, and a chain is at most `MAX_CHAIN_DEPTH` (4)
grants.

**Canonical encoding.** The wire form is JSON with keys and signatures in
base64. It is parsed strictly before anything is compared: keys must be
canonical standard base64 (decoding and re-encoding must give back the same
string — no URL-safe alphabet, missing padding, whitespace or non-zero trailing
bits) of exactly 32 bytes; signatures exactly 64; times and serials
non-negative safe integers (a fractional time is refused, never truncated);
purposes known, non-empty and without duplicates; unknown fields refused. Every
comparison — trusted roots, revocation, linkage, rollback serials — is on the
32 key bytes, never on a string spelling, and a malformed entry in the
verifier's own root or revocation list throws rather than silently not
matching. The signed bytes are:

```
u32 len ‖ "tnp-grant-v2"
issuer (32 raw bytes) ‖ subject (32 raw bytes)
u32 len ‖ purposes, sorted, joined with ","
u64 notBefore ‖ u64 notAfter ‖ u64 serial          (big-endian)
u32 len ‖ scope                                    ("" when absent)
```

(`tnp-grant-v1`, which signed the base64 strings, never shipped and is not
accepted.)

### Key-agreement certificates

Grants authorize Ed25519 keys; the session handshake is X25519. The binding
between them is explicit: a **key-agreement certificate** is signed by a node
key (the leaf of a grant chain) and certifies a *separate* X25519 key — not the
node key converted to Curve25519 — so that the node can rotate it on a short
schedule without touching the chain, and a stolen key-agreement secret is useful
only until its certificate expires. Implementation:
`signKeyAgreementCertificate` / `verifyKeyAgreementCertificate` in
`packages/crypto/src/key-agreement.ts`.

```
u32 len ‖ "tnp-key-agreement-v1"
signer (32 raw bytes, Ed25519) ‖ key (32 raw bytes, X25519)
u32 len ‖ role             ("service-node" | "relay")
u32 len ‖ scope
u64 notBefore ‖ u64 notAfter ‖ u64 serial
```

The distinct context string means a grant signature can never stand in for a
certificate signature or vice versa. A certificate verifies only when its chain
verifies to a trusted root with a leaf that is the certificate's signer and
holds the purpose matching the role (`service-node` → `service-node`, `relay` →
`relay`); its scope equals the name being connected to and lies within the leaf
grant's scope; its role is the one requested; its window lies inside the leaf
grant's, contains now, and is at most `MAX_KEY_AGREEMENT_LIFETIME` (7 days)
long; neither the signer nor the X25519 key is revoked; its serial is not below
the verifier's high-water mark for that signer and key; and the X25519 key is
canonically encoded and not of small order. The result is a
`VerifiedKeyAgreementKey`, the only form of key the session handshake accepts.

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

| Purpose | Primitive | Implementation |
|---|---|---|
| Signatures | Ed25519 | tweetnacl |
| Key agreement | X25519, refusing non-canonical and small-order keys | tweetnacl, checks in `@tnp/crypto/primitives` |
| AEAD, counter nonce | ChaCha20-Poly1305 (RFC 8439) | `@noble/ciphers` 1.3.0 |
| AEAD, random nonce | XChaCha20-Poly1305 (none in use yet) | — |
| KDF | HKDF-SHA256 | `@noble/hashes` 1.8.0 |
| Hash | SHA-256 | `@noble/hashes` 1.8.0 |
| Randomness | Platform CSPRNG only | tweetnacl → `crypto.getRandomValues` |

All are pure JavaScript, so one implementation serves Bun, browsers and React
Native. The `@noble` packages are pinned to exact versions.

Rules:

- **Key separation by purpose.** Every derived key comes from HKDF with an
  explicit purpose label. The same bytes are never reused for two purposes.
  Inside the Noise handshake ([`transport.md`](./transport.md) §9) separation
  comes from Noise's own chaining key and handshake hash, with the TNP context
  bound in the prologue, rather than from `info` strings; signatures are
  separated by a distinct context string per signed structure.
- **Never reuse a nonce under a key.** Where a counter is used it is per-direction
  and monotonic; where a random nonce is used the nonce space must be large
  enough that birthday collisions are negligible (XChaCha20's 192-bit nonce
  qualifies; a 96-bit one does not).
- **No custom constructions.** If a construction is not a standard one, it needs
  a written rationale and external review before it ships.
- **Constant-time comparison** for every secret comparison. `!==` on a token is a
  timing oracle.
- **Versioned envelopes.** Every ciphertext carries the algorithm version it was
  produced under, so rotating an algorithm does not require guessing. For
  session records this is the frame's `version` byte, which is authenticated as
  associated data, and the Noise protocol name, which is fixed per version.

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
| Replay of a recorded frame | Per-direction 64-bit counter used as the AEAD nonce, strict in-order acceptance; a repeat is `REPLAY_DETECTED`, a gap or reordering `PROTOCOL_VIOLATION` ([`transport.md`](./transport.md) §9.3). |
| Reflection of a frame to its sender | Separate keys per direction; the reflected record fails authentication (`DECRYPT_FAILED`). |
| Truncation of a stream | Authenticated `CLOSE` record; an end without it is `TRUNCATED` (§9.4). |
| Replay of a connection handshake | 32-byte CSPRNG nonces from both peers, bound into the signed transcript. |
| Replay of a session handshake | Fresh ephemerals on both sides; a replayed message 1 yields a session the replayer cannot use (§9.2). |
| Downgrade of version or capabilities | The handshake signature covers the whole transcript, so any modification breaks it. The session handshake binds version, role and name in its prologue and has no negotiable suite. Security capabilities are never negotiable downward. |
| Key substitution | Every key is used only via a verified grant chain to an Oxy identity. An unchained key is not usable: the session handshake accepts only a `VerifiedKeyAgreementKey`, checked at run time. |
| Directory substitution | The directory is signed; clients pin the directory signing key and reject an unsigned or stale directory rather than falling back. |
| Rollback to an old signed record set | Monotonic serials; a client refuses a serial lower than the highest it has seen for that name. |

None of these defences is in effect in the deployed system. The replay,
reflection, truncation, session-handshake and key-substitution rows are
implemented in `@tnp/crypto` and `@tnp/protocol/v1` and wait on the Phase 3
cutover; the connection handshake, signed directory and signed record sets are
not implemented.

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

### Target

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

### Implemented (client releases)

- **Signed checksums.** Each release `v<x.y.z>` carries the five binaries,
  `SHA256SUMS` (`sha256sum` output over every binary) and `SHA256SUMS.sig`: the
  **raw 64-byte** Ed25519 detached signature over the exact bytes of
  `SHA256SUMS`. Release key (raw, base64):
  `n4CCDVyVmPikeULWtYh6ohrhAPvd4n9CvhdDgwVSRjw=`. It is pinned once, in
  `packages/shared-types/src/release.ts`; the client, both installers and the
  signing script all read it from there, and tests assert it equals this value.
- **Release pipeline** (`.github/workflows/release-client.yml`): typecheck and
  test on the release commit, build, write `SHA256SUMS`; sign in a separate job
  that installs no dependencies and uses only OpenSSL
  (`.github/scripts/sign-release.sh`), which refuses unless the seed derives the
  pinned key and re-verifies afterwards; verify every binary with the client's
  own `verifyReleaseAsset` and with the installers' OpenSSL command; then
  publish with an `actions/attest-build-provenance` SLSA attestation. Every
  action is pinned by commit SHA.
- **`tnp update`** reads only `version` from `/client/latest`, accepts only a
  strict `x.y.z` that is **strictly newer** than the running version, downloads
  from the fixed `https://github.com/OxyHQ/tnp/releases/download/v<version>/`
  URLs, verifies the signature with the key compiled into the binary and the
  binary's SHA-256 against the signed list, then replaces itself
  (`process.execPath`) by exclusive-create temp file and atomic rename.
- **Installers** (`apps/api/src/installers/`, the only copies) download from the
  same fixed URLs into a `mktemp -d` directory and verify **before running or
  moving anything**, with no fallback URL. The shell installer verifies the
  signature when OpenSSL 3 or later is present and otherwise says that only the
  checksum was checked (`TNP_REQUIRE_SIGNATURE=1` makes that fatal). PowerShell
  has no Ed25519: the Windows installer uses OpenSSL 3 if it finds one (for
  example Git for Windows') and otherwise states it checked the checksum only.
  The installer option that pointed all system DNS at TNP's resolver over
  plaintext UDP is removed.

### Verifying a download by hand

```sh
v=0.3.0   # the release
for f in tnp-linux-x64 SHA256SUMS SHA256SUMS.sig; do
  curl -fsSLO "https://github.com/OxyHQ/tnp/releases/download/v$v/$f"
done
cat > tnp-release.pem <<'EOF'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAn4CCDVyVmPikeULWtYh6ohrhAPvd4n9CvhdDgwVSRjw=
-----END PUBLIC KEY-----
EOF
# OpenSSL 3 prints "Signature Verified Successfully"
openssl pkeyutl -verify -pubin -inkey tnp-release.pem -rawin \
  -in SHA256SUMS -sigfile SHA256SUMS.sig
# macOS: shasum -a 256 -c --ignore-missing SHA256SUMS
sha256sum --check --ignore-missing SHA256SUMS
# Build provenance
gh attestation verify tnp-linux-x64 --repo OxyHQ/tnp
```

Get the key from more than one place (this file and its git history, a release
note, someone you trust) rather than from the page you download from.

### What remains

- **The key is an online CI secret** (`TNP_RELEASE_SIGNING_SEED` in GitHub
  Actions), not the offline custody the threat model's asset table requires.
  Anyone who can change `release-client.yml` on `main`, or who compromises
  GitHub Actions for this repository, can sign. Next: a protected environment
  with required reviewers on the signing job, then an offline or HSM-held key
  with a two-person release ceremony.
- **The installer's trust root is `get.tnp.network`.** The script, and the key
  in it, come from the API over HTTPS; whoever controls that host controls the
  installer. Signature checking protects against a tampered GitHub release or
  CDN, not against a compromised API. Users at risk should verify by hand.
- **No channels, no signed version metadata, no protocol-version downgrade
  check** — only "strictly newer x.y.z". An old signed release with a known flaw
  can still be installed fresh (`TNP_VERSION=`, or a compromised API serving an
  installer that pins it); `tnp update` will not move to it.
- **Freeze attacks**: a compromised API can withhold updates by reporting the
  current version. There is no signed timestamp or expiry yet.
- **No reproducible builds**: provenance attests where a binary was built, not
  that its source produces it.
- **Releases before the first signed one** (v0.2.0 and earlier) carry no
  signature; the installers and `tnp update` refuse them.

### Rotating the release key

1. Generate a new seed offline:
   `openssl genpkey -algorithm ed25519 -outform DER | tail -c 32 | base64`, and
   derive its public key.
2. Ship a client release, still signed by the **old** key, that changes
   `RELEASE_SIGNING_PUBLIC_KEY_BASE64` (and this document and the tests that pin
   the value) to the new key. Clients that update to it now trust the new key.
3. Replace the `TNP_RELEASE_SIGNING_SEED` secret with the new seed. Every later
   release is signed with it, and `sign-release.sh` refuses the old one.
4. Publish the new key out of band. Clients older than step 2 cannot verify
   later releases and must reinstall.

If the key is **compromised**, step 2 cannot be trusted: publish the new key out
of band and tell users to reinstall and verify by hand. The client has no
revocation mechanism yet.

## 8. Local security boundaries

- The privileged daemon and the unprivileged UI are separate processes with a
  narrow, authenticated IPC channel.
- The daemon's control socket is owner-only and authenticated. A local
  unprivileged process must not be able to reconfigure routing, install an
  override, or read key material.
- Configuration is never readable by other users: `config.json` is `0600` root
  (it can hold the relay auth token). On Linux the sandboxed resolver instead
  reads `resolver.json` — only its listen address, API URL, upstreams and cache
  size, no secret — root:tnp `0640` inside a root:tnp `0750` directory, so it
  can read its settings but never write them or see a token. On Windows the
  config directory's ACL is SYSTEM and Administrators only.
- Anything root writes lives in a directory only root controls — never `/tmp`,
  and never a directory the unprivileged daemon user owns, where a planted
  symlink would redirect root's write. The kill-switch record is in the system
  state directory (`/var/lib/tnp`, `/Library/Application Support/tnp`,
  `%ProgramData%\tnp`), closing audit S10.
- A binary a privileged service executes lives where only administrators can
  write (`/usr/local/bin/tnp` after a root-ownership check, `%ProgramFiles%\TNP`);
  install refuses rather than point a root unit or SYSTEM task at a
  user-writable file.
- Tokens are not passed on the command line: `TNP_TOKEN` or `--token-stdin`.
  `--token` remains for compatibility and warns, because `/proc/<pid>/cmdline`
  is readable by every local user.
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
