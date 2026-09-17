# Resolution

How a name becomes an answer. The naming layer decides what a name *means*;
this layer decides how a query gets answered on a device.

**Status: mostly implemented.** Wire encoding, response codes, EDNS(0),
truncation, configurable upstreams and caching are done (audit B3, B4 and S9
closed). DNSSEC and DoT are not (S8).

---

## 1. Query pipeline

```
query
  ↓
[1] classify  ──── offline, from the cached TLD policy table
  ↓                 (naming.md §1; never a network call)
  ├── public-dns ──→ [2] override check ──→ [3] upstream ──→ [4] DNSSEC ──┐
  │                        (per-name, local)                              │
  └── tnp-native ──→ [5] TNP lookup ──→ [6] verify signature ─────────────┤
                                                                          ↓
                                                              [7] cache + respond
```

Classification happens **first, offline, always**. A `public-dns` name never
touches TNP infrastructure, which is both the namespace guarantee
([`naming.md`](./naming.md) rule N1) and a privacy property: the TNP API does not
learn the user's public browsing.

---

## 2. Protocol support

The resolver must be a correct DNS implementation, not a partial one. Required:

| Area | Requirement |
|---|---|
| Transports | UDP and TCP on the listening side. DNS-over-TLS and DNS-over-HTTPS as upstream options, plus classic UDP/TCP. |
| Record types | A, AAAA, CNAME, MX, TXT, NS, SRV, CAA at minimum; unknown types passed through opaquely rather than dropped. |
| EDNS(0) | Advertise a buffer size, honour the client's, preserve upstream EDNS options. |
| Truncation | Set TC and expect the client to retry over TCP when a response does not fit. |
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

The user chooses. Requirements:

- Configurable upstream list with a selectable transport (classic, DoT, DoH).
- The choice is honoured. Today `TnpConfig.upstreamDns` is settable, is shown in
  the settings UI, and is never read — all public queries go to a hardcoded
  Google DoH endpoint (audit B4). That must be fixed before any privacy claim is
  made about resolution.
- Failover across upstreams with per-upstream health tracking.
- A default that is stated in the documentation, not discovered by packet capture.

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
| Bound the cache and evict | An unbounded `Map` is a memory-exhaustion path for anyone who can send queries (audit S6). Expired entries are evicted before live ones. | ✅ |
| Clamp TTLs to a sane floor and ceiling | Defends against both pinning and thrashing. Positive: 1 s–24 h. Negative: 1 s–1 h. | ✅ |
| Never serve a stale entry as fresh | Serve-stale, if ever added, is opt-in and marked. | ✅ |

Upstream (public-DNS) responses are **not** cached yet — only TNP-native
answers are. That is a performance gap, not a correctness one.

## 6. Failure behaviour

Fail **loudly and correctly**, never silently and emptily.

| Situation | Correct response |
|---|---|
| Upstream unreachable | SERVFAIL |
| Upstream returns NXDOMAIN | NXDOMAIN, with the SOA preserved |
| TNP registry unreachable, `tnp-native` name | SERVFAIL |
| TNP-native name not registered | NXDOMAIN |
| Signature verification fails | SERVFAIL. Never fall back to the unverified answer. |
| Malformed query | FORMERR |

An empty NOERROR means "this name exists and has no records of this type". Using
it as a generic error, as the current resolver does, makes every failure look
like a successful negative answer.

## 7. Leak prevention

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
trade-off must be stated wherever the resolver's address is published.

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

Known gap: the client resolver (`packages/client/src/proxy.ts`) does not yet read
`rcode`, so it still turns NODATA into NXDOMAIN on the wire. Fixing that belongs
with the resolver extraction (audit A9), which also has to give the cache a
distinct NODATA entry.
