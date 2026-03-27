# TNP -- The Network Protocol

TNP is an alternative internet namespace controlled by Oxy. It lets anyone register domains on TLDs that only exist within the TNP network -- `.ox`, `.app`, `.com`, and community-proposed TLDs.

TNP is DNS-only. It does not route traffic, does not act as a VPN, and does not touch anything except name resolution. Install the TNP client once, and every TNP domain resolves natively on your device -- browsers, CLI tools, APIs, everything.

Domains are tied to your Oxy account. Register at [tnp.network](https://tnp.network), manage your DNS records, and propose new TLDs to the community.

## Tech stack

- **Frontend**: Vite + React 19 + TypeScript + Tailwind CSS
- **Backend**: Bun + Express 5 + TypeScript + MongoDB (Mongoose 9)
- **Client**: Go DNS resolver daemon (scaffold)
- **Auth**: Oxy SSO with JWT sessions

## Getting started

### Prerequisites

- Node.js 20+
- Bun (for the API server)
- MongoDB (local or remote)

### Setup

```bash
# Clone the repo
git clone https://github.com/OxyHQ/tnp.git
cd tnp

# Install dependencies
npm install

# Configure environment
cp apps/api/.env.example apps/api/.env
# Edit apps/api/.env with your MongoDB URI and secrets

# Seed the database with initial TLDs
npm run seed

# Start both frontend and API
npm run dev
```

The frontend runs at `http://localhost:5173` and the API at `http://localhost:3000`.

### Environment variables

**API** (`apps/api/.env`):

| Variable | Description | Default |
|---|---|---|
| `MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017` |
| `JWT_SECRET` | Secret for signing JWTs | (required) |
| `OXY_SSO_SECRET` | Secret for verifying Oxy SSO tokens | (required) |
| `PORT` | API server port | `3000` |
| `NODE_ENV` | Environment name (used in DB name) | `development` |

**Web** (`apps/web/.env`):

| Variable | Description | Default |
|---|---|---|
| `VITE_API_URL` | API base URL | `http://localhost:3000` |

## API reference

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/oxy` | No | Oxy SSO callback. Body: `{ oxyUserId }`. Returns JWT token. |

### TLDs

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/tlds` | No | List all active TLDs |
| POST | `/tlds/propose` | Yes | Propose a new TLD. Body: `{ tld, reason }` |
| GET | `/tlds/proposals` | No | List all TLD proposals, sorted by votes |

### Domains

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/domains` | No | Public directory. Query: `?page=&limit=` |
| GET | `/domains/search?q=` | No | Search domains by name |
| GET | `/domains/check/:name.:tld` | No | Check domain availability |
| POST | `/domains/register` | Yes | Register a domain. Body: `{ name, tld }` |
| GET | `/domains/mine` | Yes | Get authenticated user's domains |
| DELETE | `/domains/:id` | Yes | Release a domain (must be owner) |

### DNS Records

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/domains/:id/records` | No | Get all DNS records for a domain |
| POST | `/domains/:id/records` | Yes | Add a record. Body: `{ type, name, value, ttl }` |
| PUT | `/domains/:id/records/:rid` | Yes | Update a record |
| DELETE | `/domains/:id/records/:rid` | Yes | Delete a record |

### Client

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/client/latest` | No | Latest daemon version + download URLs |

## Project structure

```
tnp/
  apps/
    web/          # Vite + React frontend
    api/          # Bun + Express API
  packages/
    client/       # Go DNS daemon (scaffold)
```

## Contributing

See [.github/README.md](.github/README.md) for contributing guidelines.

## License

MIT
