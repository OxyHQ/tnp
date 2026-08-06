# VPN

Operating-system-level packet interception. Affects every application on the
device according to a routing policy.

**Status: not implemented.** No TUN code exists in the repository. Phases 8–10.

**A local SOCKS proxy is not a VPN and must never be presented as one.**

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
  marker that records "rules are active" belongs in the data directory, not a
  world-writable temp directory (audit S10).
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

Until this document is implemented and the leak tests above have documented
results:

- No TNP surface says "VPN" about anything that ships.
- The web dashboard never claims device VPN capability. A web page cannot install
  a packet tunnel, and saying otherwise is a false claim, not a simplification.
