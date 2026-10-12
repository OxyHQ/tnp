# Security architecture

**Status: partly implemented.** Since the Phase 3 transport cutover the
overlay runs on what this document specifies: grant chains and key-agreement
certificates (`@tnp/crypto`), the end-to-end session
([`transport.md`](./transport.md) §9, `@tnp/protocol/v1`), service-node
authentication to relays, and client-side pinning of each name's **domain
key** (§1, "Domain keys and pinning"). That closes audit findings S1, S2, S3
(for names a client has already used) and S5 in code. Not implemented: the Oxy
identity → device key hierarchy (service nodes do not use it — see below), the
connection handshake of transport.md §6 beyond service-node authentication,
the signed directory, signed record sets, and directory-published revocation.
None of it is deployed: the relay is parked ([`relays.md`](./relays.md) §8).

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

### Domain keys and pinning (implemented)

**This departs from the diagram above.** For service nodes the root of trust is
not an Oxy identity and not a device key: it is a per-name **domain key** that
only the domain owner holds. The reason is the adversary: an operator that can
be compelled controls Oxy, and a hierarchy rooted at an Oxy-held key would let
it mint a valid key for anyone's domain. The Oxy identity → device key
hierarchy is not used by the overlay at all; it remains the target for relays,
clients and record sets.

```
domain key (Ed25519)        generated on the owner's device, never sent anywhere
     │ grant: purpose service-node, scope = the name, 30 days, serial = issue time
     ▼
node key (Ed25519)          one per service node per name, persistent
     │ key-agreement certificate, ≤ 7 days
     ▼
X25519 key                  what clients run the Noise handshake against
```

**Creation and storage.** The first `tnp serve --domain <name>` on a device
that has neither the domain key nor a registered one generates it, as does
`tnp domain key init <name>`. Keys live in the **per-user** data directory of
whoever runs the command — `<user data dir>/overlay/` (`~/.local/share/tnp` or
`$XDG_DATA_HOME/tnp` on Linux, `~/Library/Application Support/tnp` on macOS,
`%LOCALAPPDATA%\tnp` on Windows; `TNP_DATA_DIR` overrides) — never the
sandboxed resolver daemon's directory: `domain-keys/<name>.json`,
`node-keys/<name>.json`, `grants/<name>.json` and `pins.json`. Under `sudo`
the directory is the **invoking** user's (`SUDO_USER`, home from the password
database, `XDG_DATA_HOME` ignored) and files written there are handed back to
that user, so `sudo tnp connect`, `tnp pins` and `tnp test` share one pin
store. Files are written to an exclusive temp file, flushed and renamed, mode
`0600` (an ACL on Windows), in a `0700` directory; a symlink at the target is
refused, and a key file readable by others is tightened to `0600` with a
warning.

**Keep the domain key off the serving host.** A domain key on the machine that
serves the name is on the machine most exposed to the internet: whoever takes
that host takes the name and can sign rotations that pinned clients follow.
`tnp serve` says so when it creates the key there. The safer arrangement is
the domain key on an offline device, and each service node authorized from it
with `tnp domain grant <name> --node-key <key>` (the node prints its key);
nodes without the domain key cannot renew their own grant and warn before it
expires.

**Registration and rotation.** The owner registers the public half once with
`POST /domain-keys` (Oxy-authenticated, owner only). After that the registry
accepts a different key **only** with a rotation statement signed by the
current key:

```
u32 len ‖ "tnp-domain-key-rotation-v1" ‖ u32 len ‖ name
‖ previousKey (32) ‖ nextKey (32) ‖ u64 issuedAt
```

`issuedAt` must be later than the previous statement's and at most 300 s in
the future; the registry keeps the last 32 statements and serves them with the
key. `tnp domain key rotate <name>` writes the new key to `<name>.json.pending`
first, then registers the rotation; once the registry accepts it the retired
secret is overwritten and unlinked (never kept — it could still sign a rotation
clients pinned to it would follow) and the pending key renamed into place. A
refused rotation removes the pending key. A successful rotation clears the
published chain and certificate of the name's service node in the same
transaction (node registration locks the same row and re-checks the key, so it
cannot land afterwards under the retired key), relays drop nodes chained under
the old key at their next re-check (every 10 minutes), and clients that follow
the rotation verify against the new key — so rotating is how an owner retires
every node under a key.

**Release, re-registration and resets — exactly what is guaranteed.** While a
name is registered, its key changes only by a rotation signed by the current
key; the owner's Oxy account alone cannot replace it. Releasing the name
(`DELETE /domains/:id`) does not forget the key: it is kept, with its rotation
history, in a tombstone that is never deleted. When the name is registered
again — by anyone — its first key must be the released key, or come with a
rotation signed by it; otherwise the registry accepts an unrelated key only
after the **reset hold** (30 days after the release by default,
`TNP_DOMAIN_KEY_RESET_HOLD_DAYS`), and then publishes it with `keyReset:
{ previousKeyFingerprint, since }` (the SHA-256 of the key it replaced) in
`/domain-keys` and the resolve overlay. A client that pinned the previous key
keeps refusing and is told the name was released and registered again; a
client meeting the name for the first time can see the key is not the
original. So an Oxy session — or whoever compels one — can replace a name's
key only by releasing it and waiting out the hold, visibly. A lost domain key
has exactly this recovery path and no faster one. Whoever can write the
registry's database directly is not bound by any of this; pinning is the
defence there.

**Node credentials.** On the owner's device the node grant is issued locally
and renewed automatically when less than 7 days remain. A node on another
device needs a grant from the owner: `tnp domain grant <name> --node-key
<base64> [--days N]` on the owner's device, copied to
`grants/<name>.json`. The node certifies a fresh X25519 key for at most 7 days
(never past its grant) and replaces it when less than 4 days remain; the
previous key keeps completing handshakes until its certificate expires, so a
client holding a slightly stale certificate still connects. Every new
certificate is published with `POST /nodes/register`, and the registry verifies
it against the domain key before storing it.

**Pinning (trust on first use).** The client verifies a name's chain and
certificate against the domain key in the `/dns/resolve` overlay block
([`transport.md`](./transport.md) §9.1), for the name it derived itself. After
the first successful verification it pins that domain key for the name in
`pins.json`, with rollback high-water marks for the grant and certificate
serials it has seen (at most 256 per name, the least recently raised dropped
first). Every change to the pin file is made under an exclusive lock file
(stale locks broken after 10 s) against a fresh read and written atomically,
and nothing is cached in memory, so concurrent processes never lose each
other's pins and `tnp pins forget` is not undone by a running client. Afterwards it accepts a different
domain key **only** if the overlay's rotation history leads from the pinned key
to the presented one through statements each signed by the key it retires, in
increasing `issuedAt` order. Otherwise it refuses, fail-closed, with a message
that says the name may be being impersonated and how to override it after
out-of-band confirmation. A corrupt pin file is an error, never "no pins".
`tnp pins` lists pins, `tnp pins forget <name>` removes one, and `tnp status`
reports how many there are.

**What this does not protect.**

- **First contact still trusts the registry.** A client that has never used a
  name pins whatever domain key it is shown. A compelled or compromised
  registry can substitute a key for a client's first connection to a name. A
  key-transparency log, which does not exist yet, is what would close this.
- **A stolen retired domain key** can sign a rotation that a client still
  pinned to that key will follow, as long as the registry serves it.
- **The registry can withhold.** It can omit statements (pinned clients then
  fail closed) or refuse to publish a node; that is denial of service, not
  substitution.
- **Relays check nodes against the registry's copy** of the domain key
  ([`relays.md`](./relays.md) §2), so a compromised registry can make a relay
  route a name to an attacker's node. Clients that pinned the genuine key
  refuse it.

### What this replaced

A service node used to generate a fresh, unsigned X25519 key at every start
and `POST` it to the API, which handed it to whoever asked; the client derived
its session key from it without checking anything, so the API was a
man-in-the-middle for every tunnel (audit S3). An Ed25519 "identity" key was
generated, printed, and never used; it is now only the relay's directory
registration key.

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
| AEAD, random nonce | XChaCha20-Poly1305 (192-bit nonce): personal DNS rules, `@tnp/crypto/dns-rules` | `@noble/ciphers` 1.3.0 |
| KDF | HKDF-SHA256 | `@noble/hashes` 1.8.0 |
| Password KDF | Argon2id (RFC 9106; default m = 64 MiB, t = 3, p = 1; floor m = 19 MiB, t = 2): the personal-rules sync passphrase | `@noble/hashes` 1.8.0 |
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
  The personal-rules envelope carries `v: 1`, authenticated in the associated
  data of both the key wrap and the rule set, beside the Oxy user id (and, for
  the rule set, its monotonic `version`); KDF parameters and salt are bound
  into the wrap's associated data, so a stored record cannot be downgraded to
  weaker parameters without the unwrap failing.

## 4. Authentication

| Party | Authenticates as | To |
|---|---|---|
| Client | Device identity (or anonymously, when the mode permits) | Guard relay. Today: no client authentication to relays; rate-limited per address |
| Service node | Node key, chained by a grant to the name's domain key (implemented; no device key) | Relay, by a challenge signature (transport.md §6.1); clients, through the chain and certificate in the resolve overlay, checked against their pin |
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
| Truncation of a stream | Authenticated `CLOSE` record; an end without it is `TRUNCATED` (§9.4). The overlay ends data only at a sealed `FIN` (transport.md §11.4). |
| Replay of a connection handshake | 32-byte CSPRNG nonces from both peers, bound into the signed transcript. |
| Replay of a session handshake | Fresh ephemerals on both sides; a replayed message 1 yields a session the replayer cannot use (§9.2). |
| Downgrade of version or capabilities | The handshake signature covers the whole transcript, so any modification breaks it. The session handshake binds version, role and name in its prologue and has no negotiable suite. Security capabilities are never negotiable downward. |
| Key substitution | Every key is used only via a verified grant chain to the name's domain key, which the client has pinned; a different domain key needs a rotation signed by the pinned one. An unchained key is not usable: the session handshake accepts only a `VerifiedKeyAgreementKey`, checked at run time. First contact still trusts the registry (§1). |
| Rollback to an older grant or certificate | Per-pin high-water marks on grant and certificate serials; a lower serial for the same issuer and subject is refused (`rolled-back`). |
| Directory substitution | The directory is signed; clients pin the directory signing key and reject an unsigned or stale directory rather than falling back. |
| Rollback to an old signed record set | Monotonic serials; a client refuses a serial lower than the highest it has seen for that name. |

The replay, reflection, truncation, session-handshake, key-substitution and
grant/certificate rollback rows are implemented and used by the overlay, and
tested end to end against a hostile relay
(`packages/client/src/overlay.adversarial.test.ts`); none is deployed while the
relay is parked. The connection-handshake replay and downgrade rows apply to a
handshake that is not implemented (only service-node authentication is, with a
per-connection challenge). The signed directory and signed record sets are not
implemented.

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

**Implemented today:** key-agreement certificates rotate on schedule with
overlap (§1); node grants renew automatically where the domain key is local;
rotating the domain key retires every node chained under the old one. There is
no directory, so no published revocation: revoking one node key without
rotating the domain key is not possible yet.

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

Status: every row but the last is implemented in `@tnp/relay-core` for the
overlay — frame cap enforced by the WebSocket binding, per-connection and
global circuit caps, per-IP connection limits and connect and handshake rate
limits, bounded pending opens, buffer limits that destroy a window-violating
circuit instead of queueing, idle timeouts. "Per identity" limits do not exist
because clients have no identity. Values: [`relays.md`](./relays.md) §3.

## 10. Security testing

Required before any privacy claim is made publicly:

- Fuzz targets for the frame parser, the DNS parser and the directory parser.
- Integration tests for authentication failure, revoked keys, replayed frames,
  downgrade attempts and malformed input at every parser.
- Dependency, secret and static analysis running in CI. CI runs typecheck,
  lint and tests on every PR; dependency and static analysis do not run yet.
- A reproducible environment that stands up a client, two relays, a service node
  and an exit, including deliberately hostile variants of each. Today: a
  loopback client → relay → service node suite, standalone and embedded relay,
  with a hostile relay wrapper (replay, reorder, reflection, tamper,
  truncation, impersonation) — one relay, no exit.
- External cryptographic review of the protocol before private mode ships.

Detail and ownership: [`threat-model.md`](./threat-model.md).
