# TNP (The Network Protocol)

## Custom Agents

Use this agent for all implementation work:
- `tnp` — Full-stack engineer (Vite web + Bun API + DNS server + client)

## Commands

```bash
bun run dev                 # Both API & web (concurrent)
bun run dev:api             # API only (Bun watch)
bun run dev:web             # Web only (Vite)
bun run seed                # Seed database with initial TLDs
cd apps/web && bun run build        # Build web (tsc + vite build)
cd packages/client && bun run build # Compile CLI to binary (dist/tnp)
```

## Architecture

Monorepo — alternative internet namespace system for custom TLDs.

```
apps/
  api/            @tnp/api          Bun + Express 5.2 / Mongoose 9.3 / @oxyhq/core
  web/            @tnp/web          Vite 8 / React 19 / TailwindCSS 4.2 / React Router 7 / react-i18next
  dns-server/     @tnp/dns-server   DNS daemon (dns2 library)
  relay/          @tnp/relay        WebSocket relay server for overlay network
packages/
  client/         @tnp/client       Interactive CLI, DNS proxy, SOCKS5 proxy, tunnel manager,
                                    service node, embedded relay (compiles to standalone binary)
```

## How It Works

1. User registers at TNP web via Oxy SSO
2. User registers domains on custom TLDs (.ox, .app, etc.)
3. User manages DNS records via web dashboard
4. Client CLI daemon resolves TNP domains locally (intercepts DNS queries)
5. Unhosted domains show a branded parking page via DNS fallback → redirect → `/park/:domain`
6. Service nodes expose local services through the overlay network (encrypted tunnels via relays)

## i18n

The web app supports 5 languages via `react-i18next`:
- English (en), Chinese Simplified (zh), Spanish (es), Hindi (hi), French (fr)
- Translation files: `apps/web/public/locales/{lng}/{ns}.json`
- Namespaces: common, home, explore, register, domains, domainDetail, dashboard, serviceNodes, network, propose, install, park
- Language detection: localStorage (`tnp-lang`) → browser → HTML tag
- Language picker in the navbar

## Models

- `User` — linked to Oxy accounts
- `Domain` — registered domains with DNS records
- `TLD` — top-level domains (.ox, .app, etc.)
- `TLDProposal` — community proposals for new TLDs
- `ServiceNode` — overlay network nodes (one per domain)
- `Relay` — overlay network relay servers

## Deployment

- **Web**: Push to main → GitHub Actions → Cloudflare Pages (`tnp.network`)
- **API**: Push to main (changes in `apps/api/`) → GitHub Actions → SSH deploy → Docker on DigitalOcean droplet (`api.tnp.network`)
- **SSL**: Cloudflare proxy (flexible mode) — HTTPS terminated at Cloudflare edge
- **DB**: DigitalOcean managed MongoDB (`db-oxy` cluster), database `tnp-production`
- **Installer**: `curl -fsSL https://get.tnp.network | sh` (served by API via Host header routing)

## Client CLI

Interactive menu when run with no args (`tnp`). Also supports direct commands:

```
tnp                  # Interactive menu (arrow keys, settings, status, become a node)
tnp run              # DNS resolver daemon (foreground)
tnp connect          # Overlay client (DNS + SOCKS5 proxy)
tnp serve            # Host a service on a TNP domain
tnp relay            # Run as a community relay node
tnp install          # Install as system service
tnp uninstall        # Remove system service
tnp status           # Check resolver status
tnp test <domain>    # Test domain resolution
```

### Key client modules (packages/client/src/)
- `interactive.ts` — Interactive terminal menu (ASCII UI, arrow navigation, settings editor)
- `proxy.ts` — DNS proxy (returns 127.0.0.1 for overlay domains → routes to SOCKS5)
- `socks.ts` — SOCKS5 proxy (RFC 1928, routes TNP domains through encrypted tunnels)
- `tunnel.ts` — WebSocket tunnel manager (circuit multiplexing, E2E encryption)
- `crypto.ts` — NaCl crypto (X25519 + XSalsa20-Poly1305 via tweetnacl, pure JS)
- `service-node.ts` — Service node mode (`tnp serve`)
- `relay-node.ts` — Embedded relay node (from interactive menu → "Become a Node")
- `frames.ts` — Binary frame protocol (DATA/OPEN/OPENED/CLOSE/ERROR, matches apps/relay)

## Oxy SDK Conventions

- **Versions**: `@oxyhq/core ^3.11.0`, `@oxyhq/auth ^5.1.1`, `@oxyhq/bloom ^0.19.1`, `@oxyhq/contracts ^0.3.0` (transitive via core). **3.11.0 / auth 5.1.1:** self-sovereign identity layer (did:web, signed records, export, domain verify) + "Sign in with Oxy" (shared-keychain SSO + cross-device QR/deep-link handoff via `Commons by Oxy`). **Accounts is now keyless "Accounts by Oxy"** (management-only; identity creation moved to Commons).
- **Media**: avatars/images resolve ONLY through `oxyServices.getFileDownloadUrl(id, variant)` + bloom's variant-aware `<Avatar source={fileId} variant="thumb">`. Never hardcode `cloud.oxy.so` or `/media/` URLs.
- **Display names**: render `name.displayName` directly. No local name fallbacks.
- **Backend auth**: `@oxyhq/core/server` only — `createOxyAuthMiddleware`/`getRequiredOxyUserId`. No local auth middleware.
- **SSRF**: `safeFetch` from `@oxyhq/core/server` for all outbound HTTP in the API.
- **DNS/parking IP (CRITICAL)**: parking IP is env-driven — `TNP_PARKING_IP` and `TNP_PUBLIC_DNS` MUST be set to the AWS NLB EIP at deploy time. Hardcoding IP values is forbidden.
- **`packages/client` typecheck gate**: `packages/client` has a typecheck CI gate — `bun run tsc --noEmit` must pass before merge.

## Dependencies

- `@oxyhq/core ^3.11.0`, `@oxyhq/auth ^5.1.1`, `@oxyhq/bloom ^0.19.1` — Oxy platform integration (SSO, auth)
- `tweetnacl` — Pure JS crypto (X25519, XSalsa20-Poly1305) in client package
- `dns2` — DNS packet encoding/decoding in client package
- `react-i18next`, `i18next` — Internationalization
- `i18next-http-backend` — Lazy-load translation files
- `i18next-browser-languagedetector` — Browser language detection

## Oxy Auth / Session Contract

- Web auth uses `WebOxyProvider` with a registered `clientId`; SDK cold boot owns callback consumption, stored-session restore, FedCM/silent restore, and SSO bounce.
- Do not add local `/__oxy/sso-callback` routes, copied SSO helpers, token providers, auth interceptors, manual `Authorization` plumbing, refresh retries, or app-local session invalidation.
- Backend APIs use `@oxyhq/core/server` (`createOxyAuthMiddleware`, `createOptionalOxyAuth`, `createOxyRateLimit`, `requireOxyAuth`, `getRequiredOxyUserId`, `authSocket`) and must not define local `AuthRequest`, `requireAuth`, `getUserId`, bearer parsers, or token-decoding middleware.
- Bearer-authenticated writes do not fetch app-local CSRF tokens; CSRF remains for ambient cookie credentials and cookie-only writes.
