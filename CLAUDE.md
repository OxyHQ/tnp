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
  client/         @tnp/client       CLI client & local DNS proxy (compiles to binary)
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

## Dependencies

- `@oxyhq/core`, `@oxyhq/auth` — Oxy platform integration (SSO, auth)
- `react-i18next`, `i18next` — Internationalization
- `i18next-http-backend` — Lazy-load translation files
- `i18next-browser-languagedetector` — Browser language detection
