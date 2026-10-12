# Relays

A relay forwards frames between TNP nodes. It never decrypts payloads, never
stores traffic, and never reaches the public internet — that last one is a
separate role with separate consent ([`exit-nodes.md`](./exit-nodes.md)).

**Status: one implementation (`@tnp/relay-core`), used by the standalone
server (`apps/relay`) and the relay in the `tnp` binary. Service-node
authentication, connection-scoped circuits and bounds are implemented and
tested; relay authentication to clients and the signed directory are not.
Parked: not published, not deployed (§8).**

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

**Implemented today:** steps 1, 3 (endpoint, identity key, capacity) and 5
through the registry; there is no signed directory (4) and clients do not
authenticate the relay. What **is** authenticated is the service node, to the
relay (transport.md §6.1): it signs the relay's challenge with its node key and
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
| **No relay authentication to clients** | Open. Clients cannot tell a relay from an impostor at the same URL; the end-to-end session makes an impostor unable to read or alter traffic, not unable to observe or drop it. Needs the signed directory (Phase 5). |
| ~~**`operator` is self-asserted**~~ | Fixed in the registry (security review 2026-10). `operator` is no longer a request field: a relay is published as `oxy` only while the account that registered it is on the API's `TNP_OXY_RELAY_OPERATORS` allowlist (empty by default), evaluated when the directory is read, so rows written while the field was self-asserted are `community` too. Relays released earlier still send the field; it is ignored. What remains open is §2's relay authentication: the allowlist proves which *account* registered a relay, not that the machine answering at the endpoint is the one that registered. |
| ~~**`ws://` endpoints, eternal listings, gameable order**~~ | Fixed in the registry. Only `wss://` endpoints on a public host are accepted (IP literals in loopback, private, link-local, CGNAT and similar ranges, `localhost` and single-label names are refused). A relay is listed only while its last heartbeat is under 90 s old — nothing ever wrote `offline`, so one heartbeat used to list it forever. The order is Oxy-operated first, then longest-registered; it used to be status then endpoint string, so `ws://` sorted ahead of every `wss://`. |
| ~~**`tnp serve` takes the first listed relay**~~ | Fixed in the client. Without `--relay`, `tnp serve` (and the interactive menu) selects only an Oxy-operated relay and otherwise refuses, saying why; a community relay is used only when named with `--relay`. The directory is still unsigned, so this trusts the registry's `operator` field. |
| ~~**Domain takeover**~~ | Fixed. A second node for a name with a different node key is refused (`ALREADY_REGISTERED`) and the incumbent stays; only the same node key may replace its own connection. |
| ~~**Global circuit IDs**~~ | Fixed: §4 (S1). |
| ~~**No limits**~~ | Fixed: §3 (S6). |
| ~~**Duplicated implementation**~~ | Fixed. `@tnp/relay-core` is the only relay; `apps/relay` and `packages/client/src/relay-node.ts` are thin bindings around it. |
| **Unsigned directory** | Open. Clients cannot verify a relay is legitimate (Phase 5). |
| ~~**No transport tests**~~ | Fixed. `packages/relay-core` tests authentication, ownership, isolation, takeover, bounds and backpressure against fake transports and a real Bun server; `packages/client/src/overlay.{e2e,adversarial}.test.ts` run client → relay → service node over loopback, standalone and embedded, including a hostile relay. |

Phase 5 adds the signed directory, health, peering and selection.

## 8. Deployment security gate

`tnp-relay` is intentionally not an AWS-publishable artefact and its ECS service
must remain at `desired_count = 0`. The API and DNS image workflow has no relay
matrix entry, task-definition registration, rollout, or scaling operation.

Do not add the relay to that workflow or activate traffic until all of these are
closed with tests and a separate security review:

1. `/service` and `/tunnel` authenticate the caller and the relay.
2. Operator identity and domain ownership are verified rather than asserted.
3. Circuit identifiers are connection-scoped and cannot affect another client.
4. Frame, circuit, stream, connection, memory, rate, and buffer bounds enforce
   backpressure.
5. Standalone and embedded implementations share one tested relay core.
6. Clients verify a signed directory before selecting a relay.

Keeping the service at zero is necessary but not sufficient: publishing an
apparently deployable relay image would create an unsafe shortcut around this
gate, so the publisher excludes it entirely.

**Gate status after the Phase 3 transport cutover:**

| # | Status |
|---|---|
| 1 | **Partly closed.** `/service` authenticates the service node. `/tunnel` does not authenticate clients, by design, and the relay is not authenticated to anyone. |
| 2 | **Closed for domains, as far as the registry can be trusted.** Serving a name requires a chain from the name's domain key, checked against the registry's copy (§2). Operator identity: the registry decides `operator` from an account allowlist (§7); it does not prove the machine at the endpoint is the one that registered. |
| 3 | **Closed** (§4). |
| 4 | **Closed**, with the backpressure model of §3 (circuit destruction, not read pausing) and the per-address caveat behind a load balancer. No per-identity or bandwidth limits. |
| 5 | **Closed.** One core, tested. |
| 6 | **Open.** No signed directory (Phase 5). |

The relay stays parked: no workflow builds or publishes its image, and its ECS
service stays at zero. Item 6, the open half of item 1, and a separate security
review are still required before that changes.
