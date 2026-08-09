# Contributing to TNP

Thanks for your interest in contributing to TNP!

## Getting started

1. Fork the repository
2. Clone your fork
3. Install dependencies: `bun install` from the root
4. Copy environment files: `cp apps/api/.env.example apps/api/.env`
5. Start PostgreSQL locally — the `.env.example` `DATABASE_URL` matches this container:
   `docker run -d --name tnp-postgres -p 5434:5432 -e POSTGRES_PASSWORD=tnp -e POSTGRES_DB=tnp postgres:17`
   Migrations are applied by the API at startup, so there is no separate migrate step.
6. Seed the database: `bun run seed`
7. Start the dev servers: `bun run dev`

## Project structure

- `apps/web/` -- Vite + React + TypeScript frontend
- `apps/api/` -- Bun + Express + drizzle-orm/PostgreSQL backend
- `apps/dns-server/` -- public DNS resolver (UDP + TCP)
- `apps/relay/` -- WebSocket relay for the encrypted overlay
- `packages/client/` -- TypeScript CLI: local DNS proxy, SOCKS5 proxy

## Code style

- TypeScript strict mode everywhere
- No `any` types
- Proper error handling in all API routes
- No em dashes in copy or comments

## Pull requests

- Keep PRs focused on a single change
- Include a clear description of what and why
- Make sure the build passes before submitting

## License

MIT
