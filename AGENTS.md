# TNP (The Network Protocol)

Universal network layer over the public internet: its own namespace, resolution,
NAT-traversing service publication, an overlay transport, and (planned) onion
routing, exit nodes and an OS-level tunnel. **Not "DNS-only"** — that phrasing is
retired. Agent: `tnp`.

**Read `docs/architecture/` before changing anything.** Start with
`overview.md`, then the layer doc for what you are touching.
`audit-2026-08-06.md` is the verified state of the code; where docs and code
disagree, the audit says which is which.

Three rules that override convenience:
- **Never shadow a public DNS name.** A `public-dns` name resolves identically
  with and without TNP. `naming.md` is normative.
- **A proxy is not a VPN.** No CLI, UI or doc string may call the local proxy a
  VPN.
- **No anonymity claims.** Multi-hop is not implemented; even when it is, the
  wording rules in `privacy-model.md` §6 apply.

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
  api/            @tnp/api          Bun + Express 5.2 / drizzle-orm + PostgreSQL / @oxyhq/core
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

`users`, `domains`, `dns_records`, `tlds`, `tld_proposals`, `service_nodes`, `relays`, `votes` (`apps/api/src/db/schema/`). DNS records are their own table, not a nested document: they are queried by `(domain_id, name, type)` on every resolve, and that is an index.

## Deployment

- **Web**: CF Pages (`tnp.network`) via `deploy.yml`, gated on CI
- **API**: **ECS Fargate in us-west-2**, behind the shared `oxy-alb` — like the other Oxy backends. `ci.yml` calls `deploy-aws.yml` after both gates pass on `main`. The old SSH-to-DigitalOcean-droplet deploy is gone; that droplet is retired and its workflow had failed on every recorded run since 2026-07-14.
- **Infra is owned by `~/Oxy/oxy-infra`** (`terraform-uswest2/app-tnp.tf`): ECR repos `oxy/tnp-{api,dns,relay}`, ECS services on `oxy-cluster`, ALB target groups with `/health`. Do not create TNP AWS resources from this repo.
- **BLOCKED**: `tnp-api` is deliberately at `desired_count = 0` until the SSM parameter `/oxy/tnp-api/DATABASE_URL` exists (the task definition still names `MONGODB_URI` and needs updating with it). Until then the deploy pushes an image and warns rather than pretending a rollout happened. `TNP_PARKING_IP` is also absent from the task definition's `environment`, so parking answers would be omitted in production.
- **DB**: **PostgreSQL** via drizzle-orm + postgres.js, like Mention and oxy-api. Migrations in `apps/api/drizzle/`, applied by the app at startup (`src/db/migrate.ts`) so it cannot serve against a schema it has not migrated. `bun run db:generate` writes a migration; never hand-edit one. Mongoose is gone.
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
- **Gates**: `bun run typecheck` and `bun run test` at the repo root fan out to every workspace with `bun run --filter '*'` and exit non-zero if any fails. `ci.yml` runs both on every PR, and both deploy workflows `needs:` them, so a red `main` cannot ship. Run them locally before pushing.
- **`apps/dns-server` imports `packages/client` by relative path** without declaring the dependency. That is why audit B1 (a `TnpConfig` built with 5 of 18 required fields) went unnoticed for so long. The resolver now takes a narrow `DnsProxyConfig` instead, but the relative import stands until Phase 2 extracts `@tnp/resolver` — do not add more cross-workspace relative imports; extract a package instead.
- **The relay implementation exists twice** — `apps/relay/src/` and `packages/client/src/relay-node.ts` — with the same bugs in both. A fix to one is not a fix.
- **Client/API request bodies are hand-matched, and currently disagree.** `registerRelay` and `sendRelayHeartbeat` send shapes the API rejects (audit B2). Until `@tnp/shared-types` exists, check both sides when touching either.
- **Key deps**: `tweetnacl` (X25519/XSalsa20 in client), `dns2` (DNS encoding in client), `react-i18next` + `i18next` + `i18next-http-backend` + `i18next-browser-languagedetector` (web i18n).
