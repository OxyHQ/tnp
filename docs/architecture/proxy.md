# Proxy

Application-level interception. Applications opt in by configuration; traffic
from applications that were not configured is untouched.

**A proxy is not a VPN.** No CLI output, dashboard string, app screen or
marketing copy may describe proxy mode as a VPN. Hard rule, from issue #10.

**Status: partial.** SOCKS5 CONNECT reaches TNP names only. Detail in §5.

---

## 1. SOCKS5 (RFC 1928)

Required:

| Feature | Note |
|---|---|
| `CONNECT` | The core command |
| `ATYP=0x03` domain names | Passed through unresolved so the name is resolved **remotely**, at the tunnel's far end. This is what prevents a DNS leak before the connection exists. |
| `ATYP=0x01` IPv4 | |
| `ATYP=0x04` IPv6 | Currently missing entirely |
| Username/password auth (RFC 1929) | Required for any non-loopback listener; optional on loopback |
| Loopback-only bind by default | Binding a no-auth SOCKS proxy to `0.0.0.0` turns the host into an open proxy |
| Correct failure replies | `0x07` command not supported, `0x08` address type not supported, `0x04` host unreachable, `0x05` connection refused. Never hang. |
| The requested port | Must be honoured. Currently parsed and discarded. |
| Half-close | `FIN` in one direction shuts down that direction only |
| Idle timeout, cancellation | Per-connection, configurable |
| Backpressure | Pause the local socket when the circuit window is exhausted |
| 100+ concurrent streams | Tested, not assumed |

**`UDP ASSOCIATE` must not be advertised until real UDP transport exists.**
Advertising it and failing is worse than not advertising it: applications fall
back correctly when a proxy declines UDP, and fail confusingly when it accepts
and then drops.

## 2. HTTP CONNECT

Same routing, same rules, for applications that speak HTTP proxying but not
SOCKS5.

- `CONNECT host:port HTTP/1.1` → `200 Connection Established` → raw tunnel.
- `Proxy-Authorization` required on non-loopback listeners.
- Correct error statuses: `403` for a policy refusal, `502` for an upstream
  failure, `504` for a timeout.
- Plain (non-CONNECT) HTTP proxying is **not** supported. It requires parsing and
  rewriting user traffic, which is exactly what a privacy tool should not do.

## 3. Routing policy

Every connection is classified once, by the same portable policy engine the VPN
uses. One implementation, one answer.

| Destination class | Default |
|---|---|
| TNP-native name | Through the overlay to its service node |
| Public destination, exit configured | Through the overlay to the selected exit |
| Public destination, no exit | Direct, or refused — user's configured choice, never a silent fallback |
| Explicit bypass rule | Direct |
| Loopback and private ranges | Direct, never through the overlay |

Rules are ordered, first-match, and expressible over: exact name, name suffix, IP
prefix, port, and — where the platform can attribute a connection — application.

A bypass list must be **explicit**. A silent "if TNP fails, go direct" is a
downgrade attack the user cannot see.

## 4. Diagnostics

`tnp status` and the dashboard must report, per proxy listener: whether it is
listening, on what, how many active streams, per-destination-class counts, recent
error codes with counts, and the current routing rule set.

Diagnostics must not log individual destination names by default. Aggregate
counts by class; log a name only when the user explicitly enables verbose
diagnostics, and say so when they do.

## 5. Current implementation gaps

From the [audit](./audit-2026-08-06.md), all in `packages/client/src/socks.ts`:

1. **Public destinations are unreachable.** If a name has no TNP service node the
   proxy replies "host unreachable". `curl --proxy socks5h://…` to a public site
   fails outright.
2. **No IPv6.** `ATYP=0x04` returns `null` from the request parser.
3. **The requested port is ignored.** It is parsed and never used; traffic always
   goes to whatever single target the service node configured.
4. **Unsupported commands hang.** `parseRequest` returns `null` for a non-CONNECT
   command or an unknown address type, and `null` means "need more data", so the
   connection stalls until the client times out instead of getting `0x07`/`0x08`.
5. **Pipelined bytes are dropped.** After the greeting, `handleConnection` resets
   the buffer to empty (`socks.ts:94`), discarding any request bytes that arrived
   in the same TCP segment. Clients that send greeting and request separately —
   most, including curl — work; clients that pipeline break.
6. **No authentication and no bind restriction.** The listener binds to whatever
   `listenAddr` says with no auth in any case.
7. **No backpressure, no idle timeout, no half-close.** Both pump directions run
   unbounded (audit S6).
8. **No tests.** Nothing in the suite exercises the SOCKS server at all.

Phase 4 rewrites this file against RFC 1928 with a conformance test suite.
