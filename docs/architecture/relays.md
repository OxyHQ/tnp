# Relays

A relay forwards frames between TNP nodes. It never decrypts payloads, never
stores traffic, and never reaches the public internet — that last one is a
separate role with separate consent ([`exit-nodes.md`](./exit-nodes.md)).

**Status: prototype, and registration is broken.** See §7.

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

## 2. Registration

1. The operator authenticates with Oxy.
2. The relay generates a node key, authorized by the operator's device identity.
3. It registers its endpoint, roles, capacity, protocol versions and capabilities.
4. Oxy verifies reachability and publishes it in the **signed** directory.
5. It heartbeats; missing heartbeats degrade then remove it.

Registration is authenticated at both ends: the API authenticates the operator,
and clients authenticate the relay by its directory-published key during the
handshake. A relay that is not in the signed directory is not selectable.

## 3. Resource control

Every one of these is currently absent and every one is a single-client
denial-of-service path against a shared relay (audit S6).

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

## 4. Circuit isolation

**Circuit IDs are scoped to the connection that created them.** Two connections
may use the same numeric ID with no interaction. A frame is dispatched only
within the circuits belonging to the socket that sent it.

This is the fix for audit finding S1, which is the most severe defect in the
current transport: `apps/relay/src/connections.ts` keeps one global
`Map<number, Circuit>`, `handleClientMessage` looks up a client-supplied ID with
no ownership check, and `TunnelManager.nextCircuitId` starts at `1` in every
client process. Two honest clients collide immediately; a hostile one can close
or disrupt another client's circuits by guessing a small integer. The embedded
relay in `packages/client/src/relay-node.ts` has the identical defect.

## 5. What a relay may and may not keep

**May keep:** aggregate counters — circuits opened, bytes forwarded, errors by
code, uptime, version, current load.

**Must not keep:** per-circuit records, client IP logs beyond the life of a
connection plus a short bounded abuse window, destinations, payloads, or anything
that reconstructs who talked to whom.

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
| **Registration is non-functional** | The client sends `{port, location}`; the API requires `{endpoint, publicKey, operator, capacity}`. Heartbeat mismatches the same way. Every call 400s and `tnp relay` aborts at startup (B2). |
| **No authentication** | `/service?domain=x` and `/tunnel` upgrade with no handshake at all (S2). |
| **Domain takeover** | Registering a domain evicts the incumbent service node and its circuits (S2). |
| **Global circuit IDs** | §4 above (S1). |
| **No limits** | No frame cap, no quotas, no backpressure, unbounded tables (S6). |
| **Duplicated implementation** | `apps/relay` and `packages/client/src/relay-node.ts` implement the same routing twice, with the same bugs twice. |
| **Unsigned directory** | Clients cannot verify a relay is legitimate. |
| **No tests** | Nothing exercises the relay. |

Phase 3 fixes authentication, circuit scoping and limits, and collapses the two
implementations into one `@tnp/relay-core` that both the standalone server and
the embedded relay consume. Phase 5 adds the signed directory, health, peering
and selection.
