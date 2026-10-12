# Service nodes

A service node publishes local services under a TNP domain, using outbound
connections only — no public IP, no port forwarding, no inbound firewall rule.

```bash
tnp serve example.ox --target http://127.0.0.1:8080
```

**Status: implemented for one relay per node; not deployed** (the relay is
parked, [`relays.md`](./relays.md) §8). Key binding to the domain owner,
authentication to the relay, end-to-end sessions and backpressure are in
place (audit S2, S3, S6 closed in code). Multiple relays per node, per-port
targets, directory revocation and access control are not.

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

Steps 2–4 are what make an end-to-end guarantee real. The node used to generate a
throwaway X25519 key at every start and `POST` it to the API, which handed it to
whoever asked with nothing signed and nothing verified (audit S3).

**As implemented** (`packages/client/src/service-node.ts`,
[`security.md`](./security.md) §1 "Domain keys and pinning"):

1. `tnp serve --domain <name>` with an Oxy token (`TNP_TOKEN` or
   `--token-stdin`).
2. Domain control: the registry checks ownership on every write. On the owner's
   device the first run creates the **domain key** (or uses the one from
   `tnp domain key init`) and registers it with `POST /domain-keys`.
3. Node key: loaded or created per name. Its grant comes from the local domain
   key (issued and renewed automatically), or from a grant file the owner
   issued on another device (`tnp domain grant`). The node certifies an X25519
   key with its node key (≤ 7 days, renewed with 4 days left).
4. Publish: `POST /nodes/register` with the grant chain and certificate; the
   registry verifies them against the domain key. The Oxy identity is not in
   the chain — the domain key is the root.
5. Relay: `--relay`, or an Oxy-operated relay from the (unsigned) directory.
6. Connect out to `<relay>/service` and answer its challenge
   (transport.md §6.1).
7. Serve circuits: Noise NK responder per `CIRCUIT_CREATE`, then sealed
   `OPEN` → connect to the target → sealed `OPENED` or `RESET`.
8. Heartbeat every 30 s while attached.
9. Reconnect with backoff and jitter.

A client verifies the chain from the X25519 key to the domain key it pinned
before deriving a session key, so the registry cannot substitute a key for a
name the client has used before; on first contact it still can
([`threat-model.md`](./threat-model.md)).

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
  **Not yet:** a node has one target and every requested port reaches it. The
  port now travels sealed inside the circuit (transport.md §11.2), so the relay
  never learns it, and the node receives it, but does not route on it.
- Targets must be explicitly listed. A node never forwards to an arbitrary
  address a peer names; that would make every service node an open proxy.
- Loopback and private-range targets are the normal case here and are allowed —
  this is the deliberate opposite of exit-node policy, because the operator chose
  these targets themselves.

## 3. Authentication and authorization

| Check | Enforced by | Today |
|---|---|---|
| The user owns the domain | API, with the user's own credential | ✅ (`routes/nodes.ts`) |
| The node key is authorized by the domain owner | Grant chain rooted at the name's domain key (no device key) | ✅ registry verifies on `/nodes/register`; relay and client verify independently |
| The relay accepts only an authenticated node for a domain | Relay challenge (transport.md §6.1) | ✅ — and a second node with a different key does **not** evict the incumbent (`ALREADY_REGISTERED`) |
| The client verifies the node key belongs to the domain | Chain + certificate in the resolve overlay, against the client's pinned domain key | ✅ for pinned names; first contact trusts the registry's domain key |
| A retired node stops being accepted | Domain-key rotation | ✅ rotating the domain key retires every node under the old one (relays re-check every 10 min) |
| One revoked node stops being accepted without a rotation | Directory revocation | ❌ no directory |

## 4. Access control

Per published service:

- Allow/deny by client identity, where the client authenticates.
- Per-client and per-service rate limits and concurrent-stream caps.
- Bounded queues; backpressure applied to the local socket when a circuit's
  window is exhausted. **Implemented**: the target socket is paused when the
  circuit's end-to-end credit runs out or the relay connection's buffer is
  above 1 MiB, and credit goes back to the client only once the target socket
  has taken the bytes.
- Maximum concurrent circuits, with new circuits refused rather than queued
  indefinitely once the cap is hit. **Implemented**: 256 per node
  (`RESOURCE_EXHAUSTED`).
- Malformed input from the relay costs at most one circuit: every codec is
  length-checked and the frame handler cannot throw into the process.

Allow/deny lists and per-client limits are not implemented (clients have no
identity at the network layer).

## 5. Reconnection

- Exponential backoff with **jitter** and a cap. Backoff without jitter turns a
  relay restart into a synchronized reconnect storm. **Implemented**: 2 s
  doubling to 60 s, ±50% jitter; 5 minutes after `ALREADY_REGISTERED`.
- Connect to more than one relay so a single relay failure is not an outage.
  **Not implemented**: one relay per node.
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
| Its relay | That the node is connected, for which domain (the routing name in every circuit), when circuits open and close, and the traffic volume. Not content, not the requested port, not errors. |
| Clients | Whatever the published service returns. |
| The node operator | The content of every circuit — the node terminates the end-to-end encryption. |
| Oxy | That the domain has an active node, and which relays it uses. |

A client's IP is **not** visible to the service node: the relay sits between them.
Operators who need per-client identity must authenticate at the application layer,
not infer it from the network.
