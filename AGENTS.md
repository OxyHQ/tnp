# TNP (The Network Protocol)

Universal network layer over the public internet: its own namespace, resolution, NAT-traversing service publication and an overlay transport (onion routing, exit nodes and an OS tunnel are planned). Not "DNS-only": that phrasing is retired.

## Commands

```bash
bun install
bun run dev                          # API + web; dev:api / dev:web run one
bun run seed                         # seed initial TLDs
bun run typecheck && bun run test    # fan out to every workspace; CI runs both
bun run lint                         # Biome; CI runs `bunx biome ci .`
bun run lint:fix                     # Biome safe fixes + format
bun run test:db                      # API tests that need Postgres
bun run validate:boundaries          # import-boundary gate
bun run validate:agents-md           # byte budget for this file
cd apps/web && bun run build         # tsc + vite build
cd packages/client && bun run build  # compile the CLI binary (dist/tnp)
```

## Map

- `docs/architecture/` is normative: read `overview.md`, then the layer doc for what you touch. `audit-2026-08-06.md` says where docs and code disagree.
- `docs/agent-rules.md`: workspace layout, deployment, client CLI, and the gotchas that do not fit here. Read it before touching deploys, the client, contracts or Dockerfiles.
- `docs/api.mdx` lists API env vars. The API is assembled in `apps/api/src/app.ts`.

## Conventions

- A request body lives once, in `@tnp/shared-types`; routes and client both use its parser. Why: a hand-matched literal shipped a wrong `registerRelay` body for the life of the feature.
- Drizzle migrations come from `bun run --cwd apps/api db:generate`, never by hand. Why: CI's `db:check-locks` refuses long locks on hot tables.
- Privileged client code builds argv through `system-cmd.ts`, never shell strings. Why: Windows/macOS paths cannot run in CI.
- Do not add cross-workspace relative imports; extract a package. A new workspace package gets a `COPY <pkg>/package.json` in every Dockerfile that installs the graph.
- Use the locked `wrangler` devDependency, never `bunx wrangler@...`.

## Boundaries

Never:
- Shadow a public DNS name: a `public-dns` name resolves identically with and without TNP (`naming.md`).
- Call the local proxy a VPN, or make anonymity claims (`privacy-model.md` section 6). Multi-hop is not implemented.
- Describe the WireGuard VPN as anonymous: Oxy runs it and sees destinations (`vpn.md` section 10).
- Import `apps/api/src/services/` from the network path, or make a `.com` a native name (`services.md`). Why: services must never become a network dependency.
- Hardcode `TNP_PARKING_IP` / `TNP_PUBLIC_DNS`; they are the AWS NLB EIP set at deploy.
- Add an unsigned relay fallback or a rule-shaped field to `/me/dns-rules`.
- Create TNP AWS resources here; infra lives in the private `OxyHQ/oxy-infra` repo.

Ask first: promoting a relay or image digest, bumping `CLIENT_VERSION` in `apps/api/src/routes/client.ts`, and releasing the client.

## Testing

Run `bun run typecheck`, `bun run test` and `bun run lint` before pushing; a change is done when CI is green. Contract changes need both `packages/client/src/api.contract.test.ts` and `apps/api/src/routes/*.contract.test.ts` passing. Pure-function tests cover platform-specific system commands.

## Pull requests

CI gates `main`, and `deploy.yml` starts only from a green CI. Merge to `main` needs a code-owner approval for the files in `.github/CODEOWNERS`. Workflow, Dockerfile and release rules are in `docs/agent-rules.md`; shared engineering standards are at <https://github.com/OxyHQ/oxy/blob/main/docs/engineering/standards.md>.

## Secrets

Env vars come from the deploy environment and local `.env` (see `.env.example`); never print or commit values.

## Links

- Lint and format: <https://github.com/OxyHQ/oxy/blob/main/docs/engineering/lint-and-format.md>
- Gate writing: <https://github.com/OxyHQ/oxy/blob/main/docs/engineering/gate-writing.md>
- Postgres and Drizzle: <https://github.com/OxyHQ/oxy/blob/main/docs/postgres-and-drizzle.md>
- Build and runtime traps: <https://github.com/OxyHQ/oxy/blob/main/docs/engineering/build-and-runtime-traps.md>

Owner: OxyHQ (CODEOWNERS). Last reviewed: 2026-11-11.
