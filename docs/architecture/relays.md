# Relays

A relay forwards frames between TNP nodes. It never decrypts payloads, never
stores traffic, and never reaches the public internet — that last one is a
separate role with separate consent ([`exit-nodes.md`](./exit-nodes.md)).

**Status: one implementation (`@tnp/relay-core`), used by the standalone
server (`apps/relay`) and the relay in the `tnp` binary. Service-node
authentication, connection-scoped circuits, bounds, the signed relay directory
and relay authentication to clients are implemented and tested. The image is
publishable; serving traffic is activated by an oxy-infra pin (§8).**

---

## 1. Roles

A relay declares one or more. It does not get them by default.

| Role | Does | Sees |
|---|---|---|
| **Transit** | Forwards between TNP nodes | Previous and next hop, timing, volume |
| **Service** | Rendezvous for a service node's domain | That node, its domain, client circuits |
| **Guard** | First hop for a client's circuits | Client IP; that it is TNP. Not the destination. |
| **Exit** | Opens connections to the public internet | Destinations and unencrypted content — separate opt-in |

Operators are Oxy-run or community. Both use the same code and the same rules;
"Oxy-operated" is a directory fact clients may weigh, not a privileged status.
The registry decides it — from an allowlist of operator accounts — and never
takes a relay's word for it (§7).

## 2. Registration

1. The operator authenticates with Oxy.
2. The relay generates a node key, authorized by the operator's device identity.
3. It registers its endpoint, roles, capacity, protocol versions and capabilities.
4. Oxy verifies reachability and publishes it in the **signed** directory.
5. It heartbeats; missing heartbeats degrade then remove it.

Registration is authenticated at both ends: the API authenticates the operator,
and clients authenticate the relay by its directory-published key during the
handshake. A relay that is not in the signed directory is not selectable.

**Implemented:** steps 1, 3 (endpoint, relay key, capacity), 4 and 5, with
these specifics:

- **The signed directory** (`GET /relays/directory`, discovery.md §2) lists
  Oxy-operated relays from the API's `TNP_OXY_RELAYS` configuration
  (`{endpoint, relayKey, region}` — no account token involved) and community
  relays from the registry: heartbeat-fresh, `wss://` on a public host, and
  only while they have proved possession of their relay key within the last
  90 s. That proof is a signature by the relay key over
  `purpose ‖ endpoint ‖ key ‖ issuedAt` (`@tnp/crypto` `signRelayRegistryProof`),
  sent with every registration and heartbeat and accepted within ±5 min of
  the registry's clock. A registry relay is always `community` in the signed
  directory; `oxy` comes only from the API's configuration, and an Oxy
  endpoint can never be registered by an account.
- **The registry verifies reachability itself** (`registry/relayLiveCheck.ts`):
  before listing, the API connects to the endpoint and makes the relay prove
  the registered key exactly as a client would (transport.md §6.2) — `wss://`
  only, the host and every address it resolves to public, 5 s timeout. It
  re-checks at most every 15 min on heartbeats; a relay whose last live check
  is over an hour old leaves the directory. So a key proof alone cannot list
  an endpoint someone else answers. An account may hold at most 3 relays.
- **Relays prove their key to clients and service nodes** on every connection
  (transport.md §6.2). A client uses a relay only if the signed directory
  lists its endpoint, and only after the relay has signed the client's nonce
  and that endpoint with the listed key.

What is also authenticated is the service node, to the relay
(transport.md §6.1): it signs the relay's challenge with its node key and
presents a grant chain that must verify to the **domain key** the registry
publishes for the name (`GET /domain-keys/:name`, cached 60 s, "no key" cached
10 s, a registry error fails closed and is not cached). That is a stated
trade-off: a compromised registry can make a relay accept an attacker's node
for a name. It buys the attacker routing, not plaintext — a client that has
pinned the name's genuine domain key refuses the attacker's chain, so the
result is a denial of service for pinned clients. Removing the registry from
this decision needs a key-transparency log.

## 3. Resource control

Each of these was absent in the prototype, and each was a single-client
denial-of-service path against a shared relay (audit S6). The target:

| Limit | Scope |
|---|---|
| Max frame size | Per frame — exceeding it is a protocol violation, not a hint |
| Max circuits | Per connection, and per identity |
| Max streams | Per circuit |
| Max connections | Per IP prefix, and per identity |
| Send-buffer high-water mark | Per connection — pause reading from the peer above it |
| Handshake rate | Per IP, before the expensive crypto |
| Bandwidth | Per circuit and total, if the operator sets one |
| Memory | Bounded tables everywhere; no unbounded map anywhere |

Backpressure propagates: a relay whose outbound buffer is full stops reading
inbound, which stops the sender. It never buffers without limit and never drops
silently.

**Implemented** (`packages/relay-core/src/limits.ts`, defaults):

| Limit | Value |
|---|---|
| Frame size | `MAX_FRAME_SIZE` (20 + 65535 B) as the WebSocket `maxPayloadLength`; larger closes the connection |
| Circuits per client connection | 64; 32 awaiting `CIRCUIT_CREATED` |
| Circuits per service-node connection | 256 |
| Circuits to one service | 16 per client connection, 16 per IP address (refused with `CIRCUIT_LIMIT`), so one address cannot hold a service's slots |
| Idle open circuit | destroyed after 15 min with no frame either way (the service node resets after 10) |
| Buffered bytes, whole relay | 512 MiB; above it the connections holding the most are closed first |
| Service-node `AUTH` per IP | burst 10, refill one per 5 s; domain-key lookups coalesced per name, names without a key cached 30 s (4096 max) |
| Circuits per relay | 32 768 |
| Names served | 4096 |
| Connections | 4096 per relay, 32 per IP address |
| New connections per IP | burst 30, refill 1/s, checked before the WebSocket upgrade |
| `CIRCUIT_CREATE` per IP | burst 128, refill 32/s, checked before forwarding (the service node's DH) |
| Buffer towards a client | 64 × 256 KiB + 1 MiB |
| Buffer towards a service node | 256 × 256 KiB + 1 MiB |
| Service-node `AUTH`, `CIRCUIT_CREATED` | within 10 s each |
| Frames for circuits a connection does not own | dropped, never forwarded (no penalty: in-flight frames after a teardown look the same); more than 64 frames of types a peer may not send close the connection |
| IP addresses tracked | 65 536; a full table refuses new addresses |
| Idle connections | 120 s, with WebSocket pings |

Bun's server WebSocket cannot pause reading, so the relay does not stop a
sender by not reading. Instead the end-to-end window bounds every honest
circuit to 256 KiB in flight per direction (transport.md §11.3), the buffer
limits above are sized to that, and a frame that would push a destination's
buffer past its limit destroys **the circuit it belongs to**
(`RESOURCE_EXHAUSTED`) — only a sender ignoring its window gets there, and the
destination connection and everyone else's circuits on it are untouched.
Bun's own `closeOnBackpressureLimit` at twice the larger limit is the
backstop. No per-identity limits exist, because clients have no identity; no
bandwidth limit exists yet. Behind a load balancer every client shares the
balancer's address unless `RELAY_TRUST_FORWARDED_FOR=1` (standalone relay only)
takes it from the last `X-Forwarded-For` entry — safe only when the relay is
reachable solely through that balancer.

## 4. Circuit isolation

**Circuit IDs are scoped to the connection that created them.** Two connections
may use the same numeric ID with no interaction. A frame is dispatched only
within the circuits belonging to the socket that sent it.

This is the fix for audit finding S1, the most severe defect in the prototype
transport: the relay kept one global `Map<number, Circuit>`, looked up a
client-supplied ID with no ownership check, and every client numbered its
circuits from `1`. Two honest clients collided immediately; a hostile one could
close or disrupt another client's circuits by guessing a small integer.

**Implemented** (`@tnp/relay-core`): every connection has its own
`CircuitTable`; client ids are 64-bit CSPRNG values chosen by the client, and
the relay chooses its own CSPRNG id for the service node's side. A frame is
looked up only in the table of the connection that sent it, so a frame naming
another connection's circuit finds nothing and is dropped, never forwarded. A
colliding id is refused, never evicted. Tested with fake transports and over
loopback, including 100 concurrent circuits with deliberately colliding ids
across connections.

## 5. What a relay may and may not keep

**May keep:** aggregate counters — circuits opened, bytes forwarded, errors by
code, uptime, version, current load.

**Must not keep:** per-circuit records, client IP logs beyond the life of a
connection plus a short bounded abuse window, destinations, payloads, or anything
that reconstructs who talked to whom.

**Implemented:** `@tnp/relay-core` logs nothing per circuit and never logs a
name or an address. `/stats` returns aggregate counters only (connections,
service nodes, circuits, circuits opened and rejected, frames and bytes
forwarded, frames dropped, protocol violations, backpressure destroys, auth
failures). An IP address is held in memory only in its per-IP rate-limit entry,
which is dropped once it has no open connection and its buckets have refilled
(seconds to a minute).

Metrics are aggregates by construction, not aggregates computed from per-flow
rows that are then deleted. A retention policy that depends on deletion running
correctly is a retention policy that will eventually fail.

## 6. Abuse and operator policy

- Operators publish their terms and their approximate jurisdiction.
- Rate limits and quotas are operator-configurable within protocol bounds.
- An operator may refuse specific identities.
- Complaint handling must be possible **without** retaining traffic metadata —
  what an operator can answer is bounded by what they are allowed to keep, and
  that must be documented up front so operators are not surprised.
- Community operators choose their roles. Nobody becomes an exit by accident.

## 7. Current implementation state

From the [audit](./audit-2026-08-06.md):

| Issue | Detail |
|---|---|
| ~~**Registration is non-functional**~~ | Fixed. The client sent `{port, location}` where the API required `{endpoint, publicKey, operator, capacity}`, and the heartbeat mismatched the same way, so every call 400d and `tnp relay` aborted at startup (B2). Both shapes are now declared once in `@tnp/shared-types`, which the API parses with and the relay builds from. `tnp relay` takes `--endpoint`, the public URL clients dial, and registers with its identity key and its stated capacity. |
| ~~**No service-node authentication**~~ | Fixed. `/service` sends a challenge and accepts nothing but an `AUTH` proving possession of a node key the name's domain key authorized (transport.md §6.1). `/tunnel` stays unauthenticated by design — clients have no identity — and is rate-limited per address. |
| ~~**No relay authentication to clients**~~ | Fixed. A relay signs each peer's fresh nonce and the endpoint the peer dialed with its relay key (transport.md §6.2); clients and service nodes check the key against the signed directory and send nothing else until it verifies. An impostor at the same URL is refused before it sees a circuit or a name. |
| ~~**`operator` is self-asserted**~~ | Fixed in the registry (security review 2026-10). `operator` is no longer a request field: a relay is published as `oxy` only while the account that registered it is on the API's `TNP_OXY_RELAY_OPERATORS` allowlist (empty by default), evaluated when the directory is read, so rows written while the field was self-asserted are `community` too. Relays released earlier still send the field; it is ignored. What remains open is §2's relay authentication: the allowlist proves which *account* registered a relay, not that the machine answering at the endpoint is the one that registered. |
| ~~**`ws://` endpoints, eternal listings, gameable order**~~ | Fixed in the registry. Only `wss://` endpoints on a public host are accepted (IP literals in loopback, private, link-local, CGNAT and similar ranges, `localhost` and single-label names are refused). A relay is listed only while its last heartbeat is under 90 s old — nothing ever wrote `offline`, so one heartbeat used to list it forever. The order is Oxy-operated first, then longest-registered; it used to be status then endpoint string, so `ws://` sorted ahead of every `wss://`. |
| ~~**`tnp serve` takes the first listed relay**~~ | Fixed in the client. Without `--relay`, `tnp serve` (and the interactive menu) selects only Oxy-operated relays from the **signed** directory, fastest first (connect plus identity proof), and fails over down the list; with none it refuses, saying why. A community relay is used only when named with `--relay`; a `--relay` that is not in the directory is used only with a loud warning (and `--relay-key` to require a key), and clients will not use it. |
| ~~**Domain takeover**~~ | Fixed. A second node for a name with a different node key is refused (`ALREADY_REGISTERED`) and the incumbent stays; only the same node key may replace its own connection. |
| ~~**Global circuit IDs**~~ | Fixed: §4 (S1). |
| ~~**No limits**~~ | Fixed: §3 (S6). |
| ~~**Duplicated implementation**~~ | Fixed. `@tnp/relay-core` is the only relay; `apps/relay` and `packages/client/src/relay-node.ts` are thin bindings around it. |
| ~~**Unsigned directory**~~ | Fixed. `GET /relays/directory` is signed with a key the client pins; clients refuse an unsigned, badly signed, expired or rolled-back directory, and select relays only from a verified one (discovery.md §2). The legacy `GET /relays` listing remains, unsigned, for clients released before; nothing in this release reads it. |
| ~~**No transport tests**~~ | Fixed. `packages/relay-core` tests authentication, ownership, isolation, takeover, bounds and backpressure against fake transports and a real Bun server; `packages/client/src/overlay.{e2e,adversarial}.test.ts` run client → relay → service node over loopback, standalone and embedded, including a hostile relay. |

Phase 5 still adds health measurement, peering and multi-relay diversity.

## 8. Deployment security gate

The relay image (`tnp-relay`) is a reviewed, publishable artefact: CI builds
it on every pull request, starts it with a throwaway key and checks that it
proves that key (`apps/relay/src/self-test.ts`), and `deploy-aws.yml`
publishes it under the reviewed-image pin like the API and DNS images. The
publisher never registers task definitions, rolls out or scales anything:
**serving traffic is activated only by an oxy-infra change** that pins a
reviewed digest, sets `RELAY_ENDPOINT` and `RELAY_KEY_SEED`, lists the relay
in the API's `TNP_OXY_RELAYS`, gives the API `TNP_DIRECTORY_SIGNING_SEED`, and
scales the service up. No load-balancer idle-timeout change is needed: the
relay pings every connection every 25 s (`RELAY_PING_INTERVAL_MS`), under the
shared ALB's 60 s and Cloudflare's 100 s idle timeouts. One task per endpoint:
a relay's service-node registrations are per process.

The blockers that kept it parked, each closed with tests:

1. `/service` and `/tunnel` authenticate the caller and the relay.
2. Operator identity and domain ownership are verified rather than asserted.
3. Circuit identifiers are connection-scoped and cannot affect another client.
4. Frame, circuit, stream, connection, memory, rate, and buffer bounds enforce
   backpressure.
5. Standalone and embedded implementations share one tested relay core.
6. Clients verify a signed directory before selecting a relay.

| # | Status |
|---|---|
| 1 | **Closed.** `/service` authenticates the service node (transport.md §6.1). The relay authenticates to every client and service node by its directory-listed key (§6.2). `/tunnel` does not authenticate clients, by design: clients have no identity. |
| 2 | **Closed for domains, as far as the registry can be trusted** (§2). Operator: `oxy` only from the API's `TNP_OXY_RELAYS`; registry relays are `community` and listed only after proving their key. |
| 3 | **Closed** (§4). |
| 4 | **Closed**, with the backpressure model of §3 (circuit destruction, not read pausing) and the per-address caveat behind a load balancer. No per-identity or bandwidth limits. |
| 5 | **Closed.** One core, tested. |
| 6 | **Closed** (PR "signed relay directory"). See below for exactly what it guarantees. |

**What the signed directory and relay authentication guarantee:**

- A client (or service node) uses a relay only if a directory signed by a
  pinned key (`RELAY_DIRECTORY_SIGNING_KEYS_BASE64` in `@tnp/shared-types`)
  lists its endpoint, the directory is unexpired (6 h validity), its serial
  is no greater than its own date and no lower than the highest that device
  has accepted from the same signing key (persisted under a lock; an
  unreadable state file is a refusal, never a reset). There is no unsigned
  fallback: a fetch that fails or is refused uses only a previously verified,
  still-valid cached copy. `tnp serve` and `tnp connect` re-read the
  directory every 10 minutes and leave relays it no longer lists; with no
  verified directory at all they use no relay.
- The relay answering at that endpoint proves, per connection, that it holds
  the listed key. Forged, replayed and cross-endpoint proofs are refused
  (`packages/client/src/relay-identity.test.ts`); a service node treats any
  frame before that proof — a spoofed refusal included — as a failed proof
  and fails over.
- **A client reaches a name only through the relay that name's service node
  chose.** The node signs `name ‖ relay endpoint ‖ relay key ‖ issuedAt` with
  its node key (whose authority the client verifies through the grant chain
  rooted at the pinned domain key) and republishes it on every heartbeat; the
  registry serves it in the resolve record. The client requires the resolve
  record's relay to equal the signed one, with the directory's key for it, and
  the statement to be at most an hour old
  (`packages/client/src/relay-binding.test.ts`). For a node that publishes no
  binding (released before it), only `oxy`-operated relays are used.
- So network tampering, registry/database tampering and stale or rolled-back
  directories cannot steer a client onto a relay that is not listed, and
  registry tampering cannot steer it onto a listed relay its service node did
  not choose (beyond a binding up to an hour old, i.e. a relay the node chose
  recently).

**What they do not guarantee:**

- **The API holds the directory signing key** (`TNP_DIRECTORY_SIGNING_SEED`,
  SSM) and signs at request time. A compromised API, or anyone with that SSM
  parameter, can sign a directory listing any relay. Removing that needs
  offline signing or a transparency log (discovery.md §3, open question). Such
  a signer can raise a client's rollback mark at most to its clock plus 10
  minutes (serial ≤ issuedAt), never lock clients out.
- **Community listing is open to any Oxy account** that controls a public
  `wss://` endpoint and its key (up to 3 relays per account). Being listed
  does not make a relay used: clients use a community relay for a name only
  when that name's node signed it, and `tnp serve` never picks one on its own.
- **Blocking the API** leaves clients on their cached directory for at most
  its remaining validity (≤ 6 h), after which no relay is used.
- The live check cannot fence DNS rebinding between its lookup and its
  connection; the `wss://` certificate check is what makes that useless.
- A relay's identity proof is not bound to the TLS channel: a party that can
  terminate TLS for the endpoint and forward to the genuine relay passes. It
  then sees what a network observer sees — circuits are end-to-end encrypted.
- **End-to-end confidentiality never depended on the directory.** Every
  circuit is keyed to the name's domain key through a verified grant chain
  (transport.md §9.1); a listed relay, honest or not, reads no payload. What a
  relay sees is in transport.md §11.5 — a malicious *listed* relay can still
  observe and drop.
- A `tnp serve --relay <url>` the directory does not list is refused unless
  the operator passes `--relay-key` (the relay must then prove that key) or
  `--allow-unverified-relay` (whoever answers is accepted, with a loud
  warning). Clients refuse to reach a service through an unlisted relay.
- Directory key rotation is by pinning two keys (current and next) in a
  client release before switching the seed (`relay-directory.ts` in
  `@tnp/shared-types`); there is no in-band rotation statement yet.
