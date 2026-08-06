# Onion routing

**Status: specification only. Nothing here is implemented.** There is no
multi-hop code in the repository. `tnp connect --privacy private` today parses
the flag and builds an ordinary single-hop circuit (audit B5). Phase 1 makes that
flag fail loudly; Phase 6 implements this document.

---

## 1. Goal, stated precisely

No single relay learns both who the client is and what they are reaching.

That is the whole claim. It is not anonymity. See
[`privacy-model.md`](./privacy-model.md) for what this does and does not buy.

## 2. Circuit shape

```
client → guard → middle → exit                    (public internet)
client → guard → middle → service relay → node    (TNP service)
```

Three hops by default. Each hop knows only its immediate neighbours. The client
holds independent key material with every hop.

| Hop | Knows |
|---|---|
| Guard | Client IP; that it is TNP. Not the destination. |
| Middle | Previous and next hop. Neither endpoint. |
| Exit | Destination. Not the client IP. |
| Service relay | Which service node. Not the client IP. |

## 3. Incremental construction

The circuit is built one hop at a time, through the hops already established.
This is what keeps each hop ignorant of the rest — a client that handed the full
path to the guard would have told the guard the destination.

```
1. client ──CIRCUIT_CREATE(ephemeral_1)──▶ guard
   client ◀─CIRCUIT_CREATED(pk_1, tag)──── guard          → key K1

2. client ──[K1]{CIRCUIT_EXTEND(middle, ephemeral_2)}──▶ guard
                                          guard ──CREATE──▶ middle
                                          guard ◀─CREATED── middle
   client ◀─[K1]{CIRCUIT_EXTENDED(pk_2, tag)}──────────── guard   → key K2

3. same shape, one hop further                                    → key K3
```

Every hop's key is derived by X25519 with a fresh ephemeral from the client and
the hop's directory-published key, run through HKDF with a per-hop, per-direction
purpose label. The `tag` is a key-confirmation value the client verifies before
extending further — extending through a hop whose key you have not confirmed
means extending through an attacker.

## 4. Layered encryption

Outbound, the client wraps innermost-first and strips outermost-first inbound:

```
send:     E_K1( E_K2( E_K3( payload ) ) )
guard:    strips K1  → forwards E_K2(E_K3(payload))
middle:   strips K2  → forwards E_K3(payload)
exit:     strips K3  → payload
```

Each layer is an AEAD with its own key, its own direction, and its own monotonic
counter. A layer that fails authentication destroys the circuit; it is never
forwarded on the chance that the next hop can make sense of it.

**All cells are the same size** on the wire between relays. Variable-size relay
cells leak the plaintext length through every hop, which defeats much of the
point. Padding to a fixed cell size is not optional.

## 5. Guards

Rotating the entry point on every circuit maximizes the chance that a hostile
relay eventually occupies it. So the client keeps a small persistent guard set.

- 2–3 guards, chosen once and persisted.
- Rotated on a long randomized schedule, or immediately if a guard is revoked,
  fails persistently, or drops below health thresholds.
- Guard choice is not influenced by the destination — otherwise the guard set
  leaks the destination pattern.
- Guard state persists across restarts. A client that re-picks guards at every
  launch has no guards.

## 6. Path selection

Constraints, all mandatory:

- No operator appears twice in one circuit.
- No two hops in the same /16 (v4) or /32 (v6).
- Every hop must be directory-listed, unrevoked, healthy, and protocol-compatible.
- The exit must accept the destination under its published policy — checked
  *before* building, not discovered by failure.
- Selection is weighted by capacity so the network is usable, but weighting must
  not let a single high-capacity operator dominate; cap any one operator's share.

## 7. Lifecycle

- Circuits are pre-built and kept warm. Building a circuit per small request is
  both slow and a correlation signal.
- A circuit has a maximum age and a maximum stream count; whichever is hit first
  retires it.
- Retirement is graceful: no new streams, existing streams finish, then destroy.
- **Stream isolation**: streams to different destinations should not share a
  circuit where the cost is acceptable, so one hostile exit cannot link a user's
  destinations. The default isolation granularity is a policy decision that must
  be documented and measured.
- Destroying a circuit zeroes its key material.

## 8. Padding

Optional, opt-in, and honestly labelled.

- Circuit-level cover traffic (`CIRCUIT_PADDING`) at a configurable rate.
- Padding raises the cost of volume analysis. It does not defeat a global
  observer, and the product must not imply it does.
- The bandwidth/benefit trade-off must be **measured** before a default is set
  (threat model §7.4).

## 9. What this deliberately does not copy from Tor

Tor's principles are the right starting point — telescoping construction, guards,
layered AEAD, fixed cells, directory diversity. Its specifics are not
transplanted wholesale:

- TNP's service-node rendezvous is a different problem from Tor's hidden
  services: TNP names are registered in an authenticated registry with owner
  identities, so a signed record set can publish the node's key directly. TNP
  does not need Tor's descriptor/introduction-point machinery, and copying it
  would add complexity without a matching requirement.
- TNP relays have authenticated operator identities via Oxy, which changes the
  Sybil calculus and lets the directory carry operator diversity as a first-class
  fact.
- TNP's transport is a stream protocol with flow control from the start, so
  circuit-level congestion is handled by the transport's windows rather than a
  separate mechanism.

Where a Tor design element solves a problem TNP also has, use it and say so.
Where it solves a problem TNP does not have, leave it out.

## 10. Blocking conditions

Private mode does not ship until all of these hold:

1. The directory is signed and diverse ([`discovery.md`](./discovery.md)).
2. Anonymous client authentication to guards is designed and implemented
   (threat model §7.1) — otherwise the guard has the user's identity and the
   first hop is pointless.
3. Frame-level replay and downgrade defences are in place.
4. Fuzzing and adversarial integration tests pass, including hostile relays at
   each position.
5. External cryptographic review is complete.
6. [`privacy-model.md`](./privacy-model.md) is updated with **measured** results,
   not intentions.
