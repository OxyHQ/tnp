# TNP architecture overview

**Status of this document:** normative. It defines the target architecture.
Where the current code differs, the difference is stated and linked to the phase
that closes it. It never describes an unimplemented thing as working.

---

## What TNP is

TNP — The Network Protocol — is an alternative internet that runs on top of the
existing one: its own namespace, its own edge, and an optional privacy layer.
Three products sharing one network — a namespace (ICANN's role), an edge
(Cloudflare's role), and a secure connection (a VPN's role).

The product direction and the priority order it implies are in
[`product.md`](./product.md). **Read that first** — it is what decides which of
the layers below get built when, and it carries the rule the rest of this
document has to respect: the default path has to feel like normal internet, and
privacy that costs latency is a tier the user chooses.

TNP is **not** only an alternative DNS. Name resolution is one of ten layers.

## What TNP is not

- It is not a replacement for the public internet. Public DNS keeps working, and
  keeps returning the same answers, unless the user explicitly opts a name into
  a TNP override.
- It is not an anonymity network today. Multi-hop onion routing is specified
  (Phase 6) and not implemented. Until it is measured and reviewed, no TNP
  surface may describe TNP as anonymous. See [`privacy-model.md`](./privacy-model.md).
- It is not a domain registrar. Selling, transferring or renewing ICANN domains,
  reseller systems and payment integrations are out of scope.

---

## Layers

Ten layers, each with one responsibility and an explicit interface to its
neighbours. No layer may reach past the one below it.

```
┌──────────────────────────────────────────────────────────────┐
│ 10. Control plane   API · directory · dashboard · diagnostics│
├──────────────────────────────────────────────────────────────┤
│  9. Platform        Linux · macOS · Windows · Android · iOS   │
├───────────────────────────────┬──────────────────────────────┤
│  8. VPN (TUN)                 │  7. Proxy (SOCKS5 · CONNECT) │
├───────────────────────────────┴──────────────────────────────┤
│  5. Onion routing   circuits · layered encryption · guards   │
├──────────────────────────────────────────────────────────────┤
│  4. Transport       connections · streams · frames · flow    │
├──────────────────────────────────────────────────────────────┤
│  3. Discovery       relays · service nodes · exits · keys    │
├──────────────────────────────────────────────────────────────┤
│  2. Resolution      TNP names · public DNS · cache · DNSSEC  │
├──────────────────────────────────────────────────────────────┤
│  1. Naming          TLDs · domains · ownership · records     │
└──────────────────────────────────────────────────────────────┘
   6. Security is cross-cutting: identities, keys, authn/authz,
      rotation, revocation, secure updates. It is not a layer you
      sit on top of — every layer above depends on it directly.
```

| # | Layer | Owns | Must not own |
|---|---|---|---|
| 1 | [Naming](./naming.md) | TLDs, domain records, ownership, expiry, reservations, namespace policy | How a name is looked up at runtime |
| 2 | [Resolution](./resolution.md) | TNP lookups, public DNS forwarding, caching, DNSSEC, record authenticity | Which relay carries traffic |
| 3 | [Discovery](./discovery.md) | The signed directory of relays, service nodes, exits, their keys, capabilities and health | Moving bytes |
| 4 | [Transport](./transport.md) | Connections, streams, multiplexing, framing, flow control, reconnect | Path selection across multiple hops |
| 5 | [Onion routing](./onion-routing.md) | Path selection, incremental circuit build, layered encryption, guards, rotation | The bytes inside a stream |
| 6 | [Security](./security.md) | Identity hierarchy, key exchange, signatures, replay/downgrade defence, rotation, revocation, signed updates | Any policy decision a user should make |
| 7 | [Proxy](./proxy.md) | SOCKS5, HTTP CONNECT, remote name resolution, per-destination rules | Device-wide packet capture |
| 8 | [VPN](./vpn.md) | TUN interfaces, packet classification, routing, split/full tunnel, DNS capture, kill switch | Application-level protocol knowledge |
| 9 | [Platforms](./platforms.md) | OS integration, privileges, background services, install/update/recovery | Protocol or policy logic |
| 10 | Control plane | APIs, directory publication, configuration, status, metrics, admin | Anything that must keep working when it is down |

### The rule that keeps this honest

**Policy is decided once, in portable code, and shared by every platform.** A
routing rule, a namespace decision or a circuit-selection constraint must exist
in exactly one place. If Android and Linux each decide whether a destination is
TNP-native, they will eventually disagree, and the disagreement will be a
security bug. Platform code owns *how* to capture a packet or start a service;
never *what to do* with what it captured.

---

## Current state vs. target

| Layer | Today | Phase that closes the gap |
|---|---|---|
| Naming | Registry works. `.com`/`.app` seeded as TNP TLDs, so public names can be shadowed. | 2 |
| Resolution | TNP lookups work. Public forwarding re-encodes answers incorrectly, hardcodes one DoH endpoint, has no DNSSEC. | 2 |
| Discovery | A relay/service-node directory exists in the API. It is unsigned, and relay registration is broken end to end. | 3, 5 |
| Transport | One WebSocket hop, one unversioned 5-byte frame header, globally-scoped client-chosen circuit IDs, no flow control. | 3 |
| Onion routing | **Not implemented.** `--privacy private` is parsed and ignored. | 6 |
| Security | NaCl primitives are used correctly. No identity binding, no signatures, no replay/downgrade defence, no rotation. | 3, 6 |
| Proxy | SOCKS5 CONNECT to TNP names only. No IPv6, no auth, no public destinations, ignores the requested port. | 4 |
| VPN | **Not implemented.** | 8, 9, 10 |
| Platforms | Linux/macOS/Windows install + service management exist. Mobile does not. | 9, 10 |
| Control plane | API and dashboard work. No metrics, no diagnostics endpoint, no device management. | 1–11 incrementally |

Evidence for every "today" cell is in [`audit-2026-08-06.md`](./audit-2026-08-06.md).

---

## Repository shape

The repository still uses `apps/` rather than the Oxy `packages/` standard, and
`packages/client` is a monolith that owns eight of the ten layers. The target
shape and the phased route to it — no big-bang restructure — are in
[`migration.md`](./migration.md).

---

## Where to go next

- What TNP is trying to be, and in what order → [`product.md`](./product.md)
- What the words mean → [`glossary.md`](./glossary.md)
- What a user can turn on, and what each mode costs them → [`operating-modes.md`](./operating-modes.md)
- Why a public name never changes meaning → [`naming.md`](./naming.md)
- What each party can see → [`threat-model.md`](./threat-model.md), [`privacy-model.md`](./privacy-model.md)
- What ships when → [`roadmap.md`](./roadmap.md)
