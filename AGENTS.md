# TNP (The Network Protocol)

Alternative internet namespace system for custom TLDs. Agent: `tnp`.

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

Still uses `apps/` layout (not yet migrated to the `packages/` standard):

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

1. User registers at TNP web via device-first Oxy sign-in (`OxyProvider` from `@oxyhq/services`)
2. User registers domains on custom TLDs (.ox, .app, etc.)
3. User manages DNS records via web dashboard
4. Client CLI daemon resolves TNP domains locally (intercepts DNS queries)
5. Unhosted domains show a branded parking page via DNS fallback → redirect → `/park/:domain`
6. Service nodes expose local services through the overlay network (encrypted tunnels via relays)

## i18n

Web app: `react-i18next`, 5 languages (en, zh, es, hi, fr). Translation files: `apps/web/public/locales/{lng}/{ns}.json`. Namespaces: common, home, explore, register, domains, domainDetail, dashboard, serviceNodes, network, propose, install, park. Language detection: localStorage (`tnp-lang`) → browser → HTML tag.

## Models

`User`, `Domain`, `TLD`, `TLDProposal`, `ServiceNode`, `Relay`

## Deployment

- **Web**: CF Pages (`tnp.network`) via `deploy-cloudflare.yml` — NOT on ECS
- **API**: SSH deploy → Docker on DigitalOcean droplet (`api.tnp.network`) — NOT on ECS
- **DB**: DigitalOcean managed MongoDB (`db-oxy` cluster), database `tnp-production`
- **SSL**: Cloudflare proxy (flexible mode)
- **Installer**: `curl -fsSL https://get.tnp.network | sh` (served by API via Host header routing)

## Client CLI (`packages/client`)

```
tnp                  # Interactive menu (arrow keys, settings, status, become a node)
tnp run              # DNS resolver daemon (foreground)
tnp connect          # Overlay client (DNS + SOCKS5 proxy)
tnp serve            # Host a service on a TNP domain
tnp relay            # Run as a community relay node
tnp install / uninstall / status / test <domain>
```

Key modules in `packages/client/src/`:
- `interactive.ts` — ASCII UI, arrow navigation, settings editor
- `proxy.ts` — DNS proxy (returns 127.0.0.1 for overlay domains → routes to SOCKS5)
- `socks.ts` — SOCKS5 proxy (RFC 1928)
- `tunnel.ts` — WebSocket tunnel manager (circuit multiplexing, E2E encryption)
- `crypto.ts` — NaCl crypto (X25519 + XSalsa20-Poly1305 via tweetnacl, pure JS)
- `service-node.ts`, `relay-node.ts`, `frames.ts` (binary frame protocol DATA/OPEN/OPENED/CLOSE/ERROR)

## Gotchas

- **DNS/parking IP**: `TNP_PARKING_IP` and `TNP_PUBLIC_DNS` MUST be set to the AWS NLB EIP at deploy time. Never hardcode IP values.
- **`packages/client` typecheck gate**: `bun run tsc --noEmit` must pass before merge — enforced by CI.
- **Key deps**: `tweetnacl` (X25519/XSalsa20 in client), `dns2` (DNS encoding in client), `react-i18next` + `i18next` + `i18next-http-backend` + `i18next-browser-languagedetector` (web i18n).
