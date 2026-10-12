# Discovery

How a client learns which relays, service nodes and exits exist, what keys they
hold, and whether they are usable.

**Status: partial.** The relay directory is **signed** (§2, implemented):
`GET /relays/directory`, verified by every client against a pinned key, with
rollback protection and a local cache. Relays prove their listed key on every
connection (transport.md §6.2). Not yet: exits, health measured rather than
heartbeat liveness, protocol/software versions, diversity constraints, and
in-band key rotation. Service-node key material travels with each name's
domain key (resolution), not in this directory.

---

## 1. Directory contents

| Record | Fields |
|---|---|
| Relay | node id, public key, endpoints, roles (`transit` / `service` / `exit`), protocol versions, capabilities, capacity, health, operator id, approximate location, software version |
| Exit | the above plus the exit policy (allowed/blocked ports and destination classes), approximate jurisdiction, operator terms URL |
| Service node | domain, transport public key, relay(s) it is reachable through, health — published **inside the domain's signed record set**, not as a standalone API field |

Approximate location is published only when the operator opts in. It is a
routing-diversity input, never precise geolocation.

## 2. Authenticity

The directory is a **signed document**, not an API response the client trusts
because it arrived over TLS.

- Signed by a directory signing key the client pins.
- Carries a monotonic serial and a validity window.
- A client rejects an unsigned directory, a bad signature, an expired document,
  or a serial lower than the highest it has seen. It does not fall back to
  unverified data — that turns a detected attack into a successful one.
- The signing key rotates on a schedule, with the new key introduced under the
  old one's signature before the old one is retired.

This is what makes a compromised API insufficient to steer every client onto
attacker relays (threat-model adversary 5) — **once the signing key is held
apart from the API.** Today it is not (below), so the signature protects
against network and database tampering and against stale or rolled-back
documents, not against a compromised API.

**Implemented** (`@tnp/crypto` `relay-directory.ts`, `@tnp/shared-types`
`relay-directory.ts`, `apps/api/src/registry/relayDirectory.ts`,
`packages/client/src/relay-directory.ts`):

| Item | Value |
|---|---|
| Document | `{v: 1, serial, issuedAt, expiresAt, relays: [{endpoint, relayKey, operator, capabilities, region}], signature}`, JSON |
| Signed bytes | length-prefixed canonical encoding under the context `tnp-relay-directory-v1` (no JSON canonicalization involved) |
| Signature | Ed25519 by the directory signing key; clients pin one or two keys (`RELAY_DIRECTORY_SIGNING_KEYS_BASE64`) |
| Validity | 6 h; at most 7 days accepted; `issuedAt` at most 10 min ahead of the client clock |
| Serial | equals the signing time (`serial ≤ issuedAt` is required, so no signer can push the mark beyond the clock), never lowered by one API process; clients keep the highest accepted **per signing key** per device (`relay-directory.json`, 0600, changed under a lock; unreadable = refusal) and refuse lower |
| Freshness in use | clients refetch every 10 min and drop relays no longer listed; no verified directory, no relay |
| Bounds | ≤ 256 relays, ≤ 128 KiB canonical, endpoints canonical `wss://` on a public host, unique; strict fields |
| Key custody | the API signs at request time with `TNP_DIRECTORY_SIGNING_SEED` (base64 32-byte seed; SSM SecureString in production). Unset: `GET /relays/directory` answers **503** — never an unsigned listing |
| Contents | Oxy relays from `TNP_OXY_RELAYS`; community relays from the registry only while heartbeat-fresh and key-proven (relays.md §2) |

Rotation: pin the next key beside the current one in a client release, move
the seed once that release is widespread, drop the old key in a later
release. A rotation statement signed by the old key (the scheme above) is not
implemented.

## 3. Distribution

- Primary: fetched from the API, verified by signature, cached locally with its
  validity window. (Implemented; refetched every 10 minutes while in use.)
- The cached copy is used when the API is unreachable, until it expires.
  (Implemented; also when a fetched document is refused — the cached one is
  verified data, re-verified before use.)
- Bootstrap: a small set of directory endpoints and the pinned signing key ship
  with the client.
- **Open question** (threat model §7.2): how to distribute the directory without
  the API being a single point of compromise. Mirrors, and a client that accepts
  a valid document from any source, is the likely answer; it needs a written
  design before Phase 6.

## 4. Health and capacity

Published per node: liveness, current load relative to capacity, error rate,
protocol version and software version.

Health is **derived from measurements**, not self-reported alone. A node
self-reporting perfect health while failing circuits must be observably degraded.
Client-side outcomes feed a local reputation view — a node that fails for one
client is downweighted by that client immediately, without waiting for the
directory.

## 5. Selection

The client selects, not the API. The API publishes facts; policy is local.

Inputs: role, health, capacity headroom, protocol compatibility, latency
measured locally, operator diversity, and the user's preferences (Oxy relays,
community relays, or any).

Constraints, all mandatory once multi-hop lands:

- No two hops in one circuit from the same operator.
- No two hops in one circuit in the same /16 (IPv4) or /32 (IPv6) prefix.
- Guards are pinned and rotated slowly — see [`onion-routing.md`](./onion-routing.md).
- A node whose protocol version is below the client's minimum is not selectable.

## 6. Sybil resistance

An attacker who registers many relays can eventually own every hop of a circuit.
Initial measures, with the economics still open (threat model §7.3):

- Relay registration requires an authenticated Oxy identity.
- Per-identity and per-prefix caps on how many relays count toward selection.
- Operator diversity is a hard selection constraint, not a preference.
- New relays are weighted low until they have observed uptime.
- Capacity claims are cross-checked against measurement before being trusted.

## 7. Privacy of discovery

Fetching the directory tells the API that this IP runs TNP. That is unavoidable
and must be stated.

What must **not** happen: the client asking the API "where is `example.ox`?" per
destination, which would hand the API a per-user destination log. The client
fetches the whole directory and selects locally. For service nodes, the client
resolves the name and reads the relay from the signed record set — one lookup
that already happened, not a second one that reveals routing intent.
