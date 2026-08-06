# Roadmap

Twelve phases. **Every phase leaves the repository runnable and tested.** No
phase begins before the previous one's exit criteria are met — a half-finished
transport under a half-finished proxy is how a system becomes unfixable.

**Ordering is set by [`product.md`](./product.md), not by this list's numbering.**
The fast path serves both the edge product and the secure connection, so it
comes first; exit nodes (7) now precede onion routing (6), because the VPN needs
exits and multi-hop only becomes mandatory once an exit exists to see every
destination.

Phase 0 is complete: [`audit-2026-08-06.md`](./audit-2026-08-06.md).

---

## Phase 0 — Audit ✅

Full repository review, gates run, component map, findings, honest state of every
claim. Complete.

## Phase 1 — Architecture and honesty

This document set, plus the changes that stop the code from lying today.

- Architecture docs, glossary, operating modes, namespace policy, versioned
  protocol spec, security model, initial threat model, roadmap.
- README corrected — it currently says TNP is "DNS-only" and "does not act as a
  VPN" while shipping a SOCKS5 proxy, an overlay transport and a service-node
  mode.
- `AGENTS.md` corrected — it claims a CI typecheck gate that does not exist.
- **`--privacy private` rejected with a clear error** until Phase 6. Silently
  giving single-hop routing to a user who asked for private routing is the worst
  outcome available.
- CI added: typecheck and test every workspace on every PR. Nothing today runs
  either.

**Exit criteria:** docs match code; no shipped surface makes a claim the code
does not support; CI gates every workspace.

## Phase 2 — Namespace and DNS

Closes issue #7. Depends on Phase 1.

- Reserved-TLD enforcement in the API; `.com` and `.app` removed from the seed.
- Offline, deterministic name classification in the client.
- Installers capture native TLDs only, and clean up `/etc/resolver/com` and
  `Domains=~.` on upgrade.
- Replace hand-rolled DNS serialization with a standards-compliant layer:
  correct RCODEs, correct RDATA per type, EDNS(0), truncation, CNAME chains,
  compression.
- Configurable upstreams (classic, DoT, DoH) that are actually read.
- DNSSEC validation for public names.
- TTL-respecting cache with negative caching and bounded size.
- Extract `@tnp/resolver`; `apps/dns-server` consumes it instead of reaching into
  `packages/client` by relative path.
- Signed record sets for TNP-native answers.
- Migration M1–M3 from [`naming.md`](./naming.md) §6.

**Exit criteria:** a public name resolves identically with and without TNP,
proven by test; UDP/TCP/IPv4/IPv6/CNAME/MX/TXT/NXDOMAIN/timeout/cache-expiry
tests pass; fuzz target for the DNS parser runs in CI.

## Phase 3 — Transport, single hop

Closes issue #8. Depends on Phase 2.

- Implement protocol v1 ([`transport.md`](./transport.md)) as a clean cut across
  client, relay and service node.
- Authenticated handshake with transcript signing; nothing processed before
  `AUTH_OK`.
- **Connection-scoped, CSPRNG circuit IDs** — closes audit S1.
- **Authenticated service-node registration** — closes audit S2.
- **Key hierarchy and signed key publication** — closes audit S3.
- Replay counters and downgrade detection — closes audit S5.
- Frame limits, bounded queues, two-level flow control — closes audit S6.
- Structured error codes.
- Reconnect and circuit resumption.
- Collapse `apps/relay` and `packages/client/src/relay-node.ts` into
  `@tnp/relay-core`.
- Fix relay registration (audit B2).

**Exit criteria:** two NAT'd machines publish and reach an HTTP service through a
relay for 24 h under reconnect testing; concurrent circuits are provably
isolated; integration tests cover malformed frames, oversized payloads, auth
failures, reconnects and concurrency; frame parser fuzzed in CI.

## Phase 4 — Proxy

Closes issue #9. Depends on Phase 3.

- SOCKS5 rewritten to RFC 1928: IPv6, correct failure replies, honoured port,
  half-close, idle timeout, backpressure, auth for non-loopback.
- HTTP CONNECT with the same guarantees.
- Public destinations routable through a configured exit — today they are not
  routable at all.
- The shared routing-policy engine, used by both proxy and (later) VPN.
- Explicit bypass rules; no silent direct fallback.
- Proxy diagnostics in CLI and dashboard.

**Exit criteria:** curl, a SOCKS5-configured browser and a CONNECT-configured
browser all reach a published TNP service; public sites behave per policy; no DNS
leak when remote resolution is selected; tests cover auth, timeouts, large
transfers, half-close and 100+ concurrent streams.

## Phase 5 — Distributed relays

Depends on Phase 3.

- Signed directory with pinned key, serials and validity windows.
- Health, capacity, capabilities, versions.
- Roles: transit, service, guard.
- Client-side selection with operator and network diversity constraints.
- Initial Sybil resistance.
- Community relay onboarding and operator documentation.

**Exit criteria:** a client selects and fails over across relays it verified from
a signed directory; a tampered directory is rejected; diversity constraints are
enforced and tested.

## Phase 6 — Onion routing

Depends on Phase 5. Closes the private-mode gap.

- Incremental circuit construction, layered AEAD, fixed-size relay cells.
- Guards with persistence and slow rotation.
- Circuit rotation, stream isolation, optional padding.
- Anonymous client authentication to guards (threat model §7.1 — must be resolved
  first).
- `--privacy private` re-enabled and does what it says.
- [`privacy-model.md`](./privacy-model.md) updated with **measured** results.

**Exit criteria:** all six blocking conditions in
[`onion-routing.md`](./onion-routing.md) §10, including external cryptographic
review.

## Phase 7 — Exit nodes

Depends on Phase 5.

- TCP exit; UDP where the transport supports it; DNS at the exit.
- Exit policy, published and enforced.
- SSRF and private-range protection with rebinding defence.
- Rate limits and quotas.
- Client-side exit selection with jurisdiction and operator exclusions.
- Abuse handling and operator onboarding.

**Exit criteria:** an exit refuses every blocked range including under a
rebinding attempt; policies are published and honoured; abuse process documented
and exercised.

## Phase 8 — VPN on Linux

Closes the desktop half of issue #10. Depends on Phase 7.

- Portable `@tnp/vpn-core`: parse, classify, route, session table, DNS, stats.
- Linux TUN, systemd integration, route and DNS management.
- IPv4, IPv6, TCP, UDP.
- Split and full tunnel with deterministic rules.
- DNS and IPv6 leak protection; loop prevention.
- Opt-in kill switch; crash-path route restoration.

**Exit criteria:** full tunnel carries v4 and v6 to a selected exit; `SIGKILL`
restores routes and DNS; documented leak-test results.

## Phase 9 — Mobile (Expo)

Closes issue #15. Depends on Phase 8 for the portable core.

- Expo Router app with Oxy identity, design system, i18n.
- `modules/tnp-tunnel`: Kotlin `VpnService`, Swift Packet Tunnel Provider.
- Config plugins; EAS profiles for development, preview, production.
- OTA/native compatibility gating.
- Physical-device tests: connect, disconnect, background, terminate, reboot,
  network change, crash recovery.

**Exit criteria:** every acceptance criterion in issue #15.

## Phase 10 — macOS and Windows

Depends on Phase 8.

- macOS Network Extension; Windows Wintun and service.
- Signed installers; update and rollback; recovery.

**Exit criteria:** feature parity with Linux on both, with documented leak tests.

## Phase 11 — Hardening

Closes issue #13. Depends on everything above.

- Fuzzing across every parser; load testing; leak testing.
- Correlation experiments; hostile-relay and hostile-exit simulation.
- Red team; cryptographic review; privacy review.
- Dependency, secret and static analysis in CI.
- Beta release.

**Exit criteria:** every high-severity finding has an owner and a fix; parsers are
fuzzed continuously; the privacy model states measured results.

---

## Issue mapping

| Issue | Phases |
|---|---|
| #6 — Universal protocol and operating modes | 1 |
| #7 — DNS and namespace | 2 |
| #8 — Relay transport | 3 |
| #9 — Proxy mode | 4 |
| #10 — Full tunnel VPN | 8, 9, 10 |
| #11 — Cross-platform client lifecycle | 1, 9, 10 |
| #13 — Threat model and security testing | 1 (initial), 11 (complete) |
| #15 — Expo mobile app | 9 |
| #12 — OpenProvider | **Out of scope — close** |
| #14 — FairCoin payments | **Out of scope — close** |

## Out of scope

Not implemented, and no interfaces, adapters or mocks for them: OpenProvider,
ICANN reseller integration, traditional domain sale/transfer/renewal, the
reseller system, FairCoin payments, checkout and billing, ICANN registrar
accreditation. A grep confirms the codebase is currently clean of all of these.

## Success criteria

TNP is functional when: TNP names resolve; **public names resolve identically to
a machine without TNP**; servers publish from behind NAT; proxy and VPN access
both work; distributed relays exist; onion routing works; exit nodes work; full
and split tunnel work; IPv4, IPv6, TCP and UDP work; Linux, Android and iOS
clients exist; the mobile tunnel survives backgrounding; diagnostics and signed
updates exist; security tests exist; **the documentation matches the code**; and
real people can use it.
