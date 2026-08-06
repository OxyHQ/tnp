# TNP — The Network Protocol

TNP is a network layer that runs on top of the existing internet. It provides a
namespace of its own, resolves names in that namespace, and carries traffic to
services published inside it — without those services needing a public IP address
or an open inbound port.

Domains are tied to your Oxy account. Register at [tnp.network](https://tnp.network),
manage records, publish services, and propose new TLDs.

> **Public DNS keeps working.** A public name resolves identically with TNP
> installed and without it. TNP does not silently shadow names it does not own.
> See [namespace policy](docs/architecture/naming.md).

---

## What works today, and what does not

This table is the honest state of the code. Full evidence:
[Phase 0 audit](docs/architecture/audit-2026-08-06.md).

| Capability | State |
|---|---|
| Register TNP domains and manage records | ✅ Working |
| Resolve TNP names on your device | ✅ Working |
| Forward public DNS to an upstream | ⚠️ Works, but re-encodes some answers incorrectly and ignores the configured upstream |
| Publish a service from behind NAT (`tnp serve`) | ⚠️ Prototype — the relay does not authenticate service nodes |
| Reach a TNP service over SOCKS5 | ⚠️ Prototype — TNP destinations only, no IPv6, ignores the requested port |
| Run a relay (`tnp relay`) | ❌ Broken — registration fails against the current API |
| HTTP CONNECT proxy | ❌ Not implemented |
| Onion routing / private mode | ❌ Not implemented — `--privacy private` is rejected rather than silently downgraded |
| Exit nodes / public internet routing | ❌ Not implemented |
| Full or split tunnel VPN | ❌ Not implemented |
| Mobile apps | ❌ Not implemented |

**TNP does not provide anonymity.** It currently provides single-hop encrypted
transport plus name resolution, and the API is presently able to substitute a
service node's key. See [privacy model](docs/architecture/privacy-model.md).

## Architecture

Ten layers, nine operating modes, a versioned wire protocol.

| | |
|---|---|
| [Overview](docs/architecture/overview.md) | The layers and how they fit |
| [Glossary](docs/architecture/glossary.md) | Precise meanings |
| [Operating modes](docs/architecture/operating-modes.md) | What you can turn on, and what it costs |
| [Naming](docs/architecture/naming.md) | Namespace policy and collision rules |
| [Resolution](docs/architecture/resolution.md) | DNS |
| [Discovery](docs/architecture/discovery.md) | The signed directory |
| [Transport](docs/architecture/transport.md) | Wire protocol v1 |
| [Onion routing](docs/architecture/onion-routing.md) | Multi-hop design |
| [Security](docs/architecture/security.md) | Key hierarchy, rotation, revocation |
| [Proxy](docs/architecture/proxy.md) · [VPN](docs/architecture/vpn.md) | Application vs. OS-level |
| [Service nodes](docs/architecture/service-nodes.md) · [Relays](docs/architecture/relays.md) · [Exit nodes](docs/architecture/exit-nodes.md) | Roles |
| [Mobile](docs/architecture/mobile-expo.md) · [Platforms](docs/architecture/platforms.md) | Clients |
| [Threat model](docs/architecture/threat-model.md) · [Privacy model](docs/architecture/privacy-model.md) | What we protect and what we do not |
| [Roadmap](docs/architecture/roadmap.md) · [Migration](docs/architecture/migration.md) | What ships when |

**A proxy is not a VPN.** TNP ships a local proxy today. It does not ship a VPN,
and no part of the product may call the proxy one.

## Repository

```
apps/
  api/            @tnp/api          Bun + Express 5 + Mongoose, Oxy auth
  web/            @tnp/web          Vite + React 19 + Tailwind, 5 languages
  dns-server/     @tnp/dns-server   Public TNP resolver
  relay/          @tnp/relay        Relay server
packages/
  client/         @tnp/client       CLI, resolver, SOCKS5, tunnel, service node, embedded relay
  protocol/       @tnp/protocol     Binary frame codec
```

The target structure and the phased route to it are in
[migration.md](docs/architecture/migration.md).

## Getting started

Requires [Bun](https://bun.sh) and MongoDB.

```bash
git clone https://github.com/OxyHQ/tnp.git
cd tnp
bun install

cp apps/api/.env.example apps/api/.env   # set MONGODB_URI
bun run seed                             # seed initial TLDs
bun run dev                              # web on :8170, API on :4170
```

### Commands

```bash
bun run dev                            # web + API
bun run dev:api                        # API only
bun run dev:web                        # web only
bun run seed                           # seed TLDs
cd apps/web && bun run build           # build web
cd packages/client && bun run build    # compile the CLI to dist/tnp
cd packages/client && bun test         # client tests
cd packages/protocol && bun test       # protocol tests
```

### Environment

**API** (`apps/api/.env`):

| Variable | Description | Default |
|---|---|---|
| `MONGODB_URI` | MongoDB connection string | `mongodb://localhost:27017` |
| `PORT` | API port | `4170` |
| `NODE_ENV` | Environment name, used in the database name | `development` |
| `OXY_API_URL` | Oxy API base URL | `https://api.oxy.so` |
| `TNP_PARKING_IP` | Public DNS / parking IP. **No default** — parking answers are omitted when unset. | — |

**Web** (`apps/web/.env`):

| Variable | Description | Default |
|---|---|---|
| `VITE_API_URL` | API base URL | `http://localhost:4170` |

## Client

```bash
tnp                       # interactive menu
tnp run                   # resolver daemon
tnp connect               # resolver + SOCKS5 proxy
tnp serve <domain> --target <url>
tnp relay                 # currently broken, see the audit
tnp install / uninstall / status / test <domain>
```

## API

Base URL `https://api.tnp.network`. Auth is an Oxy bearer token validated through
`@oxyhq/core`; the web app mounts a single device-first `OxyProvider` from
`@oxyhq/services`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/tlds` | — | Active TLDs |
| `POST` | `/tlds/propose` | ✔ | Propose a TLD |
| `GET` | `/tlds/proposals` | — | Proposals by votes |
| `GET` | `/domains` | — | Public directory |
| `GET` | `/domains/search?q=` | — | Search |
| `GET` | `/domains/check/:name.:tld` | — | Availability |
| `POST` | `/domains/register` | ✔ | Register |
| `GET` | `/domains/mine` | ✔ | Your domains |
| `DELETE` | `/domains/:id` | ✔ | Release |
| `GET` | `/domains/:id/records` | — | Records |
| `POST` `PUT` `DELETE` | `/domains/:id/records[/:rid]` | ✔ | Manage records |
| `GET` | `/dns/resolve?name=&type=` | — | Resolve a TNP name |
| `GET` | `/dns/tlds` | — | TLD policy table |
| `POST` | `/nodes/register` · `/nodes/heartbeat` | ✔ | Service nodes |
| `GET` | `/nodes/:domain` | — | Look up a service node |
| `GET` | `/relays` | — | Relay directory |
| `POST` | `/relays/register` · `/relays/heartbeat` | ✔ | Relays |
| `GET` | `/client/latest` | — | Client version and downloads |

## Out of scope

Not implemented, and no adapters, mocks or interfaces for them: OpenProvider,
ICANN reseller integration, traditional domain sale, transfer or renewal, the
reseller system, FairCoin payments, checkout and billing, ICANN registrar
accreditation.

## Contributing

Read [the audit](docs/architecture/audit-2026-08-06.md) and
[the roadmap](docs/architecture/roadmap.md) first. One task per pull request,
referencing an issue, with tests and stated risks.

## License

MIT
