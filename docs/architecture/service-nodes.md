# Service nodes

A service node publishes local services under a TNP domain, using outbound
connections only — no public IP, no port forwarding, no inbound firewall rule.

```bash
tnp serve example.ox --target http://127.0.0.1:8080
```

**Status: partial.** The connect-out-and-reconnect model works. Authentication,
key binding and resource limits do not (audit S2, S3, S6).

---

## 1. Lifecycle

```
1. Authenticate with Oxy
2. Prove domain control          — the API confirms the caller owns example.ox
3. Load or create the node key   — authorized by this device's identity
4. Publish                       — the node key is written into the domain's
                                   signed record set, chained to the owner
5. Select relays                 — from the signed directory
6. Connect out                   — TLS, authenticated handshake, per relay
7. Serve                         — accept circuits, forward to local targets
8. Heartbeat                     — liveness in the directory
9. Reconnect                     — exponential backoff with jitter on failure
```

Steps 2–4 are what make an end-to-end guarantee real. Today the node generates a
throwaway X25519 key at every start and `POST`s it to the API, which hands it to
whoever asks with nothing signed and nothing verified (audit S3). Under the
target design the client verifies a chain from the transport key to the domain
owner's Oxy identity before deriving a session key, so the API cannot substitute
a key without the client noticing.

## 2. Targets

A node may publish several services:

```bash
tnp serve example.ox \
  --target http://127.0.0.1:8080 \
  --target tcp://127.0.0.1:5432@5432
```

- TCP targets from day one; UDP when the transport supports it.
- The **requested port is honoured** — a stream to `example.ox:5432` reaches the
  target bound to 5432, not to whichever single target happened to be configured.
  The current implementation ignores the requested port entirely.
- Targets must be explicitly listed. A node never forwards to an arbitrary
  address a peer names; that would make every service node an open proxy.
- Loopback and private-range targets are the normal case here and are allowed —
  this is the deliberate opposite of exit-node policy, because the operator chose
  these targets themselves.

## 3. Authentication and authorization

| Check | Enforced by | Today |
|---|---|---|
| The user owns the domain | API, with the user's own credential | ✅ (`routes/nodes.ts`) |
| The node key is authorized by an owner-authorized device | Grant chain | ❌ |
| The relay accepts only an authenticated node for a domain | Relay handshake | ❌ — the relay accepts any socket claiming any domain and **evicts the incumbent** (audit S2) |
| The client verifies the node key belongs to the domain | Signed record set | ❌ |
| A revoked device's nodes stop being accepted | Directory revocation | ❌ |

Row 3 is the most urgent: an attacker connects to a relay with
`?domain=victim.ox` and takes over that name's routing on that relay, today.

## 4. Access control

Per published service:

- Allow/deny by client identity, where the client authenticates.
- Per-client and per-service rate limits and concurrent-stream caps.
- Bounded queues; backpressure applied to the local socket when a circuit's
  window is exhausted. Neither pump pauses today (audit S6).
- Maximum concurrent circuits, with new circuits refused rather than queued
  indefinitely once the cap is hit.

## 5. Reconnection

- Exponential backoff with **jitter** and a cap. Backoff without jitter turns a
  relay restart into a synchronized reconnect storm.
- Connect to more than one relay so a single relay failure is not an outage.
- Circuit resumption where the security layer says it is replay-safe; otherwise a
  clean rebuild.
- The heartbeat is what removes the node from the directory when it dies, so its
  interval and the directory's staleness window must be chosen together.

## 6. Operations

- Runs as a system service (systemd, launchd, Windows service).
- Config persists; `tnp serve` with no arguments resumes what was configured.
- `tnp status` reports, independently: Oxy auth, domain verification, relay
  connections, active circuits, target reachability, and the last error per
  category.
- Metrics: circuits, bytes, errors by code, reconnects, target latency.
  **Never** request contents, and never per-client request logs by default.
- Remote revocation: revoking the device from the dashboard stops the node from
  being accepted by relays within the directory's propagation window.

## 7. What a service node exposes

Honest statement for operators:

| Party | Sees |
|---|---|
| Its relay | That the node is connected, for which domain, and the traffic volume. Not content. |
| Clients | Whatever the published service returns. |
| The node operator | The content of every circuit — the node terminates the end-to-end encryption. |
| Oxy | That the domain has an active node, and which relays it uses. |

A client's IP is **not** visible to the service node: the relay sits between them.
Operators who need per-client identity must authenticate at the application layer,
not infer it from the network.
