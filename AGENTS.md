# TNP (The Network Protocol)

> **Budget: under 12 KB**, enforced by `scripts/check-agents-md-size.mjs`
> (`bun run validate:agents-md`). It is prepended to EVERY agent session, so its
> bytes are paid on every task forever, and it grows by accretion — one
> reasonable paragraph at a time, invisible per-commit. An addition that pushes
> it over is paid for in the SAME edit: compress something, or move it to
> `docs/` and leave a pointer.

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
  namespace/      @tnp/namespace    TLD policy, reserved set, name classification
  protocol/       @tnp/protocol     Binary frame codec
  shared-types/   @tnp/shared-types Request/response contracts for the relay and service-node
                                    endpoints, and the parsers the API validates with
```

## How It Works

1. User registers at TNP web via device-first Oxy sign-in (`OxyProvider` from `@oxyhq/services`)
2. User registers domains on TNP-native TLDs (`.ox` today); public-root and special-use TLDs are always refused
3. User manages DNS records via web dashboard
4. Client CLI daemon resolves TNP domains locally (intercepts DNS queries)
5. A native name without a target may receive the configured parking A record; the API serves the branded page from its original Host header
6. Service nodes expose local services through the overlay network (encrypted tunnels via relays)

## i18n

Web app: `react-i18next`, 5 languages (en, zh, es, hi, fr). Translation files: `apps/web/public/locales/{lng}/{ns}.json`. Namespaces: common, home, explore, register, domains, domainDetail, dashboard, serviceNodes, network, propose, install, park. Language detection: localStorage (`tnp-lang`) → browser → HTML tag.

## Models

`users`, `domains`, `dns_records`, `tlds`, `tld_proposals`, `service_nodes`, `relays`, `votes` (`apps/api/src/db/schema/`). DNS records are their own table, not a nested document: they are queried by `(domain_id, name, type)` on every resolve, and that is an index.

## Deployment

- **Web**: CF Pages (`tnp.network`) via `deploy.yml`, gated on CI
- **API and DNS images**: **ECS Fargate in us-west-2** is the planned runtime. After both gates pass on `main`, `ci.yml` calls the artefact-only `deploy-aws.yml`, which publishes `linux/arm64` API and DNS images under the full Git SHA and records their digests. It does not move `latest`, register task definitions, roll out ECS, scale services, or activate traffic. The old SSH-to-DigitalOcean deploy is gone.
- **Infra is owned by `~/Oxy/oxy-infra`** (`terraform-uswest2/app-tnp.tf`): ECR repos `oxy/tnp-{api,dns,relay}`, ECS services on `oxy-cluster`, ALB target groups with `/health`. Do not create TNP AWS resources from this repo.
- **PARKED**: all three TNP ECS services are intended to remain inactive. Before writing either image, the publisher requires the exact service set and proves `desiredCount`, `runningCount`, and `pendingCount` are all zero; any non-zero/missing count or missing/renamed service fails closed. It never changes a count itself. Activation requires a separate reviewed infra change that pins an approved digest and proves the database, secrets, health checks, and traffic path.
- **DB**: **PostgreSQL** via drizzle-orm + postgres.js, like Mention and oxy-api. Migrations in `apps/api/drizzle/`, applied by the app at startup (`src/db/migrate.ts`) so it cannot serve against a schema it has not migrated. `bun run db:generate` writes a migration; never hand-edit one.
- **Relay is not publishable or deployable**: it is deliberately absent from the AWS image matrix and remains parked until the authentication, ownership, isolation, bounds, signed-directory, duplication, and test blockers in `docs/architecture/relays.md` are closed.
- **SSL**: Cloudflare proxy (flexible mode)
- **Installer**: `curl -fsSL https://get.tnp.network | sh` (served by API via Host header routing)

## Client CLI (`packages/client`)

```
tnp                  # Interactive menu (arrow keys, settings, status, become a node)
tnp run              # DNS resolver daemon (foreground)
tnp connect          # Overlay client (DNS + SOCKS5 proxy)
tnp serve            # Host a service on a TNP domain
tnp relay            # Run as a community relay node (--endpoint is the public
                     #   URL clients dial, not the --host/--port bind address)
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
- **A request body is a contract, and a contract lives in `@tnp/shared-types`.** Never write a request shape twice. An API route validates with the package's parser and destructures the parsed value; the client builds a value of the same declared type. Both hold for the relay and service-node endpoints; move any other endpoint the same way when you touch it, rather than hand-matching a new literal against a route you read once — that is exactly how `registerRelay` came to send `{port, location}` to an endpoint requiring `{endpoint, publicKey, operator, capacity}` for the whole life of the feature (audit B2). The gate is two-sided and both halves are needed: `packages/client/src/api.contract.test.ts` captures the bytes the real client sends and feeds them to the real parser, `apps/api/src/routes/*.contract.test.ts` drives the real router over HTTP with no database (a rejected body is a 400 from the contract, an accepted one reaches the handler and 500s at `getDb()`).
- **A new workspace package must be added to every Dockerfile that installs the graph containing it.** Bun resolves the whole workspace before installing anything, so one missing `COPY <pkg>/package.json` fails the install with `@tnp/<name>@workspace:* failed to resolve` no matter how unrelated that package is to the image. Only `Dockerfile.api` is built in CI, so `Dockerfile.dns` silently broke this way once already.
- **Key deps**: `tweetnacl` (X25519/XSalsa20 in client), `dns2` (DNS encoding in client), `react-i18next` + `i18next` + `i18next-http-backend` + `i18next-browser-languagedetector` (web i18n).
