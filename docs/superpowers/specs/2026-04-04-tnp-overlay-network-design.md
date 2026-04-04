# TNP Overlay Network Design

## Context

TNP (The Network Protocol) currently provides custom TLD registration and DNS resolution for the Oxy ecosystem. Users register domains like `example.ox`, configure DNS records, and install a client that intercepts DNS queries to resolve TNP domains.

**The problem:** TNP is DNS-only. It resolves names but doesn't route traffic. Self-hosted services behind NAT can't be reached. There's no privacy layer. TNP is a namespace, not a network.

**The goal:** Evolve TNP into "the Oxy internet inside the internet" — a Tor-like overlay network where users can host and access services on custom domains (`.ox`, `.app`), with traffic routed through Oxy relay infrastructure, and optional anonymity through onion routing. Users choose their privacy level: basic access (single-hop) or full anonymity (multi-hop onion routing). Both Oxy-operated and community relay nodes are supported.

## Architecture Overview

```
[TNP Client]  --wss-->  [Relay Node(s)]  --wss-->  [Service Node]
   |                         |                          |
   DNS proxy              Forwards                   Decrypts &
   SOCKS5 proxy           encrypted frames           forwards to
   Tunnel manager         (cannot read)              localhost:80
   Crypto layer
```

**Transport:** WebSocket over TLS (port 443). Chosen for universal NAT/firewall traversal, Bun-native support, and clean onion routing layering.

**Encryption:** `tweetnacl` (pure JS, zero native deps). X25519 key agreement + XSalsa20-Poly1305 authenticated encryption. Same primitives used by Tor and Signal.

**Approach chosen over:**
- WireGuard mesh (no pure-JS impl, requires tun device + root, UDP blocked by firewalls)
- HTTP/3 MASQUE (Bun has no HTTP/3 support, Phase 1 would be identical to WebSocket anyway)

## Components

### 1. Client (`packages/client/`)

The existing DNS proxy daemon gains three new modules:

**`socks.ts` — Local SOCKS5 Proxy**
- Listens on `127.0.0.1:1080`
- When a connection targets a TNP domain:
  1. Queries directory API for the domain's service node info (public key, connected relay)
  2. Opens a WebSocket tunnel through the relay
  3. Performs X25519 key exchange with the service node
  4. Pipes encrypted traffic through the tunnel

**`tunnel.ts` — WebSocket Tunnel Manager**
- Manages WebSocket connections to relay nodes
- Multiplexes multiple domain connections over a single relay connection using circuit IDs
- Handles reconnection, keepalive, and circuit rotation

**`crypto.ts` — NaCl Crypto Layer**
- X25519 ephemeral key agreement (per-circuit)
- XSalsa20-Poly1305 encryption via `tweetnacl`
- For onion mode: layered encryption — one NaCl box per hop, each relay peels one layer

**DNS proxy change (`proxy.ts`):**
- For TNP domains, returns `127.0.0.1` instead of the real IP
- System routes the connection to the local SOCKS5 proxy
- SOCKS5 handles tunnel routing based on domain name

**New CLI commands (`cli.ts`):**
- `tnp serve` — run as a service node (expose local server to the TNP network)
- `tnp relay` — run as a community relay node
- `tnp connect --privacy access|private` — set privacy level
- `tnp connect --full-tunnel` — route all traffic through Oxy (Phase 4)

**Config extension (`config.ts`):**
```json
{
  "privacyLevel": "access",
  "socksPort": 1080,
  "relayPreference": "oxy",
  "identity": {
    "publicKey": "...",
    "secretKeyPath": "/etc/tnp/identity.key"
  }
}
```

### 2. Service Node (`packages/client/src/service-node.ts`)

When a domain owner runs `tnp serve`, their machine becomes a service node:

1. **Auth** — Authenticates with Oxy SSO (reuses existing auth flow)
2. **Identity** — Generates Ed25519 keypair on first run. Public key registered in directory.
3. **Relay connection** — Opens persistent WebSocket to one or more relay nodes (`wss://relay.tnp.network/service`)
4. **Traffic handling** — Relay forwards encrypted WebSocket frames. Service node decrypts (X25519 + XSalsa20) and forwards plaintext to local server (default `localhost:80`, configurable).
5. **Heartbeat** — Periodic liveness pings to directory API

Key property: service owner's machine is never directly exposed. All traffic flows through relays. Only outbound WebSocket access needed — no port forwarding, no public IP.

### 3. Relay Node (`apps/relay/`)

New standalone Bun server using `Bun.serve()` with WebSocket upgrade.

**Two connection types:**
- **Service nodes** connect on `/service` — persistent WebSocket. Relay maps `domain -> connection`.
- **Clients** connect on `/tunnel` — ephemeral WebSocket. Client specifies target domain/circuit.

**Relay behavior:**
- Receives client request for `example.ox`
- Looks up domain in local connection table
- If service node is connected to this relay: forward frames directly
- If not: forward to another relay that has the service node (relay-to-relay peering)
- Relay never decrypts content — only sees encrypted NaCl boxes

**Two operator types:**
- **Oxy relays:** Run by Oxy, guaranteed uptime, default for new users
- **Community relays:** Anyone can run `tnp relay`. Registered in directory with `operator: "community"`. Clients filter by preference.

**For onion routing (Phase 3):**
- Relays gain roles: Guard, Middle, Exit
- Each relay has X25519 keypair for circuit negotiation
- Client builds 3-hop circuit: Guard -> Middle -> Exit
- Each hop only knows previous + next node
- Relay peels one encryption layer and forwards

### 4. API Extensions (`apps/api/`)

**New models:**

**`ServiceNode`:**
- `domainId` — links to the Domain it serves
- `oxyUserId` — owner (must match domain owner)
- `publicKey` — Ed25519 public key for identity verification
- `connectedRelay` — which relay this node is currently connected to
- `status`: `"online" | "offline"`
- `lastSeen` — heartbeat timestamp

**`Relay`:**
- `endpoint` — WSS URL
- `publicKey` — X25519 public key
- `operator`: `"oxy" | "community"`
- `operatorUserId` — Oxy user who runs it
- `capacity` — `{ maxConnections, bandwidth }`
- `location` — optional geographic hint
- `status`: `"active" | "degraded" | "offline"`
- `lastSeen` — heartbeat timestamp

**Domain model extension** (existing `Domain.ts`):
- Add `serviceNodeId` — reference to ServiceNode
- Add `serviceNodePubKey` — cached public key for client verification

**New routes:**

| Route | Method | Auth | Purpose |
|-------|--------|------|---------|
| `POST /nodes/register` | POST | Required | Register service node for a domain |
| `GET /nodes/:domain` | GET | None | Get service node connection info |
| `POST /nodes/heartbeat` | POST | Required | Service node liveness ping |
| `GET /relays` | GET | None | List active relays (filterable) |
| `POST /relays/register` | POST | Required | Register a relay node |
| `POST /relays/heartbeat` | POST | Required | Relay liveness ping |
| `GET /circuits/directory` | GET | None | Relay directory for circuit building |

**DNS resolution change** (`/dns/resolve`):
Returns overlay routing info alongside DNS records when a service node is online:
```json
{
  "records": [{ "type": "A", "value": "..." }],
  "overlay": {
    "serviceNodePubKey": "...",
    "relay": "wss://relay1.tnp.network",
    "available": true
  }
}
```

### 5. Web Dashboard (`apps/web/`)

**New pages:**

- **Service Node Management** (`pages/ServiceNode.tsx`): Status, domain binding, local target config, public key, connection logs
- **Relay Dashboard** (`pages/Relay.tsx`): For community operators. Stats, registration, health.
- **Network Status** (`pages/Network.tsx`): Public page. Active relays/nodes, geographic distribution, network health.

**Updated pages:**
- **Install** (`pages/Install.tsx`): Add `tnp serve` and `tnp relay` instructions, privacy level explanation
- **Dashboard** (`pages/Dashboard.tsx`): Add Service Nodes and Relay tabs

## Privacy Model

| Level | Hops | Who sees what | Use case |
|-------|------|---------------|----------|
| **Access** (default) | 1 | Relay sees client IP + domain, not content | Basic overlay access |
| **Private** | 3 | Guard: client IP only. Exit: domain only. Middle: neither. | Full anonymity |

**Encryption stack:**

| Layer | Protocol | Purpose |
|-------|----------|---------|
| Transport | WSS (TLS 1.3) | Protects WebSocket frames in transit |
| End-to-end | NaCl box (X25519 + XSalsa20-Poly1305) | Client <-> Service. Relays cannot read content |
| Per-hop (onion) | NaCl box per relay | Each relay peels one layer, knows only neighbors |

**Key management:**
- Service nodes: long-term Ed25519 identity keys (published in directory)
- Clients: ephemeral X25519 keys per circuit
- Relays: X25519 keys published in circuit directory
- All crypto via `tweetnacl` — pure JS, zero native dependencies

## Full VPN Mode (Phase 4)

For users who want ALL traffic routed through Oxy:
- Client configures system to route all DNS through TNP proxy
- SOCKS5 proxy handles all connections (TNP and regular internet)
- Non-TNP traffic exits through an Oxy exit relay
- Toggled via `tnp connect --full-tunnel` or web dashboard toggle

## Phasing

### Phase 1: MVP
- SOCKS5 proxy in client
- WebSocket tunnel manager
- E2E encryption (client to service node)
- `tnp serve` command (service node mode)
- ServiceNode model and registration routes
- Single Oxy-operated relay (`apps/relay/`)
- DNS proxy returns `127.0.0.1` for TNP domains
- Basic web UI for service node management

**Deliverable:** Self-hosted services accessible via TNP domains through encrypted WebSocket tunnels.

### Phase 2: Relay Network
- Multiple relay nodes with peering
- Community relay registration and directory
- Relay health monitoring and removal of stale relays
- Client relay selection (Oxy/community/any preference)
- Relay dashboard in web UI
- Network status page

**Deliverable:** Distributed relay infrastructure with community participation.

### Phase 3: Onion Routing
- Multi-hop circuit building (3 hops)
- Per-hop NaCl encryption layers
- Guard/Middle/Exit relay roles
- Guard node pinning
- Circuit rotation (new circuit every N minutes)
- "Private" privacy level in client

**Deliverable:** Full anonymity mode for users who want it.

### Phase 4: Full VPN
- All-traffic routing through overlay
- Exit relays for non-TNP traffic
- System-wide tunnel configuration
- `--full-tunnel` CLI flag
- Web dashboard toggle

**Deliverable:** Complete VPN functionality — users are fully "on the Oxy network."

## Critical Files to Modify/Create

### New files
- `packages/client/src/socks.ts` — SOCKS5 proxy
- `packages/client/src/tunnel.ts` — WebSocket tunnel manager
- `packages/client/src/crypto.ts` — NaCl crypto layer
- `packages/client/src/service-node.ts` — Service node logic
- `apps/relay/src/index.ts` — Relay server (Bun.serve)
- `apps/api/src/models/ServiceNode.ts` — ServiceNode model
- `apps/api/src/models/Relay.ts` — Relay model
- `apps/api/src/routes/nodes.ts` — Service node routes
- `apps/api/src/routes/relays.ts` — Relay routes
- `apps/web/src/pages/ServiceNode.tsx` — Service node management page
- `apps/web/src/pages/Relay.tsx` — Relay dashboard page
- `apps/web/src/pages/Network.tsx` — Network status page

### Existing files to modify
- `packages/client/src/proxy.ts` — Return `127.0.0.1` for TNP domains, integrate SOCKS5
- `packages/client/src/cli.ts` — Add `serve`, `relay`, `connect` commands
- `packages/client/src/config.ts` — Add overlay config fields
- `apps/api/src/models/Domain.ts` — Add `serviceNodeId`, `serviceNodePubKey`
- `apps/api/src/routes/dns.ts` — Return overlay info in resolve response
- `apps/api/src/index.ts` — Mount new route modules
- `apps/web/src/pages/Install.tsx` — Add service node/relay instructions
- `apps/web/src/pages/Dashboard.tsx` — Add service node/relay tabs

## Verification

### Phase 1 testing
1. Start API locally (`bun run dev:api`)
2. Start relay locally (`cd apps/relay && bun run dev`)
3. Register a domain via web UI
4. Run `tnp serve --domain example.ox --target localhost:8080` on a test server
5. On another machine, run `tnp install` then `curl --proxy socks5://127.0.0.1:1080 http://example.ox`
6. Verify: request reaches the test server via relay, response returns to client
7. Verify: traffic is encrypted (inspect WebSocket frames — should be NaCl ciphertext)
8. Verify: service node heartbeat appears in API (`GET /nodes/example.ox`)

### Integration tests
- Client SOCKS5 proxy handles concurrent connections
- Tunnel reconnects after relay restart
- Service node reconnects after network interruption
- DNS proxy correctly returns `127.0.0.1` for domains with active service nodes
- DNS proxy returns normal records for domains without service nodes
- Relay correctly multiplexes multiple circuits
