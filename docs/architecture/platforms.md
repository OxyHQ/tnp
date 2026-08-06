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
| **Linux** | systemd unit | TUN | systemd-resolved per-domain routing, or `resolv.conf` fallback | Kernel keyring or encrypted file |
| **macOS** | launchd daemon | Network Extension | `/etc/resolver/<tld>` per native TLD | Keychain, non-exportable |
| **Windows** | Windows service | Wintun | Per-adapter DNS | DPAPI / CNG |
| **Android** | Foreground service | `VpnService` | Provided by `VpnService` | Android Keystore |
| **iOS** | Network Extension | Packet Tunnel Provider | Provided by the extension | Secure Enclave / Keychain |

### Linux

Coexist with NetworkManager and systemd-resolved rather than fighting them.
`resolv.conf` is a fallback, not the primary path.

**Per-TLD routing domains only.** The current installer writes `Domains=~.`,
which makes TNP the routing domain for all DNS and is the namespace violation in
audit finding S4. It must route only native TLDs.

### macOS

**Write `/etc/resolver/<tld>` for native TLDs only.** The current installer also
writes `/etc/resolver/com`, capturing every `.com` lookup on the machine (audit
S4). The upgrade path must remove files it previously wrote for reserved TLDs,
not merely stop writing new ones.

### Windows

Windows only accepts DNS on port 53, so a loopback resolver on another port is
not reachable as a system resolver. Either bind 53 on loopback or point the
adapter at the public TNP resolver — and say which is happening, because the
second choice sends the user's queries to Oxy.

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
