# Exit nodes

An exit node accepts traffic from TNP circuits and opens connections to the
**public internet**.

**Status: not implemented.** Phase 7.

**An exit is never automatic.** Being a relay does not make a node an exit.
Separate opt-in, separate policy, separate published metadata, separate
liability.

---

## 1. What the operator sees, stated plainly

Every destination address and port, and the full content of anything not
protected by application-layer encryption.

This is inherent to the role. It is not a defect and it is not fixable by TNP.
It must appear:

- in the operator consent flow, before anyone becomes an exit,
- in the client's exit picker, before a user selects one,
- in [`privacy-model.md`](./privacy-model.md).

## 2. Responsibilities

1. Terminate the last circuit layer.
2. Resolve destination names according to the selected policy.
3. Open TCP connections; UDP where supported.
4. Enforce the published exit policy.
5. Enforce rate and resource limits.
6. Refuse destinations that would attack the operator's own network.
7. Publish capacity, approximate jurisdiction and operator terms.
8. Keep aggregate metrics only.

## 3. SSRF and private-network protection

An exit is a request-forwarding service reachable by strangers. Without these
rules it is a tool for attacking the operator's own infrastructure and the
network it sits in. All are mandatory.

**Blocked destination ranges** — checked after resolution, on the resolved
address, never only on the requested name:

| Range | |
|---|---|
| `127.0.0.0/8`, `::1/128` | Loopback |
| `10/8`, `172.16/12`, `192.168/16` | RFC 1918 |
| `100.64/10` | CGNAT |
| `169.254/16`, `fe80::/10` | Link-local |
| `fc00::/7` | Unique local |
| `224/4`, `ff00::/8` | Multicast |
| `0.0.0.0/8`, `240/4`, `::/128` | Reserved |
| Cloud metadata endpoints (`169.254.169.254`, and the IPv6 equivalents) | Credential theft |
| The operator's own configured networks | Operator-defined |

**Rebinding defence:** resolve, check, then **connect to the checked address**.
Resolving a name, checking it, and then connecting by name again lets a DNS
rebinding attack slip a private address between the two steps.

**Redirects are not followed** by the exit — it is a byte forwarder, not an HTTP
client. Redirect handling belongs to the application.

## 4. Exit policy

Published in the directory so a client can pick an exit that will accept its
traffic, rather than discovering the refusal by failing.

```
allow  tcp 80,443
allow  tcp 22
deny   tcp 25          # SMTP — spam
deny   tcp 445,139     # SMB
deny   udp *           # until UDP support exists
deny   ipv4 10.0.0.0/8
```

Defaults refuse: SMTP (25, 465, 587), SMB, and anything the operator has not
allowed. Default-deny, not default-allow.

## 5. Limits

Per circuit and per exit: concurrent connections, connection rate, bandwidth,
connection lifetime, DNS query rate. All operator-configurable within
protocol-defined bounds.

## 6. Abuse handling

- Operators publish a contact and their terms.
- Complaints are answerable **only** from what the operator is permitted to
  retain (aggregates and policy-refusal counts) — which is deliberately little.
  That limit is stated up front, in the operator onboarding, so nobody becomes an
  exit expecting to be able to answer questions they cannot.
- An operator may refuse specific identities and may withdraw the exit role at any
  time without giving up the transit role.
- Repeated abuse from an authenticated identity is handled at the identity layer
  by Oxy, not by exits retaining more data.

## 7. Client-side selection

The client chooses; the API does not choose for it.

Inputs: policy compatibility with the intended destination, health, capacity
headroom, measured latency, approximate jurisdiction, and the user's own
inclusion and exclusion lists (by operator, by jurisdiction, by node).

An exit that fails for a client is downweighted by that client immediately,
without waiting for the directory.

## 8. Honesty requirements

- The exit picker states what the exit operator can see, at the point of choice.
- No claim that traffic through an exit is anonymous.
- Traffic that was not encrypted before it entered TNP is not encrypted when it
  leaves. Say so where a user will read it.
