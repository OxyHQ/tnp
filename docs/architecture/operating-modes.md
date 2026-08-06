# TNP operating modes

Nine modes. Each has independent state, independent configuration, its own
permission requirements, its own diagnostics and its own threat model. They
**compose** — a device can be in resolver + proxy + service mode at once — so
this is not a single enum, and any UI that presents it as one is wrong.

Cutting across all of them is the **privacy tier** the user selects — standard
(one hop, fast, the default) or private (multi-hop, slower, opt-in). The tier
decides how traffic is carried; the mode decides what traffic is carried. See
[`product.md`](./product.md) § Privacy tiers.

`Status` in each section is the honest state of the code, not the plan.

---

## Mode matrix

| Mode | Privileges needed | Affects other apps? | Terminates E2E crypto? | Status |
|---|---|---|---|---|
| Resolver | Root/admin to change system DNS (or none, if the user points a resolver at TNP manually) | Yes — all name lookups | No | Partial |
| Access | None | No | Client end | Partial |
| Proxy | None (binds a loopback port) | Only apps configured to use it | Client end | Partial |
| Service | None (outbound only) | No | Service end | Partial |
| Relay | Bind a public port | No | **Never** | Broken (registration, see audit B2) |
| Private | None | No | Client end | Not implemented |
| Exit | Bind a public port + operator acceptance of liability | No | **Never** (but sees plaintext destinations) | Not implemented |
| Split tunnel | Root/admin (TUN + routes) | Yes — matching traffic | Client end | Not implemented |
| Full tunnel | Root/admin (TUN + routes + DNS) | Yes — all traffic | Client end | Not implemented |

---

## 1. Resolver mode

**Does:** answers TNP-native names from TNP data; forwards every other name to a
configured public upstream, unchanged.

**Does not:** route any traffic. A name resolving is not a connection happening.

**Guarantee:** a `public-dns` name returns byte-identical answers with TNP
installed and without it, unless the user installed an explicit override for
that name. This is the load-bearing promise of the whole product — see
[`naming.md`](./naming.md).

**Trusts:** the TNP registry for native names; the configured upstream (and
DNSSEC, when enabled) for public names.

**Status: partial.** Native resolution works. Public forwarding re-encodes
answers incorrectly, hardcodes one DoH endpoint, and has no DNSSEC (audit B3,
B4, S8). The installers currently capture `.com` and `.app` as well, which
breaks the guarantee above (audit S4). Phase 2.

---

## 2. Access mode

**Does:** opens circuits to TNP service nodes so TNP-native destinations are
reachable. Public destinations are untouched.

**Does not:** touch the OS network stack. Reachability still requires either
proxy mode or tunnel mode to actually carry an application's bytes.

**Trusts:** the directory for where a service node is; the service node's key for
end-to-end confidentiality.

**Status: partial.** Single-hop circuits work. The service node's key is trusted
because the API said so, with no signature chain (audit S3), and circuit IDs are
not connection-scoped (audit S1). Phase 3.

---

## 3. Proxy mode

**Does:** exposes SOCKS5 and HTTP CONNECT on loopback. Applications opt in.
Resolves names remotely so a proxied destination does not leak to the system
resolver first.

**Does not:** capture traffic from applications that were not configured. **It is
not a VPN and must never be presented as one.**

**Status: partial.** SOCKS5 CONNECT reaches TNP names only. No IPv6 address type,
no authentication for non-loopback listeners, the requested port is parsed and
discarded, pipelined bytes after the greeting are dropped, and public
destinations are not routable at all. HTTP CONNECT does not exist. UDP ASSOCIATE
is correctly **not** advertised, and must stay unadvertised until real UDP
support lands. Phase 4. Detail: [`proxy.md`](./proxy.md).

---

## 4. Service mode

**Does:** publishes a local service under a TNP domain the user controls, using
outbound connections only, so it works behind NAT with no port forwarding.

**Trusts:** the relay for availability (never for confidentiality); Oxy for
proving the user owns the domain.

**Status: partial.** The connect-out-and-reconnect model works. The relay accepts
any unauthenticated socket claiming any domain and lets it evict the incumbent
(audit S2). Phase 3. Detail: [`service-nodes.md`](./service-nodes.md).

---

## 5. Relay mode

**Does:** forwards frames between clients, service nodes and other relays.

**Never:** decrypts payloads, stores traffic, or exits to the public internet.
Exit is a separate mode with separate consent.

**Status: broken.** The relay forwards correctly, but registration is
non-functional (the client and API disagree on the request body for both
`/relays/register` and `/relays/heartbeat` — audit B2), the upgrade path is
unauthenticated, and there are no quotas or frame-size limits. Phases 3 and 5.
Detail: [`relays.md`](./relays.md).

---

## 6. Private mode

The opt-in privacy **tier**, not a separate way of using TNP: it changes how
access, proxy and tunnel modes carry traffic, and costs latency to do it. The
standard tier stays the default precisely so that choosing this one is a
decision the user makes rather than a tax everyone pays.

**Does (specified):** builds multi-hop circuits so no single relay sees both the
client and the destination.

**Status: not implemented.** There is no multi-hop code in the repository.

It used to parse the flag, print `privacy: private`, and build exactly the same
single-hop circuit as `access` (audit B5). Since Phase 1 the flag is **rejected
with an error naming Phase 6**, a stored `"private"` from an older build is
normalized back to `"access"` with a warning, and `"private"` is not a member of
the `PrivacyLevel` type — so nothing can quietly reintroduce it. Silently giving
a user single-hop routing after they asked for private routing is the worst
available outcome.

Design: [`onion-routing.md`](./onion-routing.md). Honest limits: [`privacy-model.md`](./privacy-model.md).

---

## 7. Exit mode

**Does (specified):** accepts traffic from TNP circuits and opens connections to
the public internet under a published exit policy.

**The operator sees:** every destination address and port, and the full content
of anything not protected by application-layer encryption. This is inherent to
being an exit — it is not a defect and it must be stated plainly in the operator
consent flow and in the client's exit picker.

**Never automatic.** A relay does not become an exit by being a relay. Separate
opt-in, separate policy, separate published metadata (capacity, approximate
jurisdiction, operator terms).

**Status: not implemented.** Phase 7. Detail: [`exit-nodes.md`](./exit-nodes.md).

---

## 8. Split tunnel mode

**Does (specified):** captures packets at a TUN interface and sends only the
matching subset — by destination prefix, by network, or by application — through
TNP. Everything else takes the normal route.

**Rules must be deterministic and testable.** Given a packet and a rule set, the
decision is a pure function with one answer. It lives in portable code, not in
platform code.

**Status: not implemented.** Phases 8–10. Detail: [`vpn.md`](./vpn.md).

---

## 9. Full tunnel mode

**Does (specified):** all IPv4 and IPv6 traffic, TCP and UDP, plus DNS, leaves
the device through TNP to a selected exit.

**Must handle:** routing-loop prevention for the relay and API endpoints
themselves, MTU and fragmentation, network changes (Wi-Fi ↔ cellular), suspend
and resume, and safe route + DNS restoration after a crash — not only after a
clean shutdown.

**Kill switch is opt-in, never a side effect.** A user who never asked for a kill
switch must never lose connectivity because TNP stopped.

**Status: not implemented.** Phases 8–10.

---

## Mode composition

Legal combinations, and the ones that are not:

- Resolver + access + proxy — the normal desktop client.
- Resolver + service — a headless server publishing a site.
- Relay alone, or relay + exit — infrastructure. A relay should not also be a
  full-tunnel client on the same host; its traffic and its users' traffic become
  hard to distinguish.
- Proxy + full tunnel simultaneously — allowed, but the tunnel's routing policy
  must exclude the proxy's own upstream sockets or traffic loops.
- Private + service — allowed; the service node's own relay connection is a
  separate path from the client's circuit.

Every mode must expose its state **independently** in `tnp status` and in the
dashboard. "Connected" is not a status. Which of resolver, access, proxy,
overlay and tunnel are up, and what each is failing at, is a status.
