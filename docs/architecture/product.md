# What TNP is, as a product

**Status: product direction. Sets the priority order the roadmap follows.**
Nothing here describes something that works today unless it says so.

---

## The goal

An alternative internet that runs on top of the existing one, with its own
namespace, its own edge, and an optional privacy layer. Three products sharing
one network:

| | Comparable to | State |
|---|---|---|
| **Namespace** — TNP's own TLDs, registration, DNS records | ICANN + a registrar | Works |
| **Edge** — publish a service, TNP fronts it, origin IP never exposed | Cloudflare (Tunnel, reverse proxy, CDN) | Prototype |
| **Secure connection** — device-wide tunnel, user-selectable privacy level | A consumer VPN | Not implemented |

The three are not alternatives. A domain registered in the namespace is served
through the edge, and a device on the secure connection reaches it over the same
network.

## The rule that shapes everything below

**The default has to feel like normal internet.** Not "fast for an overlay" —
fast. A user who installs TNP and opens a `.ox` site should not be able to tell
they are on an overlay, and their public browsing should be untouched.

Privacy that costs latency is a **tier the user chooses**, never the default
path. This is the single most important consequence for the architecture:
anything that adds hops, padding or indirection belongs behind an explicit
setting, and the fast path must stay the fast path.

---

## Privacy tiers

One setting, two meanings, chosen by the user. Both are real modes with real
guarantees — see [`privacy-model.md`](./privacy-model.md) for what each one does
and does not protect against.

### Standard (default)

Like a normal home connection with a CDN in front.

- TNP names resolve natively; public names resolve exactly as they would
  without TNP.
- A TNP service is reached through **one** relay hop.
- Traffic is encrypted end to end between the client and the service node, so
  the relay carries bytes it cannot read.
- The service's origin IP is never exposed to the client.
- Latency target: one extra hop, nothing more.

**What the relay can see:** your IP, which service you reached, when, and how
much. Not the contents. If that matters to the user, they pick the tier below.

### Private (opt-in)

For users who want their access pattern hidden, accepting the cost.

- Multi-hop circuits: no single relay knows both who you are and what you
  reached ([`onion-routing.md`](./onion-routing.md)).
- Slower by construction — at least three round trips instead of one.
- Not anonymity. The wording rules in [`privacy-model.md`](./privacy-model.md)
  §6 apply in full, at every tier.

**Not implemented.** `--privacy private` is rejected rather than silently
downgraded, and stays rejected until Phase 6 makes it real.

### Where the tier applies

The tier is a property of how traffic is carried, so it applies to proxy mode
and to tunnel mode alike. It does **not** apply to resolver mode: name
resolution has its own privacy story (public names never touch TNP at all).

---

## The edge

The part that is least covered by the rest of these documents, and the one
closest to being a product.

A service node connects **outward** to a relay and publishes a domain. Clients
reach the domain through the relay. That is already Cloudflare Tunnel's shape:
no public IP, no inbound port, no firewall change, origin address never
disclosed.

What a comparable product needs on top, none of it implemented:

| Capability | Why it matters | Where it lands |
|---|---|---|
| Geographic edge presence | One relay in one region is a latency tax on everyone else. Selection has to prefer a near relay. | Phase 5 (discovery, selection) |
| Response caching at the relay | The difference between a tunnel and a CDN. Needs a cache-control story, and a decision about what a relay may hold. | Not yet scheduled |
| TLS termination or passthrough | Today the relay carries an opaque stream. A CDN that terminates TLS holds the certificate — a trust change that has to be deliberate, and interacts with the E2E guarantee above. | Not yet scheduled |
| DDoS absorption | The reason origins hide behind a CDN. Needs relay-side rate limiting and capacity well beyond one host. | Phase 3 (limits), Phase 5 (capacity) |
| Health checks and failover | A single relay outage must not take a domain offline. | Phase 3 (reconnect), Phase 5 (failover) |
| Multiple origins per domain | Load spreading, and rolling deploys without downtime. | Phase 3 |

**An honest note on caching and TLS.** They pull against the end-to-end
encryption the standard tier promises: a relay that caches responses or
terminates TLS can read them. That is the trade every CDN makes, and it is
legitimate — but it must be an explicit per-domain choice by the domain owner,
stated in the dashboard, and reflected in the privacy model. It must not arrive
as a quiet default.

---

## Namespace, and the line that does not move

TNP has its own TLDs and its own registry. It is authoritative for those and
only those.

It is **not** authoritative for `.com`. An alternative internet needs its own
namespace, not a reinterpretation of somebody else's: a `.com` that means one
thing with TNP installed and another without it is not a feature, it is a
name-resolution bug that users cannot diagnose. This is enforced in code and
tested — see [`naming.md`](./naming.md).

The two ideas are compatible, and worth stating together because they sound
opposed: **TNP's namespace is fully its own, and public DNS is untouched.**

---

## Priority order this implies

The fast path is on the critical path for both the edge product and the secure
connection. It comes first.

| Order | Work | Serves |
|---|---|---|
| 1 | **Transport** — authenticated, isolated circuits, flow control, reconnect (Phase 3) | Everything. Nothing is a product until this is sound. |
| 2 | **Proxy** — reach a TNP service from a real application (Phase 4) | Edge, and the first usable client |
| 3 | **Discovery** — signed directory, multiple relays, selection by latency (Phase 5) | Edge (geography, failover), and a precondition for privacy |
| 4 | **VPN, standard tier** — device-wide, fast path (Phases 8–10) | Secure connection |
| 5 | **Exit nodes** (Phase 7) | VPN to the public internet |
| 6 | **Private tier** — multi-hop (Phase 6) | The privacy option |

Note that **6 depends on 5 being real**: a device-wide tunnel that reaches the
public internet through a single hop lets the exit see every destination tied to
the user's IP — worse than the user's own ISP. Once exits exist, multi-hop stops
being optional for anyone who selects the private tier.

The one reordering against the original roadmap: exits before onion, because the
VPN product needs exits and the standard tier is honest about what an exit sees.

---

## Distance between this and today

Stated plainly, because the gap is large and the roadmap should not read as if
it were small:

- The production API is **down**, and its deploy workflow has never succeeded
  (#29).
- `tnp relay` **cannot register** — the client and API disagree on the request
  body (audit B2). There is no relay network, and no community relay has ever
  run.
- The relay accepts an unauthenticated socket claiming any domain, and evicts
  the incumbent (audit S2).
- The API can substitute a service node's key, so the end-to-end guarantee the
  standard tier depends on is not yet real (audit S3).
- There is one relay implementation, duplicated, with no limits, no
  authentication and no circuit isolation.

The namespace works and DNS is now correct. The edge is a prototype with a
critical authentication gap. The secure connection does not exist.
