# Migration plan

How the repository gets from what it is to the architecture in
[`overview.md`](./overview.md) **without a big-bang restructure and without
breaking the running deployment**.

---

## 1. Two migrations, deliberately separate

1. **Namespace migration** — stop shadowing public DNS names. User-visible,
   time-sensitive, has its own staged plan in [`naming.md`](./naming.md) §6.
2. **Structural migration** — split the monolith into layered packages. Not
   user-visible; done incrementally alongside feature work.

They are independent. The namespace migration must not wait for the structural
one.

## 2. Where the code is now

`packages/client` owns eight of the ten layers: naming lookups, DNS serving,
transport, proxying, service publication, relay operation, OS integration and the
terminal UI. `apps/dns-server` reaches into it by relative path
(`../../../packages/client/src/proxy`) without declaring a dependency, which is
how audit finding B1 went unnoticed. `apps/relay` and
`packages/client/src/relay-node.ts` implement the same relay twice, with the same
defects twice.

## 3. Target shape

```
apps/
  api/            registry, directory, control plane
  relay/          standalone relay server        (thin: wraps @tnp/relay-core)
  exit/           exit node server               (Phase 7)
  dns-server/     public resolver                (thin: wraps @tnp/resolver)
  web/            management dashboard
  mobile/         Expo app                       (Phase 9)
  desktop/        desktop control UI             (Phase 10, if warranted)

packages/
  protocol/       wire format, frame codec, error codes, limits
  crypto/         primitives, key hierarchy, grants, AEAD envelopes
  shared-types/   contracts shared by API, clients and apps
  resolver/       DNS engine: classify, lookup, cache, upstream, DNSSEC
  discovery/      directory fetch, verification, node selection
  transport/      connections, circuits, streams, flow control, reconnect
  onion/          path selection, circuit build, layered encryption   (Phase 6)
  proxy/          SOCKS5, HTTP CONNECT, routing policy engine
  vpn-core/       portable packet classification and routing          (Phase 8)
  service-node/   service publication
  relay-core/     relay routing logic
  exit-node/      exit logic and policy                               (Phase 7)
  client-core/    portable state machines, mode composition, config
  client-cli/     the `tnp` binary
  api-client/     typed API client
  ui/             shared TNP UI primitives

platforms/
  linux/ macos/ windows/ android/ ios/     thin OS integration only
```

Note this repository still uses `apps/` while the Oxy standard is `packages/`
for single-app repos. TNP is not a single app — it is a network with several
deployable programs — so `apps/` for deployables plus `packages/` for libraries
is the right shape here and is a deliberate exception, not drift.

## 4. Extraction order

Each step is a separate PR, each leaves the repo runnable, each is a **clean
cut** — the old identifier is removed and every call site updated in the same
change. No compatibility shims, no re-export barrels, no deprecated aliases.

| Step | Extract | Trigger | Unblocks |
|---|---|---|---|
| 1 | `@tnp/shared-types` | Phase 1 | Contracts stop being duplicated between API and client. Fixes the class of bug behind audit B2. |
| 2 | `@tnp/resolver` | Phase 2 | `apps/dns-server` stops reaching across the workspace by relative path (B1). |
| 3 | `@tnp/protocol` grows | Phase 3 | Protocol v1: limits, error codes, state machines. |
| 4 | `@tnp/crypto` | Phase 3 | Key hierarchy and grants, shared by every component. |
| 5 | `@tnp/transport` | Phase 3 | Connections and circuits out of the client monolith. |
| 6 | `@tnp/relay-core` | Phase 3 | Collapses the two duplicate relay implementations into one. |
| 7 | `@tnp/service-node` | Phase 3 | |
| 8 | `@tnp/api-client` | Phase 3 | |
| 9 | `@tnp/proxy` | Phase 4 | Includes the routing-policy engine the VPN will reuse. |
| 10 | `@tnp/discovery` | Phase 5 | |
| 11 | `@tnp/onion` | Phase 6 | |
| 12 | `@tnp/exit-node` | Phase 7 | |
| 13 | `@tnp/vpn-core` + `platforms/*` | Phase 8 | |
| 14 | `@tnp/client-core`, `@tnp/client-cli` | Phase 8 | The monolith is gone. |

## 5. Rules for every extraction

1. **Move, don't fork.** Delete from the old location in the same PR. Two copies
   is exactly how `apps/relay` and `relay-node.ts` came to share the same bugs.
2. **Update every call site.** Including comments and documentation.
3. **The package must typecheck and test on its own**, and be wired into CI in
   the same PR.
4. **No re-export barrels.** Consumers import from the owning package.
5. **No `any`, no `@ts-ignore`, no non-null assertions.** An extraction that
   needs one is an extraction whose boundary is wrong.
6. **Portable packages import no OS APIs.** If `@tnp/vpn-core` imports `node:net`,
   the split has already failed.

## 6. Not breaking the deployment

Currently deployed: the web app on Cloudflare Pages, the API on a DigitalOcean
droplet via SSH + Docker, and released client binaries for five targets.

- API route contracts change only additively until the client that consumes them
  ships. Where a contract must change incompatibly (relay registration, audit
  B2), the API accepts the new shape and the client is released before the old
  shape is removed — one release apart, not one PR apart.
- Deployed clients keep working through a protocol change because protocol v1
  refuses to talk to a v0 peer rather than misinterpreting it. Relays run both
  during the transition window, then drop v0.
- Installers must clean up state a previous version wrote — most importantly
  `/etc/resolver/com` and `Domains=~.` — so an upgrade fixes the namespace
  violation rather than leaving it behind.
- `.github/workflows/deploy.yml` currently deploys the web app on every push to
  `main` with no gate. Phase 1 puts a green CI run in front of it.

## 7. What gets deleted

- The hand-rolled DNS wire serialization in `packages/client/src/proxy.ts`.
- The duplicate relay implementation, once `@tnp/relay-core` exists.
- The unused Ed25519 identity plumbing, once the key hierarchy replaces it.
- `TnpConfig.upstreamDns` or the hardcoded DoH bypass — one of the two; a setting
  that is read and a setting that is ignored cannot both be right.
- `.com` and `.app` from the TLD seed.
- The `/etc/resolver/com` writer and the `Domains=~.` drop-in.
