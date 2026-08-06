# Mobile client (Expo)

The Android and iOS client is an Expo + React Native + Expo Router application,
consistent with the rest of the Oxy ecosystem. The tunnel itself is native.

**Status: not implemented.** Phase 9. Scope: issue #15.

---

## 1. The constraint that shapes everything

**JavaScript cannot implement an OS VPN.** Expo owns the UI, navigation, account
experience, settings, diagnostics and the control plane. The packet tunnel is
native code in a platform service that keeps running when the React Native
runtime is suspended or terminated.

Consequences that are not negotiable:

- Custom native modules are required, so **development builds and EAS builds are
  required**.
- **Expo Go cannot run the VPN.** Document it plainly rather than letting people
  discover it.
- The tunnel must survive the JS runtime being gone, within each platform's
  limits.

## 2. Structure

```
apps/mobile/
  app/                    Expo Router routes
  components/             shared RN UI
  features/               connection · nodes · domains · settings · diagnostics
  modules/tnp-tunnel/     local Expo native module
    android/              Kotlin VpnService
    ios/                  Swift bridge + Network Extension coordination
  plugins/                Expo config plugins
```

Shared logic lives in packages, not in the app: `@tnp/protocol`,
`@tnp/client-core` (portable state machines and policy), `@tnp/api-client`,
`@tnp/ui`. **Application code is not copied from another Oxy product** — if it is
reusable, it belongs in a shared Oxy package.

## 3. Oxy foundations

Per the ecosystem rules, not re-litigated here: Expo SDK 57 workspace
dependencies; a single `OxyProvider` from `@oxyhq/services` with a registered
`clientId` for device-first session handling; `@oxyhq/core` and shared contracts;
Oxy visual components and `@oxyhq/app-preset`; SecureStore/keychain for
non-extension secrets; EAS profiles for development, preview and production.

No app-local session code, no app-local auth callback routes.

## 4. Native module API

Small, stable, and the same shape on both platforms:

```ts
prepare(config: TunnelConfig): Promise<void>
requestPermission(): Promise<boolean>
connect(profile: TunnelProfile): Promise<void>
disconnect(): Promise<void>
getStatus(): Promise<TunnelStatus>
getStatistics(): Promise<TunnelStatistics>
subscribeStatus(listener: (s: TunnelStatus) => void): Subscription
getNativeProtocolVersion(): number
```

The native side owns the packet lifecycle, background execution, route
configuration and recovery. JavaScript owns intent and presentation and **must
not be required to be alive** for the tunnel to keep working.

## 5. Android

- `VpnService` plus a foreground service.
- The persistent notification is mandatory while connected — not a design choice.
- Always-on VPN and lockdown mode are **explicit user options**, never defaults.
- State is restored after process death, and after reboot when always-on is on.
- A config plugin declares the service, permissions and intent filters.
- Keys go in the Android Keystore, reachable by the service without the RN
  process.

## 6. iOS

- A Network Extension Packet Tunnel Provider in its own target.
- Shared configuration through an App Group container.
- Connection state coordinated via `NETunnelProviderManager`.
- **Tunnel logic lives in the extension**, not in React Native. The extension
  must not depend on the RN runtime being active.
- Config plugin or supported target tooling generates and maintains the extension
  target; entitlements, provisioning and App Store review requirements are
  documented before the work starts, not discovered during submission.
- The app↔extension channel is authenticated; the extension does not act on an
  unauthenticated message.

## 7. OTA safety

**An OTA update must not be able to ship JavaScript incompatible with the
installed native tunnel module.**

- The JS bundle declares the native protocol version range it requires.
- The native module exposes `getNativeProtocolVersion()`.
- On boot, JS checks compatibility. Outside the range, it refuses to drive the
  tunnel and tells the user to update the app — rather than calling a native API
  that no longer means what it did.
- Update channels are signed and separated (development, preview, production).
- A native protocol change is a **native release**, never an OTA-only change.

## 8. Web

Expo Web may serve a management dashboard: accounts, domains, relays, devices,
settings, documentation.

**It must not present itself as a device VPN.** A web page cannot install a packet
tunnel. Browser-scoped access mechanisms (a browser proxy configuration,
WebTransport, an application gateway) are a separate future capability and must
be labelled as such.

## 9. Testing

- Config plugin tests and native module unit tests.
- Physical-device integration tests: connect, disconnect, background, terminate
  the app, reboot, network change (Wi-Fi ↔ cellular), airplane mode, crash
  recovery.
- Leak tests per [`vpn.md`](./vpn.md) §8, run on real devices.
- Simulators do not exercise the VPN paths that matter. Physical devices are
  required evidence.
