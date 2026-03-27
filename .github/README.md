# Contributing to TNP

Thanks for your interest in contributing to TNP!

## Getting started

1. Fork the repository
2. Clone your fork
3. Install dependencies: `npm install` from the root
4. Copy environment files: `cp apps/api/.env.example apps/api/.env`
5. Start MongoDB locally
6. Seed the database: `npm run seed`
7. Start the dev servers: `npm run dev`

## Project structure

- `apps/web/` -- Vite + React + TypeScript frontend
- `apps/api/` -- Bun + Express + Mongoose backend
- `packages/client/` -- Go DNS resolver daemon (scaffold)

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
