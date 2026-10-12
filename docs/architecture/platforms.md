# Platform integration

Everything here is *how* a platform does something. *What* to do is decided in
portable code and shared. A platform layer that makes a policy decision is a bug.

**Status: partial.** Linux, macOS and Windows have install and service
management. Mobile has nothing. No platform has a tunnel.

---

## 1. Process split

```
┌──────────────────┐   authenticated,      ┌─────────────────────────┐
│ UI / CLI         │◀── owner-only IPC ───▶│ privileged daemon       │
│ unprivileged     │                       │ resolver · overlay ·    │
│                  │                       │ proxy · tunnel          │
└──────────────────┘                       └─────────────────────────┘
```

The daemon does the privileged work and keeps running when the UI is closed.
**Nothing that must keep working may depend on a UI being open.** The control
socket is owner-only and authenticated; a local unprivileged process must not be
able to reconfigure routing, install a namespace override, or read key material.

## 2. Per platform

| | Service | Tunnel | DNS configuration | Keys |
|---|---|---|---|---|
| **Linux** | systemd unit | TUN | systemd-resolved DNS delegate (≥ 258) or dedicated `tnp0` link; no `resolv.conf` fallback | Kernel keyring or encrypted file |
| **macOS** | launchd daemon | Network Extension | `/etc/resolver/<tld>` per native TLD | Keychain, non-exportable |
| **Windows** | Windows service | Wintun | NRPT rule per native TLD; adapter DNS untouched | DPAPI / CNG |
| **Android** | Foreground service | `VpnService` | Provided by `VpnService` | Android Keystore |
| **iOS** | Network Extension | Packet Tunnel Provider | Provided by the extension | Secure Enclave / Keychain |

### Linux

Coexist with NetworkManager and systemd-resolved rather than fighting them.
There is no `resolv.conf` fallback: it cannot route by domain, so prepending a
nameserver captures all DNS. Without systemd-resolved nothing is changed and
the user is told how to forward `.ox` (resolution.md §10).

**Per-TLD routing domains only.** Earlier installers wrote `Domains=~.`, which
made TNP the routing domain for all DNS (audit finding S4). `dns-routing.ts` now
routes only native TLDs.

### macOS

**Write `/etc/resolver/<tld>` for native TLDs only.** The current installer also
writes `/etc/resolver/com`, capturing every `.com` lookup on the machine (audit
S4). The upgrade path must remove files it previously wrote for reserved TLDs,
not merely stop writing new ones.

### Windows

Windows only accepts DNS on port 53, so a loopback resolver on another port is
not reachable as a system resolver. `tnp install` binds 53 on loopback and adds
an NRPT rule per native TLD; adapter DNS servers are never rewritten. Pointing
an adapter at the public TNP resolver would send every lookup to Oxy in
plaintext, so neither the client nor the install page does it.

## 3. Install and uninstall

Requirements:

- Signed installers per platform.
- Uninstall restores the **previous** network configuration — DNS, routes,
  firewall rules — not a guessed default. That means recording the prior state at
  install time.
- Upgrades migrate configuration and clean up state the previous version wrote,
  including files a policy change has since made wrong (the `/etc/resolver/com`
  case above).
- Headless and remote server installation is supported with no interactive
  prompts.
- Installation never silently enables proxy or tunnel mode. Modes are opted into.

## 4. Permissions and consent

| Action | Consent required |
|---|---|
| Change system DNS | Yes — admin/root, and an explicit prompt |
| Install a namespace override | Yes — per name, naming it |
| Enable proxy mode | Yes — states which port and that only configured apps are affected |
| Enable tunnel mode | Yes — platform VPN permission, plus a statement of what changes |
| Enable kill switch | Yes — separately, states what will be blocked |
| Become a relay | Yes — states inbound exposure |
| Become an exit | Yes — states what the operator will see and be responsible for |

Consent is per capability, not one blanket approval at install.

### As implemented (client 0.2.x)

**Kill switch (`tnp connect --killswitch`) — DNS only.** It blocks outbound
plain DNS (UDP and TCP port 53, IPv4 and IPv6) to every address except loopback
and the configured TNP resolver. Nothing else is blocked; it is not a
full-traffic kill switch and must never be described as a VPN kill switch.
It is all or nothing: if both address families cannot be blocked and verified,
the partial rules are rolled back and `connect` refuses to start. Needs
root/Administrator; it never shells out to `sudo`.

| | Mechanism | Verified before reporting "on" |
|---|---|---|
| Linux | `inet` nftables table `tnp_killswitch`; without `nft`, chain `TNP_KILLSWITCH` in iptables **and** ip6tables | table/chain present; an IPv6 host without ip6tables is refused |
| macOS | pf anchor `com.apple/tnp-killswitch` (evaluated by the stock `anchor "com.apple/*"`), passes before a quick block, loaded from stdin; pf enabled with `pfctl -E` and the token released with `pfctl -X` | main ruleset references `com.apple/*`, anchor loaded, pf enabled |
| Windows | block rules whose remote addresses are the complement of the allowed set (block beats allow in Windows Firewall) | every firewall profile enabled, every rule present |

A plain-DNS `upstreamDns` is cut off too; `connect` warns that public names then
need a DoH upstream. The record lives in the system state directory, and the
0.2.0 `/tmp` marker, rule names and pf anchor are cleaned up on sight.

**Resolver service.** Every platform's service runs an admin-only copy of the
binary (`/usr/local/bin/tnp` checked root-owned all the way up, or
`%ProgramFiles%\TNP\tnp.exe`), never the file that was launched. On Linux the
unit runs as the `tnp` system user with only `CAP_NET_BIND_SERVICE`,
`ProtectSystem=strict` (its only writable path is its own `/var/lib/tnp-resolver` TLD cache; the `tnp0` link hooks run privileged via `+`), a syscall filter and address-family
restriction (`systemd-analyze security`: 1.4). It reads the secret-free
`/etc/tnp/resolver.json` through its group, never `config.json`, which can hold
the relay token. **Follow-ups:** the macOS
launchd job and the Windows task still run as root/SYSTEM; a dedicated macOS
service account (`dscl`) and `LOCAL SERVICE` on Windows are next.

**Uninstall.** `tnp uninstall` removes the service, TNP's DNS routing,
kill-switch rules and autoconnect units, then lists the data still on disk.
`tnp uninstall --purge` also deletes config, identity key, log, binary and the
`tnp` account, and names what TNP cannot remove (journal, shell history).

## 5. Diagnostics and repair

`tnp status` reports each subsystem **independently**: API reachability, resolver,
overlay, proxy, tunnel, service node, relay. "Connected" is not a status.

`tnp diagnose` runs checks and names the failing component and the fix, without
printing secrets, tokens or key material.

`tnp repair` restores DNS and routes to their recorded prior state and clears
leftover firewall rules — the same path a crash-recovery start takes, so it is
exercised routinely rather than only in an emergency.

## 6. Updates

Signed artefacts, three channels, downgrade protection, rollback to a specific
signed version. Detail in [`security.md`](./security.md) §7.

Platform-specific packaging (deb/rpm, Homebrew, MSI, Play Store, App Store) is a
distribution concern; the signature and version checks are the same everywhere.

## 7. Honest limitations

To be stated per platform in user-facing documentation, not discovered by users:

- **iOS**: background execution is bounded by the OS. Network Extension
  entitlements require Apple approval. App Store review may constrain what the
  app can describe or do.
- **Android**: aggressive OEM battery management can kill the service on some
  devices. Always-on VPN behaviour varies by vendor.
- **macOS**: system extensions require user approval in System Settings, which
  cannot be automated.
- **Windows**: the driver must be signed; some environments block third-party
  network filters entirely.
- **Linux**: distributions vary widely in DNS management; some configurations
  will need manual steps.

Routers and containers are a later target and are not designed for here.
