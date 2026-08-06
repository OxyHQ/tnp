# TNP glossary

Precise meanings. Where a word is used loosely elsewhere in the repository, this
file wins and the other use is a bug.

---

### Domain

A name registered in the TNP naming layer, written `label.tld` (for example
`example.ox`). A domain identifies a **naming record**, not a host and not a
person. What it points at is decided by its records and by whether a service node
has claimed it.

A domain may simultaneously have DNS records (for clients not using the overlay)
and a service node (for clients that are). They are different delivery paths for
the same name.

### TLD

The last label of a domain. TNP TLDs come in exactly two kinds, and the
distinction is load-bearing (see [`naming.md`](./naming.md)):

- **Native TLD** — exists only inside TNP (`.ox`). TNP is authoritative.
- **Reserved TLD** — a label TNP refuses to serve because the public DNS root
  already owns it (`.com`, `.app`, `.net`, `.org`, `.dev`, …). TNP is never
  authoritative for these.

### Namespace type

```ts
type NamespaceType = "tnp-native" | "public-dns";
```

Every resolution decision produces exactly one of these before any lookup
happens. A `public-dns` name is never answered from TNP data unless the user has
installed an explicit, visible override for that specific name.

### Node

Any participant that runs TNP code and holds a key. Never used unqualified in
code or docs — say which kind:

### Service node

A machine that publishes one or more local services under a TNP domain it
controls. It makes **outbound** connections only, so it works behind NAT with no
port forwarding. It holds the private key that terminates end-to-end encryption
for its domain.

### Relay

A node that forwards frames between other nodes and never terminates the
end-to-end encryption of the payload it carries. Three roles, deliberately
separate — a relay has one or more, never all by default:

- **Transit relay** — forwards between TNP nodes. Sees the previous and next hop.
- **Service relay** — the relay a specific service node is connected to; it is
  the rendezvous point for that domain.
- **Exit node** — the only role that opens connections to the **public**
  internet. Being a relay does not make you an exit; that is a separate opt-in
  with separate policy, separate liability and separate metadata exposure.

### Client

A device running TNP that consumes the network: resolves names, opens circuits,
proxies or tunnels traffic. It is not a relay unless separately configured.

### Circuit

A path from a client through zero or more relays to a terminating node. It has
its own key material and its own lifetime, and carries many streams.

- **Single-hop circuit** — client → service relay → service node. What exists today.
- **Multi-hop circuit** — client → guard → middle(s) → exit or service relay.
  Specified in [`onion-routing.md`](./onion-routing.md), not implemented.

A circuit ID is **scoped to one connection**, not global. Two peers may use the
same numeric ID on different connections without interacting. (The current relay
violates this; see finding S1 in the audit.)

### Stream

One bidirectional byte flow inside a circuit — typically one TCP connection a
user's application opened. Streams are multiplexed over a circuit and have
independent flow-control windows.

### Guard

The first relay in a multi-hop circuit. A client keeps the same small set of
guards for a long time, deliberately: rotating the entry point on every circuit
increases the chance that a hostile relay eventually occupies it.

### Frame

The unit of the transport wire protocol: a versioned header plus a bounded
payload. See [`transport.md`](./transport.md).

### Resolver

The component that answers DNS queries on the device. It answers TNP-native
names from TNP data and forwards everything else, unmodified, to a configured
public upstream.

### Proxy

An **application-level** interception point (SOCKS5 or HTTP CONNECT) that
individual applications opt into by configuration. It does not affect traffic
from applications that were not configured to use it.

### Tunnel / VPN

An **operating-system-level** packet interception point (a TUN interface) that
affects traffic from every application on the device according to a routing
policy.

**A proxy is not a VPN.** No TNP surface — CLI output, dashboard, mobile app,
marketing — may describe proxy mode as a VPN. This is a hard rule, from issue #10.

### Full tunnel

A VPN policy where all traffic matching the policy leaves the device through TNP.

### Split tunnel

A VPN policy where a defined subset — by destination, network or application —
goes through TNP and the rest goes out normally.

### Exit policy

The rules an exit node operator sets: which ports, which destinations, which
address ranges are refused. Published in the directory so clients can select an
exit that will actually accept their traffic.

### Directory

The signed list of relays, exits and their keys, capabilities, versions and
health. Clients must be able to verify it without trusting the transport that
delivered it. (Today's directory is unsigned — Phase 5.)

### Operating mode

A user-selectable capability with its own state, configuration, permissions,
diagnostics and threat model. Enumerated in [`operating-modes.md`](./operating-modes.md).
Modes compose; they are not a single enum.

### Device identity

A keypair created on and never leaving one device, authorized by the user's Oxy
identity. It is the thing that gets revoked when a device is lost. The Oxy
identity's own key is **never** used as a transport key.

### Node key

An operational keypair, authorized by a device identity, used by a service node
or relay to prove which node it is. Rotatable without touching the device or Oxy
identity.

### Session key

A short-lived symmetric key derived per circuit or per hop. Never persisted.
