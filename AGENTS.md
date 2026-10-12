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

Rules that override convenience:
- **Never shadow a public DNS name.** A `public-dns` name resolves identically
  with and without TNP. `naming.md` is normative.
- **A proxy is not a VPN.** No CLI, UI or doc string may call the local proxy a
  VPN.
- **No anonymity claims.** Multi-hop is not implemented; even when it is, the
  wording rules in `privacy-model.md` §6 apply.
- **Services never become a network dependency.** Public domains/DNS/hosting
  (#62) live in `apps/api/src/services/`, are off by default, and nothing in the
  network path imports them. A `.com` is never a native name. `services.md` is
  normative.

## Commands

```bash
bun run dev                 # Both API & web (concurrent)
bun run dev:api             # API only (Bun watch)
bun run dev:web             # Web only (Vite)
bun run seed                # Seed database with initial TLDs
bun run lint                # Biome lint + format check (CI runs `bunx biome ci .`)
bun run lint:fix            # Biome safe fixes + formatting
cd apps/web && bun run build        # Build web (tsc + vite build)
cd packages/client && bun run build # Compile CLI to binary (dist/tnp)
```

## Architecture

Still uses `apps/` layout (not yet migrated to the `packages/` standard):

```
apps/
  api/            @tnp/api          Bun + Express 5.2 / drizzle-orm + PostgreSQL / @oxy.so/core
  web/            @tnp/web          Vite 8 / React 19 / TailwindCSS 4.2 / React Router 7 / react-i18next
  dns-server/     @tnp/dns-server   Public DNS resolver (runs the client DnsProxy)
  relay/          @tnp/relay        Standalone relay: env config around @tnp/relay-core
packages/
  client/         @tnp/client       Interactive CLI, DNS proxy, SOCKS5 proxy, tunnel manager,
                                    service node, embedded relay (compiles to standalone binary)
  crypto/         @tnp/crypto       Grants, key-agreement certs, domain keys, primitives
  namespace/      @tnp/namespace    TLD policy, reserved set, name classification
  protocol/       @tnp/protocol     Wire protocol v1: frames, Noise NK session, overlay codecs
  relay-core/     @tnp/relay-core   THE relay (routing, service-node auth, bounds) + Bun binding
  shared-types/   @tnp/shared-types Request/response contracts (relays, service nodes, domains,
                                    DNS records, resolve) and the parsers the API and web use
```

## How It Works

1. User registers at TNP web via device-first Oxy sign-in (`OxyProvider` from `@oxy.so/services`)
2. User registers domains on TNP-native TLDs (`.ox` today); public-root and special-use TLDs are always refused
3. User manages DNS records via web dashboard
4. Client CLI daemon resolves TNP domains locally (intercepts DNS queries)
5. A native name without a target may receive the configured parking A record; the API serves the branded page from its original Host header
6. Service nodes expose local services through the overlay network (encrypted tunnels via relays)

## i18n

Web app: `react-i18next`, 5 languages (en, zh, es, hi, fr). Translation files: `apps/web/public/locales/{lng}/{ns}.json`. Namespaces: common, home, explore, register, domains, domainDetail, dashboard, serviceNodes, network, propose, install, park, services. Language detection: localStorage (`tnp-lang`) → browser → HTML tag.

## Models

`users`, `domains`, `dns_records`, `tlds`, `tld_proposals`, `service_nodes`, `relays`, `votes`, `dns_rule_sets` (`apps/api/src/db/schema/`). DNS records are their own table, not a nested document: they are queried by `(domain_id, name, type)` on every resolve, and that is an index.

## Deployment

- **Web**: CF Pages (`tnp.network`) via `deploy.yml`, gated on CI, with the locked `wrangler` devDependency (never `bunx wrangler@…`). The worker sets every security header (strict CSP, HSTS, COOP `same-origin-allow-popups` for the Oxy sign-in popup) in `apps/web/worker/security-headers.js`; a new origin the dashboard calls goes in `connect-src` there or the browser blocks it
- **API, DNS and relay images**: **ECS Fargate in us-west-2**. After the gates pass on `main`, `ci.yml` calls the artefact-only `deploy-aws.yml`, which publishes `linux/arm64` images under the full Git SHA and records their digests. It does not move `latest`, register task definitions, roll out ECS, scale services, or activate traffic.
- **Infra is owned by `~/Oxy/oxy-infra`** (`terraform-uswest2/app-tnp.tf`): ECR repos `oxy/tnp-{api,dns,relay}`, ECS services on `oxy-cluster`, ALB target groups with `/health`. Do not create TNP AWS resources from this repo.
- **API/DNS are active; relay is publishable, activated by an oxy-infra pin.** The publisher never changes service counts. Promote only a reviewed immutable digest after verifying the current task definition, database, secrets, health checks and traffic path. Relay activation also needs `RELAY_ENDPOINT`/`RELAY_KEY_SEED`, the API's `TNP_OXY_RELAYS` and `TNP_DIRECTORY_SIGNING_SEED` (`relays.md` §8).
- **DB**: **PostgreSQL** via drizzle-orm + postgres.js, like Mention and oxy-api. Migrations in `apps/api/drizzle/`, applied by the app at startup (`src/db/migrate.ts`) so it cannot serve against a schema it has not migrated. `bun run db:generate` writes a migration; never hand-edit one.
- **Relays are selectable only through the signed directory** (`GET /relays/directory`, key pinned in `@tnp/shared-types`); never add an unsigned fallback (`discovery.md` §2).
- **SSL**: Cloudflare proxy; origin is HTTPS at the ALB (zone SSL mode is set outside this repo — verify it is Full (strict))
- **Installer**: `curl -fsSL https://get.tnp.network | sh` (served by API via Host header routing)

## Client CLI (`packages/client`)

```
tnp                  # Interactive menu (arrow keys, settings, status, become a node)
tnp run              # DNS resolver daemon (foreground)
tnp connect          # Overlay client (DNS + SOCKS5 proxy)
tnp serve            # Host a service on a TNP domain
tnp relay            # Run as a community relay node (--endpoint is the public
                     #   URL clients dial, not the --host/--port bind address)
tnp domain key init|show|rotate <name> / domain grant   # domain keys, node grants
tnp pins [forget <name>]                                 # pinned domain keys (TOFU)
tnp install / uninstall [--purge] / status / test <domain>
                     # tokens: TNP_TOKEN or --token-stdin (--token is deprecated)
```

Key modules in `packages/client/src/`:
- `interactive.ts` — ASCII UI, arrow navigation, settings editor
- `proxy.ts` — DNS proxy (returns 127.0.0.1 for overlay domains → routes to SOCKS5)
- `socks.ts` — SOCKS5 proxy (RFC 1928), native names only
- `tunnel.ts` — verified v1 circuits to service nodes (one stream per circuit, pooled relay links)
- `service-node.ts` (`tnp serve`), `relay-node.ts` (registry + `@tnp/relay-core`), `crypto.ts` (relay identity key only)
- `overlay/` — `verify` (pin → chain → cert), `pins`, `identity` (domain/node keys, grants, certs), `secure-circuit`, `pipe` (backpressure), `store` (per-user 0600 key dir)

## Gotchas

- **DNS/parking IP**: `TNP_PARKING_IP` and `TNP_PUBLIC_DNS` MUST be set to the AWS NLB EIP at deploy time. Never hardcode IP values.
- **Gates**: `bun run typecheck` and `bun run test` at the repo root fan out to every workspace with `bun run --filter '*'` and exit non-zero if any fails. `ci.yml` runs both on every PR, and both deploy workflows `needs:` them, so a red `main` cannot ship. Run them locally before pushing. `ci.yml` also runs `bunx biome ci .` (root `biome.json`); `release-client.yml` releases only when `VERSION` in `packages/client/src/cli.ts` has no `v<VERSION>` tag, and never updates an existing release: bump `VERSION` (and `interactive.ts`'s) to ship client changes. Releases are Ed25519-signed (`security.md` §7) and the installers refuse an unsigned one, so bump `CLIENT_VERSION` in `apps/api/src/routes/client.ts` only once that release is published.
- **`apps/dns-server` imports `packages/client` by relative path** without declaring the dependency. That is why audit B1 (a `TnpConfig` built with 5 of 18 required fields) went unnoticed for so long. The resolver now takes a narrow `DnsProxyConfig` instead, but the relative import stands until Phase 2 extracts `@tnp/resolver` — do not add more cross-workspace relative imports; extract a package instead.
- **`@tnp/relay-core` is the only relay**: `apps/relay` and `relay-node.ts` are bindings around it. Transport spec: `transport.md` §6, §9, §11; trust model (domain keys, pinning, no Oxy root): `security.md` §1.
- **A request body is a contract, and a contract lives in `@tnp/shared-types`.** Never write a request shape twice. An API route validates with the package's parser and destructures the parsed value; the client builds a value of the same declared type. Both hold for the relay, service-node and DNS-record endpoints; move any other endpoint the same way when you touch it, rather than hand-matching a new literal against a route you read once — that is exactly how `registerRelay` came to send `{port, location}` to an endpoint requiring `{endpoint, publicKey, operator, capacity}` for the whole life of the feature (audit B2). The gate is two-sided and both halves are needed: `packages/client/src/api.contract.test.ts` captures the bytes the real client sends and feeds them to the real parser, `apps/api/src/routes/*.contract.test.ts` drives the real router over HTTP with no database (a rejected body is a 400 from the contract, an accepted one reaches the handler and 500s at `getDb()`).
- **A new workspace package must be added to every Dockerfile that installs the graph containing it.** Bun resolves the whole workspace before installing anything, so one missing `COPY <pkg>/package.json` fails the install with `@tnp/<name>@workspace:* failed to resolve` no matter how unrelated that package is to the image. Only `Dockerfile.api` is built in CI, so `Dockerfile.dns` silently broke this way once already.
- **The API is assembled in `apps/api/src/app.ts`** (headers, per-address then per-account rate limits, request timeout, auth); `index.ts` only builds the services router and starts it. Relay `operator` is decided by the API from `TNP_OXY_RELAY_OPERATORS`, never by the relay. API env vars: `docs/api.mdx`.
- **Privileged client code never builds shell strings.** New system commands go through `system-cmd.ts` as argv with tools from system dirs (not `$PATH`); decide them in a pure function and unit-test it, since Windows/macOS paths cannot run in CI. The kill switch is DNS-only and fail-closed (`killswitch.ts`, `platforms.md` §4); services run an admin-only binary copy, never `process.argv[1]`.
- **Personal DNS rules** (naming.md §3): `/me/dns-rules` holds one opaque envelope per user; never add a rule-shaped field.
- **Key deps**: `tweetnacl`, `@noble/ciphers` + `@noble/hashes` (pinned, in `@tnp/crypto`), `dns-packet` (DNS wire format in client), `react-i18next` + `i18next` + `i18next-http-backend` + `i18next-browser-languagedetector` (web i18n).
