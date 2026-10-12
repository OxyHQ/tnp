# VPN

Operating-system-level packet interception. Affects every application on the
device according to a routing policy.

**Status: two tiers, two mechanisms.**

- **Standard tier — implemented with WireGuard, off until an exit exists.** The
  user's router, phone or computer runs the **official WireGuard client** to a
  TNP-operated exit. TNP writes no tunnel code for it: the registry hands out
  configs, the exit agent keeps the exit's peers in sync. §10 below; exits in
  [`exit-nodes.md`](./exit-nodes.md) §9; user guide in [`../vpn.mdx`](../vpn.mdx).
- **Private tier — not implemented.** The portable TUN core in §1–§8, carrying
  traffic over TNP's own transport and multi-hop circuits, remains the plan for
  the privacy tier that costs latency ([`product.md`](./product.md)). No TUN code
  exists in the repository. Phases 8–10.

**A local SOCKS proxy is not a VPN and must never be presented as one.** That
stays true: `tnp connect` is a proxy. The WireGuard tier is a VPN because the OS
routes every packet into a WireGuard interface, not because TNP says so.

---

## 1. Structure: one portable core, thin platform shims

```
┌─────────────────────────────────────────────────────────┐
│  vpn-core  (portable, no OS APIs, fully unit-testable)  │
│  packet parse · classify · route decision · policy ·    │
│  DNS interception · NAT/session table · stats · state   │
└────────────────────────┬────────────────────────────────┘
                         │  read packet / write packet / configure
     ┌───────────┬───────┴───────┬───────────┬───────────┐
     ▼           ▼               ▼           ▼           ▼
   Linux       macOS         Windows      Android       iOS
   TUN +     Network         Wintun      VpnService   Packet Tunnel
  systemd    Extension                                  Provider
```

The platform layer does exactly three things: hand packets in, take packets out,
and apply the configuration the core computed. **It never decides policy.** Five
platforms each deciding what "split tunnel" means is five different answers and
at least one security bug.

## 2. Core responsibilities

| Area | Requirement |
|---|---|
| Parsing | IPv4 and IPv6 headers, TCP, UDP, ICMP, extension headers |
| Classification | Pure function: (packet, policy) → decision. Same input, same answer, testable without a network. |
| Routing | Map a flow to a circuit and stream; maintain the session table |
| DNS | Intercept port 53 and encrypted-DNS destinations; answer from the resolver |
| MTU | Compute the tunnel MTU; handle fragmentation; emit ICMP "packet too big" where appropriate |
| Session table | Bounded, with eviction and timeouts |
| Stats | Per-flow counters for diagnostics; never content |

## 3. Split and full tunnel

Both are the same engine with different rule sets. Rules are ordered,
first-match, and expressible over destination prefix, port, protocol, network
interface, and — where the platform can attribute it — application.

| Policy | Meaning |
|---|---|
| Full tunnel | Everything through TNP except the explicit exclusions below |
| Split tunnel (include) | Only the listed destinations/apps go through TNP |
| Split tunnel (exclude) | Everything except the listed destinations/apps |

**Mandatory exclusions in every policy**, or the tunnel routes its own transport
through itself and deadlocks: the relay endpoints in use, the API endpoint, the
DHCP/gateway path needed to keep the physical link up, and loopback. Loop
prevention is a correctness requirement, not a nicety.

## 4. DNS handling

- All DNS leaving the device is captured — port 53 in both directions, plus
  known DNS-over-TLS and DNS-over-HTTPS destinations, so an application with a
  hardcoded resolver cannot bypass the tunnel.
- Names for tunnelled destinations resolve **remotely**.
- IPv6 resolution follows the same policy as IPv4. Handling A and forgetting AAAA
  is a leak.
- When the tunnel drops without a kill switch, DNS returns to the previous
  configuration — never to a half-state where some names resolve through a dead
  tunnel.

## 5. Kill switch

- **Opt-in. Never a side effect of anything else.** A user who did not ask for a
  kill switch must never lose connectivity because TNP stopped.
- When on: traffic matching the tunnel policy is blocked while the tunnel is
  down, including during reconnects.
- Rules are removed on clean shutdown, and on the next start after a crash. The
  record that says "rules are active" lives in the root-only system state
  directory, never a world-writable temp directory (audit S10; done for the
  DNS-only kill switch `tnp connect --killswitch` has today — see
  [`platforms.md`](./platforms.md) §4).
- The user is always told, clearly, when the kill switch is what is blocking
  their traffic. A kill switch that looks like a broken network is a support
  incident and a trust problem.

## 6. Lifecycle and recovery

| Event | Required behaviour |
|---|---|
| Clean stop | Routes, DNS and firewall rules restored exactly |
| Crash | Next start detects and clears leftover state before doing anything else |
| Network change (Wi-Fi ↔ cellular) | Reconnect and resume; do not tear down user sessions if resumption is safe |
| Sleep / resume | Detect, revalidate, reconnect |
| Reboot | Off unless always-on was explicitly enabled |
| Relay failure | Failover to another relay without dropping the tunnel where possible |

Route and DNS restoration must be verified by **testing the crash path**, not
only the clean path. The clean path is the one that always works.

## 7. Platform notes

| Platform | Mechanism | Notes |
|---|---|---|
| Linux | TUN + systemd + route/DNS management | Coexist with NetworkManager and systemd-resolved rather than fighting them; nftables for the kill switch |
| macOS | Network Extension | Requires entitlements; a system extension, not a kext |
| Windows | Wintun + a service | Signed driver; the service is separate from the UI |
| Android | `VpnService` + foreground service | Persistent notification is mandatory; always-on and lockdown are explicit user options |
| iOS | Network Extension Packet Tunnel Provider | Tunnel logic lives in the extension, not in React Native; requires entitlements and App Store review |

Detail: [`platforms.md`](./platforms.md), [`mobile-expo.md`](./mobile-expo.md).

## 8. Required leak tests

Documented results, per platform, before any release that enables tunnel mode:

- DNS leak: no query reaches the system resolver while the tunnel is up.
- IPv6 leak: no v6 traffic escapes a v4-only tunnel — either dual-stack or
  explicitly blocked.
- Kill switch: traffic is blocked while the tunnel is down, and only then.
- Route restoration: after a `SIGKILL`, routes and DNS return to their previous
  state.
- Loop prevention: relay and API traffic never enters the tunnel.
- Network change: no traffic leaks during the transition.
- WebRTC: documented result. This cannot be fully fixed at the tunnel layer, so
  it is documented with browser-side guidance rather than claimed as solved.

## 9. The honesty rule

- No TNP surface says "VPN" about a proxy, a resolver or anything else that does
  not route the device's packets.
- The web dashboard never claims to *be* a VPN or to install one. It hands the
  user a WireGuard configuration; the official WireGuard app, `wg-quick` or the
  router's kernel carries the traffic. The dashboard says exactly that.
- The standard tier is described with what it protects (the local network and
  the ISP see neither destinations nor contents) and what it does not (TNP, as
  the exit operator, sees destinations and anything not encrypted end to end; it
  is not anonymity), at the point where a device is added
  ([`privacy-model.md`](./privacy-model.md) §6, §8).
- The TUN-based private tier stays unclaimed until §1–§8 are implemented and the
  §8 leak tests have documented results.
- **Launch gate for the standard tier:** `TNP_VPN_EXITS` is not set in
  production until the §8 leak tests that apply to it (DNS, IPv6, kill switch
  where the platform has one, WebRTC guidance) have documented results against a
  real TNP exit, on at least OpenWrt, Android, iOS, Windows, macOS and Linux.
  The expected behaviour is in §10.5; expected is not measured.

## 10. Standard tier: WireGuard to TNP-operated exits

Supersedes, for the standard tier, the plan to reach the public internet
through a custom TUN client and overlay exits (Phases 7–8). That plan remains
the route to the private tier, where the whole point is that no single operator
sees both ends — something one WireGuard hop to one operator cannot offer.

### 10.1 Why WireGuard

The product owner's test is replacing a paid VPN at home, on an OpenWrt router.
WireGuard is in the Linux kernel, native on OpenWrt, and has audited official
clients on every platform with always-on/kill-switch support. Writing five TUN
shims (§7) to reach the same place would take phases and add attack surface;
WireGuard is the fast path [`product.md`](./product.md) asks for: one hop, kernel
crypto (Noise IK, Curve25519, ChaCha20-Poly1305), no TNP code on the device.

### 10.2 Shape

```
device / router ── WireGuard (UDP 51820) ── TNP exit (EC2, kernel wg0) ── NAT ── internet
                                               │  ▲
                         apps/exit agent ──────┘  │ GET /exit/peers (bearer token, every ~20 s)
                                                  │
browser / tnp CLI ── POST /me/vpn/devices ──► TNP API ── vpn_devices (Postgres)
   (keys generated here; public key only)
```

- **Keys.** The device's X25519 key pair is generated where the tunnel will run
  — the dashboard (in the browser, `@tnp/crypto/wireguard`) or `tnp vpn add`.
  Only the public key is sent. The API refuses a body that carries a private key.
- **Registry.** `POST /me/vpn/devices` stores `{ id, owner, name, publicKey,
  address, createdAt }` and nothing else, allocates a random free address in
  `10.77.0.0/16` (IPv6 derived inside `fd85:d596:af02::/64`), and caps an
  account at 10 devices. Unique indexes on key and address; an advisory lock per
  account makes the cap hold under concurrency. Contracts: `@tnp/shared-types`
  `vpn.ts`.
- **Config.** `{ exits, dns, allowedIPs }` come from API configuration; the
  device writes the WireGuard config itself, so the private key is only ever in
  the page's memory or a `0600` file. Full tunnel: `0.0.0.0/0, ::/0`. A config
  is **per exit**: the device is a peer on every exit, and switching exits means
  a different endpoint, public key and resolver (§10.3). The dashboard and
  `tnp vpn add` offer the exit nearest the user's time zone first and show every
  exit's region (`tnp vpn exits` lists them); the user can pick any.
- **Exit.** Kernel WireGuard, nftables policy (exit-nodes.md §9), and the
  `apps/exit` agent, which polls `GET /exit/peers` and reconciles peers with
  `wg set` argument arrays. A revoked device is removed, and its flows
  deleted, at the next poll; an exit that cannot reach the API removes every
  peer after 10 minutes (exit-nodes.md §9.4). Freed addresses are held 24 h
  before reuse. Routers dial the exit by its IP literal (`endpointIp`).
- **Off by default.** Without `TNP_VPN_EXITS`, every `/me/vpn` route except
  DELETE answers 503 `vpn_not_configured` and the dashboard says the VPN is not
  available yet.
- **Allowlisted accounts only.** `TNP_VPN_ALLOWED_USERS` names the Oxy accounts
  that may use the VPN; anyone else gets 403 `vpn_not_available` (the dashboard
  says it is not available for their account) and their devices are left out of
  `/exit/peers`, so no exit carries their traffic. **In production an unset
  list means the VPN is off for everyone** — an exit's cost must not grow with
  who finds the page (exit-nodes.md §9, §9.9 for the exit-side cap).

### 10.3 DNS

**Each exit answers its own peers' DNS.** A config names the resolver of the
exit it tunnels to: the exit's `dns` in `TNP_VPN_EXITS`, which is the tunnel
gateway address `10.77.0.1` on every exit, where the exit runs TNP's resolver
(`tnp-exit-dns`, exit-nodes.md §9.7). TNP-native names resolve natively and
public names go upstream over DoH from the exit, so lookups take one tunnel
round trip and CDNs answer with edges near the exit — measured as the problem
when every exit's users went to one resolver in us-west-2. The resolver sees
each device's tunnel address, so its per-source limit is per device; the
exit's packet filter adds a per-peer packet limit in front of it.

An exit without its own `dns` falls back to `TNP_VPN_DNS` (TNP's public
resolver, defaulting to the `TNP_PARKING_IP` it answers on), reached through
the tunnel and forwarded by the exit like any other traffic, rate-limited per
peer at the exit; the public resolver exempts exit addresses from its own
per-source limit (`TNP_DNS_RATE_LIMIT_EXEMPT`, exit-nodes.md §9.6). Clients
that predate per-exit DNS use `TNP_VPN_DNS` for every exit.

Oxy runs the exit and its resolver, so it can see every name a device looks
up — the same position it holds as exit operator for every destination. The
resolver keeps no query log, only aggregate counters and a cache
([`privacy-model.md`](./privacy-model.md) §8).

### 10.4 IPv6

IPv6 is **captured but not carried.** Every config routes `::/0` into the
tunnel and gives the device a ULA address, and the exit refuses all forwarded
IPv6 with an immediate ICMP error. Result: no IPv6 can leak around the tunnel,
and applications fail over to IPv4 at once instead of waiting for a timeout.
Carrying IPv6 needs an IPv6 subnet on the exit and NAT66; the blocked IPv6
ranges are already in the ruleset so that change cannot forget them.

### 10.5 Expected leak behaviour (to be measured — §9 launch gate)

| Test | Expected with the TNP config |
|---|---|
| DNS | Queries go to the configured resolver through the tunnel. On Linux only if `wg-quick` can set DNS (resolvconf or systemd-resolved); the guide says so. OpenWrt: `peerdns=0` on wan, resolver on `wg0`. |
| IPv6 | Phones and computers: captured by `::/0`, refused at the exit. OpenWrt: the provider's IPv6 default route is source-restricted (`wan6.sourcefilter`) and would beat `wg0`'s `::/0` for LAN devices, so the setup turns source routing off and refuses LAN IPv6 at the router (fw4 rules to `wan` and `tnp`). |
| Kill switch | Windows app: built in for a `0.0.0.0/0` tunnel. Android: always-on + "block connections without VPN". iOS: on-demand, no hard kill switch. Linux `wg-quick`: none by default. OpenWrt: the generated setup removes the lan→wan forwarding **by default** (opt-out), so LAN traffic stops rather than falling back to the provider. |
| Loop prevention | WireGuard's own UDP to the endpoint stays off the tunnel (wg-quick fwmark rule; OpenWrt endpoint host route). |
| WebRTC | Browser-side; documented, not claimed as solved (§8). |
