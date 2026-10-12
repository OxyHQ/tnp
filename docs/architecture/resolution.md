# Resolution

How a name becomes an answer. The naming layer decides what a name *means*;
this layer decides how a query gets answered on a device.

**Status: mostly implemented.** Wire encoding, response codes, EDNS(0),
truncation, configurable upstreams with an encrypted (DoH) default, caching,
pre-decode query validation, response rate limiting and native-TLD-only OS
routing are done (audit B3, B4 and S9 closed). DNSSEC validation and DoT are
not (S8).

---

## 1. Query pipeline

```
query
  ↓
[0] personal rules ── local approved-rules file only (naming.md §3);
  ↓                    absent on the public resolver
[1] classify  ──── offline, from the cached TLD policy table
  ↓                 (naming.md §1; never a network call)
  ├── public-dns ──→ [3] upstream ──→ [4] DNSSEC ─────────────────────────┐
  └── tnp-native ──→ [5] TNP lookup ──→ [6] verify signature ─────────────┤
                                                                          ↓
                                                              [7] cache + respond
```

**[0] Personal rules** (`packages/client/src/dns-rules.ts`, hooked at the top
of `handleQuery`). A block answers `NXDOMAIN` with no SOA, so nothing
downstream caches it, for native and public names alike — a blocked native
name never reaches the registry. An approved redirect answers its exact name
(30 s TTL): an address for the matching type and NODATA for every other type,
or a CNAME plus the target resolved through steps [1]–[7] without the rules.
A redirect is ignored for a name that classifies native. The rules come from
one file the resolver re-checks every two seconds and refuses if it is not
root-owned, private and exactly what `tnp rules` writes; the key that
decrypts the synced set is never in the resolver process.

Classification happens **first, offline, always**. A `public-dns` name never
touches TNP infrastructure, which is both the namespace guarantee
([`naming.md`](./naming.md) rule N1) and a privacy property: the TNP API does not
learn the user's public browsing.

The policy table is never empty. It starts from `BUILTIN_NATIVE_TLDS` in
`@tnp/namespace` (`.ox`) before any network call, adds the last good registry
list saved on disk, and then whatever the TLD sync approves. No API response —
empty, malformed, failed — can remove a built-in TLD. The table used to start
empty and be filled by a sync that startup did not wait for, so until the API
answered (or forever, if it never did) every `.ox` lookup was classified
public and forwarded upstream — to the ISP, in the clear, with the old
plaintext default.

---

## 2. Protocol support

The resolver must be a correct DNS implementation, not a partial one. Required:

| Area | Requirement |
|---|---|
| Transports | UDP and TCP on the listening side. DNS-over-HTTPS (default) or classic UDP/TCP upstream. DNS-over-TLS is not implemented. |
| Record types | A, AAAA, CNAME, MX, TXT, NS, SRV, CAA at minimum; unknown types passed through opaquely rather than dropped. |
| EDNS(0) | Advertise a buffer size and honour the client's, up to 1232 bytes over UDP. Client EDNS options are not forwarded upstream. |
| Truncation | Set TC and expect the client to retry over TCP when a response does not fit. |
| Input | Vet a packet from its raw bytes before decoding it: see §8. |
| CNAME | Follow chains with a hop limit; return the chain, not just the terminal record. |
| Response codes | NOERROR, NXDOMAIN, SERVFAIL and REFUSED must be distinguished and preserved end to end. |
| Sections | Preserve AUTHORITY and ADDITIONAL. An NXDOMAIN's SOA carries the negative TTL. |
| Compression | Emit and parse name-compression pointers. |

### Do not hand-roll the wire format

The current resolver hand-builds packets field by field and gets several of them
wrong: the response code is hardcoded to NOERROR so upstream NXDOMAIN is lost,
and TXT/MX/NS/SRV/CAA RDATA is written as a raw UTF-8 blob rather than in its
defined encoding (audit B3).

Use a maintained, standards-compliant DNS library, or build a protocol layer with
its own conformance test suite and fuzz targets. Partial hand-rolled encoders are
how resolvers end up with cache-poisoning bugs.

---

## 3. Upstream configuration

The user chooses (`upstreamDns`, comma-separated, tried in order). State:

- **Default: DNS-over-HTTPS, two operators, by IP literal** —
  `https://1.1.1.1/dns-query,https://8.8.8.8/dns-query` (`DEFAULT_UPSTREAM_DNS`
  in `config.ts`). Encrypted because the plaintext default it replaces
  (`1.1.1.1` over UDP) let anyone on the path read and forge every public
  name. IP literals so reaching the upstream needs no plaintext bootstrap
  lookup and sends no SNI naming it, and the resolver can never loop through
  itself. Quad9 is not a default: its DoH endpoint requires HTTP/2 and answers
  Bun's HTTP/1.1 `fetch` with 505.
- **Migration.** A saved config holding exactly `1.1.1.1` — the value earlier
  releases wrote into every config — is moved to the default with a warning.
  `1.1.1.1:53` is how a user keeps plaintext on purpose; any other value is
  honoured as written.
- A classic upstream is warned about at startup. `http://` URLs are refused.
- ✅ The choice is honoured (audit B4 closed).
- ✅ Failover in order. Per-upstream health tracking is not implemented.
- **What goes upstream** is rebuilt from the client's question: DO and CD
  cleared, no client EDNS options (Client Subnet, cookies, device IDs),
  buffer 1232, DoH queries padded to 128 bytes (RFC 8467). AD is cleared on
  relayed answers — we do not validate.
- **What is accepted back:** a fresh random transaction ID per attempt (never
  the client's), a connected UDP socket, and an answer whose ID and question
  match. Anything else is ignored until the attempt times out, so an off-path
  spoofer has to guess ID and source port instead of merely answering first.
  DoH bodies are size-capped while streaming.

## 4. DNSSEC

For `public-dns` names, when enabled: validate the chain to the root trust anchor
and return SERVFAIL on validation failure. Never downgrade to an unvalidated
answer because validation failed — that converts a detected attack into a
successful one.

For `tnp-native` names, DNSSEC does not apply. Authenticity comes from the signed
record sets in [`naming.md`](./naming.md) §5.

## 5. Caching

Implemented in `packages/client/src/dns/cache.ts`.

| Rule | Why | State |
|---|---|---|
| Honour the record's own TTL | The cache used to override every TTL with a fixed 300 s, so a 60 s record was served for 300 s and a 24 h record was re-fetched every 5 minutes (audit S9). | ✅ |
| Expire a record set with its **shortest** member | Keeping the set past its earliest expiry serves a stale member of it. | ✅ |
| Decrement the served TTL by the time held | Serving the original TTL is what lets a record outlive it — each downstream cache re-arms the full lifetime on every hop. | ✅ |
| Cache negatives (RFC 2308), bounded by the SOA minimum | Otherwise every lookup of a nonexistent name is a fresh round trip. | ✅ |
| Keep NODATA distinct from NXDOMAIN | "Exists, no AAAA" read as "does not exist" makes a dual-stack client give up on an IPv4-only name. | ✅ |
| Bound the cache and evict | An unbounded `Map` is a memory-exhaustion path for anyone who can send queries (audit S6). Expired entries are evicted before live ones. | ✅ |
| Clamp TTLs to a sane floor and ceiling | Defends against both pinning and thrashing. Positive: 1 s–24 h. Negative: 1 s–1 h. | ✅ |
| Never serve a stale entry as fresh | Serve-stale, if ever added, is opt-in and marked. | ✅ |

Upstream (public-DNS) responses are **not** cached yet — only TNP-native
answers are. That is a performance gap, not a correctness one.

## 6. Failure behaviour

Fail **loudly and correctly**, never silently and emptily.

| Situation | Correct response |
|---|---|
| Upstream unreachable | SERVFAIL ✅ |
| Upstream returns NXDOMAIN | NXDOMAIN, with the SOA preserved ✅ |
| TNP registry unreachable, erroring or slow, `tnp-native` name | SERVFAIL — never forwarded upstream ✅ |
| Resolver saturated (`maxInflight`) | SERVFAIL, immediately ✅ |
| TNP-native name not registered | NXDOMAIN ✅ |
| TNP-native name exists, no records of the type | NOERROR, empty (NODATA) ✅ |
| Signature verification fails | SERVFAIL. Never fall back to the unverified answer. (Signing not implemented.) |
| Malformed query | FORMERR ✅ |
| A response (QR=1) sent to the resolver | No reply ✅ |
| Opcode other than QUERY | NOTIMP ✅ |

An empty NOERROR means "this name exists and has no records of this type". Using
it as a generic error, as the current resolver does, makes every failure look
like a successful negative answer.

## 7. Leak prevention

- **The OS sends TNP only the native TLDs.** `tnp install` and `tnp connect`
  add a routing object scoped to `.ox` and never touch the user's own DNS
  settings; teardown removes exactly what was added (`dns-routing.ts`). See
  §10.
- **A native name is never sent to the public upstream**, under any failure
  (§1, §6). Tested on the wire in `proxy.wire.test.ts`.
- **The resolver does not log queried names**, and neither does the SOCKS
  proxy. A resolver log is a browsing history.
- **The SOCKS proxy only accepts TNP-native names.** Anything else — public
  names, IP literals — is refused locally with "not allowed by ruleset", and
  the API is never asked about it. It used to look up every destination with
  `GET /nodes/<host>`, reporting the user's browsing to the registry.
- When proxy or tunnel mode is active, name resolution for tunnelled destinations
  happens **remotely**, at the far end of the tunnel — not on the device.
- Full tunnel mode captures port 53 and DNS-over-TLS/HTTPS to well-known
  resolvers, so an application with a hardcoded resolver cannot bypass the
  tunnel.
- IPv6 resolution follows the same policy as IPv4. A resolver that handles A and
  forgets AAAA is a leak.
- The resolver binds to loopback by default and refuses queries from off-host
  unless explicitly configured otherwise.

## 8. Public resolver (`apps/dns-server`)

TNP also runs a public resolver so a device that cannot install the client can
still resolve TNP names by pointing at it. It shares the resolution engine with
the client — but today it does so by importing across a workspace boundary via a
relative path, with an incomplete config object that does not typecheck (audit
B1). Phase 2 extracts a real `@tnp/resolver` package that both consume.

Anyone using the public resolver is trusting Oxy with their query stream. That
trade-off must be stated wherever the resolver's address is published. A device
that points at it directly also sends every lookup to it in **plaintext** over
UDP/TCP port 53, so the local network and ISP can read and forge all of them;
the public resolver is a convenience for devices that cannot run the client,
not a privacy tool.

It answers anyone, so it is hardened as an open service (`dns/guard.ts`,
`dns/rate-limit.ts`):

- **Pre-decode validation.** A packet is accepted only if its raw header and
  question say it is one plain query: QR=0, opcode QUERY, exactly one
  question, no answer or authority records, at most one OPT additional, no
  compression pointer in the question, nothing trailing, at most 512 bytes
  over UDP unless EDNS advertises more (cap 1232). This runs before
  `dns-packet` sees it; a 64 KB packet of chained pointers used to cost
  ~200 ms to decode.
- **Amplification bounds.** UDP responses are capped at 1232 bytes whatever
  the client advertises; DO is never forwarded, so DNSSEC records do not
  inflate answers. Per-source token buckets (IPv4 address or IPv6 /64, a
  bounded table) drop excess queries, answering every second dropped query
  with a TC reply no larger than the query (RRL "slip").
- **Resource bounds.** TCP: capped concurrent connections, a 30 s absolute
  deadline per connection (the idle timer alone is re-armed by every byte),
  a 4 KB input buffer, one query at a time. A global cap on queries in
  flight answers SERVFAIL beyond it instead of opening another upstream
  socket.

## 9. Registry answers (`/dns/resolve`)

**Status: implemented** in `apps/api/src/registry/resolve.ts` (issue #62, A6).
Every resolver asks the registry the same question — name and query type —
and the answer is a pure function of what the registry holds, a clock and two
settings. `loadNameFacts` reads the facts; `decideResolution` applies the rules
below and is unit-tested one rule at a time, with real-PostgreSQL tests for the
loader (`apps/api/test-db/resolve.test.ts`).

The response is `DnsResolveResponse` in `@tnp/shared-types`. It only grows:
`rcode` is an addition, and a resolver that predates it reads empty `answers`
as it always did.

| Name | Answer | `rcode` |
|---|---|---|
| Single label, reserved TLD (even with a stale active row), or a TLD TNP does not operate | nothing | `NXDOMAIN` |
| Native TLD, second-level name **not registered** | parking A record for `A`/`ANY` when `TNP_PARKING_IP` is set, nothing for other types | `NOERROR` (parking synthesizes the name) or `NXDOMAIN` when parking is unset |
| Registered, records of the queried type at the label | those records | `NOERROR` |
| Registered, no records of that type but a **CNAME** at the label | the CNAME, for every type — never parking | `NOERROR` |
| Registered, records of other types at the label, or an online service node | nothing (NODATA) | `NOERROR` |
| Registered, **nothing at all** at the label and no online node | parking A record for `A`/`ANY` when parking is set; otherwise nothing | `NOERROR` for the registered name itself or an empty non-terminal, `NXDOMAIN` for any other label |

A service node counts only when its `status` is `online` **and** its last
heartbeat is at most 90 seconds old. Clients heartbeat every 30 seconds and
nothing ever writes `offline`, so the stored status alone would call a node that
died a month ago online. The `overlay` block is attached only for such a node,
and `GET /nodes/:domain` reports the same effective status.

**Parking synthesis for unregistered native names is deliberate.** A browser
that looks up a free `.ox` name lands on the API's "available — register on TNP"
page instead of an error. It is an answer TNP makes up, for native names only,
and it is the reason an unregistered native name is `NOERROR` rather than
`NXDOMAIN` whenever `TNP_PARKING_IP` is set. It never applies to a public-DNS
name (naming.md rule N1): those are `NXDOMAIN` here and never reach the registry
from a conforming client at all.

**Expiry.** With `TNP_NATIVE_EXPIRY_ENFORCED=true`, a registered name whose
expiry state is `expired` (naming.md §4) is answered exactly like an unregistered
one — parking only, no records, no overlay — and the parking page says "expired,
held", never "available". Enforcement is off by default.

The parking page (`apps/api/src/index.ts`) uses the same facts and the same node
and expiry rules through `decideParkingPage`, so every name that resolves to the
parking address gets a page rather than a 404.

The resolver (`packages/client/src/proxy.ts`) honours `rcode`: `NOERROR`
with no answers is NODATA on the wire and in the cache (`DnsCache.setNoData`),
`NXDOMAIN` is NXDOMAIN, and only an API that omits `rcode` gets the old reading
of empty `answers` as NXDOMAIN. TXT values longer than 255 bytes are split into
character-strings of at most 255 bytes, as RFC 1035 requires.

## 10. OS routing: only native TLDs go to TNP

Implemented in `packages/client/src/dns-routing.ts`, used by `tnp install`
(owner `install`) and `tnp connect` (owner `connect`, with its own file, link
and NRPT comment so ending a session never removes the installed routing).
What it replaced captured all DNS: a global `DNS=127.0.0.1` drop-in and
`resolvectl dns <iface> 127.0.0.1` on Linux, 127.0.0.1 prepended to every
adapter on Windows, the TNP resolver plus 1.1.1.1 written over every adapter
by `tnp connect` on Windows, and a nameserver prepended to `/etc/resolv.conf`
as the Linux fallback. Uninstall ran `-ResetServerAddresses`, which threw away
a user's own static resolver and reverted them to the ISP's.

| Platform | Mechanism | Never touched |
|---|---|---|
| Linux, systemd ≥ 258 | DNS delegate `/etc/systemd/dns-delegate.d/tnp.dns-delegate`: `DNS=`, `Domains=~ox`, `DefaultRoute=no` | resolved's global section, every interface |
| Linux, older systemd-resolved | Dummy link `tnp0` with `192.0.2.53/32` (TEST-NET-1), default-route off, `~ox`, then the server — brought up and down by the service unit | as above |
| Linux, no systemd-resolved | Nothing. The user is told how to forward `.ox` in their own resolver. | `/etc/resolv.conf` |
| macOS | `/etc/resolver/ox`; a pre-existing foreign file is backed up and restored | everything else in `/etc/resolver` |
| Windows | NRPT rule `.ox` → resolver, comment `Managed by TNP` | adapter DNS servers |

**Why not resolved's global section.** resolved sends a query to the scopes
whose routing domain matches it best; a query that matches none goes to every
default-route link *and the global servers* (systemd-resolved.service(8)). A
global `DNS=127.0.0.1` with `Domains=~ox` therefore still receives every public
lookup. Only a delegate or a link can be scoped. On the link, default-route is
switched off and the routing domain set before the server is added, because a
link with servers and no route-only domain is implicitly a default route.
`~ox` is route-only, never a search domain, so `printer` never becomes
`printer.ox`. resolved creates a scope only for a link with a routable address
(`link_relevant()`), hence the TEST-NET-1 address. `dns-routing.test.ts`
encodes resolved's routing rule and checks the old and new configurations
against it.

**What is recorded.** Everything added is written to
`<dataDir>/dns-routing-{install,connect}.json`; teardown removes exactly that.
Repairs of what older releases did: the legacy drop-in and `/etc/resolver/com`
and `/etc/resolver/app` (only when they point at 127.0.0.1) are removed; on
Windows, when an install from before this version is detected (its scheduled
task exists and no state file does), adapters are snapshotted into the state
file and only the `127.0.0.1` entry it prepended is taken out — never
otherwise, because 127.0.0.1 on an adapter is also how dnscrypt-proxy and
Acrylic users point Windows at their own local resolver; a Linux interface still set to
127.0.0.1 by an old release is reported with the command to restore it, not
reverted silently, because its original servers were never recorded.

**Windows and ports.** NRPT carries no port, so `tnp install` runs the resolver
on 53. `tnp connect` on Windows with the default port 5354 leaves DNS unchanged
and says how to fix it; it no longer points Windows at the TNP public resolver,
which would carry every `.ox` lookup across the network in plaintext.

**Not verified on real systems by tests:** the generated configuration is
unit-tested; its effect on Windows, macOS and each systemd version is not.
