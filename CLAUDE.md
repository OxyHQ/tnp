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
cd apps/api && bun run build        # Build API
cd apps/web && bun run build        # Build web (tsc + vite build)
cd packages/client && bun run build # Compile CLI to binary (dist/tnp)
```

## Architecture

Monorepo — alternative internet namespace system for custom TLDs.

```
apps/
  api/            @tnp/api          Bun + Express 5.2 / Mongoose 9.3 / @oxyhq/core
  web/            @tnp/web          Vite 8 / React 19 / TailwindCSS 4.2 / React Router 7
  dns-server/     @tnp/dns-server   DNS daemon (dns2 library)
packages/
  client/         @tnp/client       CLI client & local DNS proxy (compiles to binary)
```

## How It Works

1. User registers at TNP web via Oxy SSO
2. User registers domains on custom TLDs (.ox, .app, etc.)
3. User manages DNS records via web dashboard
4. Client CLI daemon resolves TNP domains locally (intercepts DNS queries)

## Models

- `User` — linked to Oxy accounts
- `Domain` — registered domains with DNS records
- `TLD` — top-level domains (.ox, .app, etc.)
- `TLDProposal` — community proposals for new TLDs

## Dependencies

- `@oxyhq/core`, `@oxyhq/auth` — Oxy platform integration (SSO, auth)
