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
  The one exception is opt-in: the public names your own personal DNS rules
  cover on a device (naming.md §3) — and, on Linux and macOS, names under them
  — go to the local TNP resolver, which forwards what it does not answer to
  its configured upstream (DNS-over-HTTPS by default). The TNP API never sees
  them.
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

The standard-tier VPN (WireGuard to a TNP-operated exit) is implemented but not
deployed; what it does and does not protect is §8.

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
| Exit | Aggregate counters, aggregate refusals by policy class | Destination lists, per-connection logs, payloads | As above. TNP's WireGuard exits, as implemented: no log rule, journal in memory only, conntrack and WireGuard peer state in kernel memory only ([`exit-nodes.md`](./exit-nodes.md) §9.3) |
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
| VPN devices | Per device: owner's Oxy user id, the name the owner gave it, its WireGuard public key, its tunnel address, creation time. No private key (generated on the device, refused if sent), no handshake or connection time, no endpoint IP, no traffic figures, no update time. A revoked device's address is kept for 24 h with only the time it was freed (`vpn_address_quarantine`, no account), so it is not reused while flows may still reference it. | Nothing to the public. `GET /exit/peers` gives TNP's own exits, behind a per-exit token, every public key and tunnel address — no user id, no name. |
| Personal DNS rules | Per Oxy user id, one end-to-end encrypted envelope: `ciphertext` (padded to a power-of-two bucket, so its length does not count the rules), the rules key `wrappedKey` under the user's passphrase, Argon2id `kdfParams` and `salt`, `nonce`, a `version` counter and `updatedAt`. Overwritten on each save; no history. No rule, no name, no count, no passphrase, no key. | Nothing. `GET /me/dns-rules` returns the caller's own envelope only, `Cache-Control: no-store`. |
| Service nodes | Owner's Oxy user id, node key, grant chain and current key-agreement certificate (public), current relay, time of the **last** heartbeat (overwritten, not a history) | Node key and `online: true/false`; the relay only while online. While online, `/dns/resolve` also publishes the chain, certificate and domain key. No timestamp. |
| Relays | Endpoint, key, registering account, capacity, location label, last heartbeat | Endpoint, key, `operator`, location label, status — for relays that heartbeated in the last 90 s. No account, no timestamp. |
| TLD proposals and votes | Proposer and each voter's local user id | Scores, and to the caller only whether they proposed or voted. |
| Rate-limit buckets | Client address (IPv6 as its /64) or Oxy user id, a token count, a time — in memory, size-capped, evicted, never written to disk or logs | Nothing |
| `/dns/resolve` cache | Public answers, in memory, 30 s at most | Nothing beyond the answer itself |
| Error logs (CloudWatch) | In production: error class, SQLSTATE, constraint, stack frames. No query parameters, no names, no user ids, no row values. | Nothing |

Compelled or compromised, the API can hand over the envelope above, and can
serve an old one, a malformed one or none; it cannot decrypt one, edit one
undetectably, move one to another account, or roll a device back to an older
version it already accepted (naming.md §3). What it learns from the row itself
is that the account uses personal rules, roughly how large the set is (to a
power of two) and when it was last saved. One caveat is outside the envelope:
the dashboard decrypts in the browser with code served from tnp.network, so an
operator who can change that code can capture a passphrase typed after the
change. The `tnp` client is a signed release and does not depend on the page,
and no rule — however authored — redirects a public name on a device without
that device's approval.

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
| VPN, standard tier (WireGuard to a TNP exit) | All destinations, contents and DNS — it sees an encrypted flow to the exit | n/a (no relay) | Your IP (they see the exit's) | **Nothing** — Oxy runs the exit: every destination, plus anything not end-to-end encrypted, tied to your account (§8) |
| Full tunnel, private tier (Phase 8+) | All destinations | Content only | Nothing | Directory usage |

The "hides from the destination: nothing" column is the one users most often get
wrong. TNP changes how your traffic arrives. It does not change what you say when
it gets there.

## 8. The standard-tier VPN (WireGuard), stated for users

Implemented, off until an exit is deployed ([`vpn.md`](./vpn.md) §10). This is
the statement the dashboard makes where a device is added, in every locale, and
the one any other surface must not go beyond.

**It protects**

- From the local network (public Wi-Fi, others on the same router) and the ISP:
  they see one encrypted WireGuard flow to a TNP exit — not destinations, not DNS
  lookups, not contents.
- The user's IP from the sites they visit, which see the exit's address.

**It does not protect**

- From TNP. Oxy operates the exit and can technically see every destination
  address and port, and the content of anything not encrypted by the site
  itself (HTTPS hides content, not which site). Oxy also runs the resolver the
  config names. Exits keep aggregates only (§4, exit-nodes.md §9.3) — a promise
  about operation, not a property the user can verify.
- Identity. It is not anonymity: one operator runs the exit and holds the
  account each device belongs to, and an observer of both the user's link and
  the exit can correlate them by timing.
- From what the user tells a site, or from their own device (§3).
- From the hosting provider (AWS), which can observe the exit's traffic.

**Whom it is for, and whom not.** It replaces a commercial VPN for someone who
wants their ISP and local network out of their browsing. Someone whose safety
depends on not being identified — an activist or journalist facing a government
— is told to use Tor Browser instead, until TNP's private tier exists and has
been measured (§2, §5).

**What TNP stores** per device: owner, name, public key, tunnel address,
creation time (§4 table). The private key is generated on the device and never
sent.
