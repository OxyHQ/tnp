# Privacy model

**Status: honest statement of the current system plus the target.** Every claim
here is one that can be verified against the code today or is explicitly marked
as not yet true.

---

## 1. What TNP provides today

Single-hop encrypted transport to TNP service nodes, plus name resolution.

Concretely, right now:

(The overlay below is the code since the Phase 3 transport cutover. It is not
deployed while the relay is parked, [`relays.md`](./relays.md) §8.)

- The relay cannot read tunnel payloads, the port you connect to, or why a
  connection failed: all of it travels inside the end-to-end session.
- The relay **can** see your IP, the name you are reaching (the routing name
  in every circuit), which service node serves it, when each connection opens
  and closes, and how much is sent each way.
- The TNP API **cannot** substitute the service node's key for a name your
  client has used before: the client pinned that name's domain key and refuses
  a different one unless the pinned key signed the change.
- The TNP API **can** substitute the key the **first** time your client
  reaches a name, because the first key seen is the one pinned (trust on first
  use). Nothing yet lets a client check a first-seen key independently.
- With `tnp install` or `tnp connect`, the operating system sends TNP only
  TNP-native names (`.ox`). Public names keep going to whatever resolver you
  already use; TNP does not see them and does not change how private they are.
- TNP-native names travel from the local resolver to the TNP API over HTTPS:
  your network sees a connection to the API, not the names. Oxy sees every
  native name you resolve, and your IP.
- When the TNP resolver forwards a public name (the public resolver, or an
  application pointed straight at the local one), it uses DNS-over-HTTPS by
  default — Cloudflare, then Google — so the network path does not see the
  name; the upstream operator does. A plaintext upstream is a stated, warned
  choice.
- Using TNP's **public resolver** directly sends every lookup to Oxy in
  plaintext DNS: your network and ISP can read and forge all of it.
- Neither the resolver nor the SOCKS proxy logs the names you look up, and
  the SOCKS proxy never asks the API about non-TNP destinations. The one
  exception is a security warning: when a name's key fails verification, the
  SOCKS proxy prints the refusal, with the name, to the local console.
- Multi-hop routing does not exist. `--privacy private` is rejected rather than
  silently downgraded to single-hop, which is what it used to do (audit B5).

**TNP does not provide anonymity today.** It provides confidentiality against the
relay and against a passive network observer — for names the client has
pinned, also against a misbehaving API; for a first contact, conditional on the
API behaving.

## 2. What TNP will provide (Phase 6+)

Multi-hop circuits where no single relay knows both the client and the
destination, with the directory signed and the service node's key chained to its
owner's identity.

That will be **resistance to single-point observation**. It will not be anonymity
against a global adversary, and the difference must stay visible in the product.

## 3. What TNP will never provide

- **Protection from a global passive adversary.** An observer who sees both ends
  of a circuit can correlate by timing and volume. Padding raises the cost; it
  does not remove the capability. Explicitly out of scope.
- **Protection from what you tell the destination.** Logging into an account over
  TNP identifies you to that service. No network layer fixes this.
- **Protection from your own device.** A compromised device, a hostile browser
  extension, or a WebRTC leak is outside the network layer's reach.
- **Protection from exit observation of unencrypted traffic.** An exit sees every
  destination and the content of anything not protected by application-layer
  encryption. This is inherent to being an exit.
- **Legal protection.** TNP does not make anything lawful that was not.

## 4. Metadata: what is retained, by whom

Target policy. Relays and exits must be able to prove they meet it.

| Party | May retain | Must not retain | Window |
|---|---|---|---|
| Relay | Aggregate counters: circuits, bytes, errors, uptime, version | Per-circuit records, client IPs, destinations, payloads | Aggregates only, no per-flow rows |
| Exit | Aggregate counters, aggregate refusals by policy class | Destination lists, per-connection logs, payloads | As above |
| API | Registry data, directory data, account data | Query logs tied to identity beyond operational need | Operational logs: 7 days, then deleted |
| Client | Local diagnostics the user can read and clear | Nothing transmitted without an explicit action | User-controlled |

**Never logged anywhere:** payload content, private keys, tokens, full browsing
history, per-user domain lists.

**IP addresses** are held only as long as a connection needs them, plus a short
bounded window for abuse handling, and are never joined to identity in analytics.

**Relays, as implemented** (`@tnp/relay-core`): aggregate counters only
(connections, circuits opened and rejected, frames and bytes forwarded,
drops, violations), no per-circuit log line, no name or address in any log.
A client address lives only in memory, in its per-IP rate-limit entry, which
is discarded once the address has no open connection and its buckets have
refilled (seconds to a minute).

### What the API stores and publishes today

Verified against `apps/api` (2026-10). Assume an operator can be compelled to
hand over everything in the "stores" column.

| | Stores | Publishes to anyone |
|---|---|---|
| Domains | Name, TLD, owner's Oxy user id, status, created/updated/expiry times, `unlisted` | Listed names only (`GET /domains`, search): name, TLD, status, expiry. No owner, no created/updated time, ordered by name rather than by registration. `unlisted` names are left out of both but still resolve and still answer a lookup by exact name. |
| DNS records | Every record and its created/updated time | The records, to anyone who resolves or looks up the name — that is what DNS is. |
| Domain keys | Each name's domain key (public) and its signed rotation history (at most 32 statements) | Both (`GET /domain-keys/:name`, and the resolve overlay). The registry never holds a domain, node or session secret. |
| Service nodes | Owner's Oxy user id, node key, grant chain and current key-agreement certificate (public), current relay, time of the **last** heartbeat (overwritten, not a history) | Node key and `online: true/false`; the relay only while online. While online, `/dns/resolve` also publishes the chain, certificate and domain key. No timestamp. |
| Relays | Endpoint, key, registering account, capacity, location label, last heartbeat | Endpoint, key, `operator`, location label, status — for relays that heartbeated in the last 90 s. No account, no timestamp. |
| TLD proposals and votes | Proposer and each voter's local user id | Scores, and to the caller only whether they proposed or voted. |
| Rate-limit buckets | Client address (IPv6 as its /64) or Oxy user id, a token count, a time — in memory, size-capped, evicted, never written to disk or logs | Nothing |
| `/dns/resolve` cache | Public answers, in memory, 30 s at most | Nothing beyond the answer itself |
| Error logs (CloudWatch) | In production: error class, SQLSTATE, constraint, stack frames. No query parameters, no names, no user ids, no row values. | Nothing |

Not addressed here: Cloudflare, and the load balancer if access logging is
on, keep their own request logs (with client addresses and URLs, which for
`/dns/resolve` include the name queried) under the infrastructure's
retention, outside this repository.

## 5. Correlation resistance — what actually helps

| Technique | Effect | Cost | Status |
|---|---|---|---|
| Multi-hop | No single relay sees both ends | Latency | Phase 6 |
| Guards | Bounds long-run exposure to a hostile entry | Path diversity reduced | Phase 6 |
| Circuit rotation | Bounds how much one circuit reveals | Rebuild cost | Phase 6 |
| Stream isolation | Different destinations on different circuits | More circuits | Phase 6 |
| Padding | Raises the cost of volume analysis | Bandwidth | Phase 6, opt-in |
| Batching | Raises the cost of timing analysis | Latency | Under evaluation |
| Operator diversity | Reduces the chance one operator owns a whole path | Directory complexity | Phase 5 |

Their effectiveness must be **measured** on the real network before being
claimed. A technique being implemented is not evidence that it works.

## 6. Wording rules

Binding on README, dashboard, CLI output, app store listings and any public
communication.

**Forbidden:** "anonymous", "untraceable", "absolute privacy", "guaranteed
privacy", "military-grade encryption", "we cannot see your traffic" (while the
API can substitute keys), "Tor-like anonymity".

**Required:** name the observer and what they observe. "The relay sees your IP
and which service you reach, but not what you send" is a true, useful sentence.
"Private" without a definition is not.

The mode is called **private mode**, not anonymous mode, and the UI must state
what it does and does not do at the point of selection.

## 7. Per-mode summary for users

| Mode | Hides from your ISP | Hides from the relay | Hides from the destination | Hides from Oxy |
|---|---|---|---|---|
| Resolver | Native names (sent to the API over HTTPS). Public names: unchanged — as private as your own resolver | n/a | Nothing | Nothing — Oxy sees native lookups |
| Public resolver (no client) | Nothing — plaintext DNS | n/a | Nothing | Nothing — Oxy sees every lookup |
| Access | The destination | Content only | Nothing | Which domain you resolved |
| Proxy | The destination, for proxied apps | Content only | Nothing | As above |
| Private (Phase 6) | The destination | Client↔destination linkage | Nothing | Should be nothing — pending §7 of the threat model |
| Full tunnel (Phase 8+) | All destinations | Content only | Nothing | Directory usage |

The "hides from the destination: nothing" column is the one users most often get
wrong. TNP changes how your traffic arrives. It does not change what you say when
it gets there.
