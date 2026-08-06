# Discovery

How a client learns which relays, service nodes and exits exist, what keys they
hold, and whether they are usable.

**Status: partial.** A relay and service-node directory exists in the API. It is
**unsigned**, relay registration is broken end to end (audit B2), and there is no
health, capability or version data. Phases 3 and 5.

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
attacker relays (threat-model adversary 5).

## 3. Distribution

- Primary: fetched from the API, verified by signature, cached locally with its
  validity window.
- The cached copy is used when the API is unreachable, until it expires.
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
