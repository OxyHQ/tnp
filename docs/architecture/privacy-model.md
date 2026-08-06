# Privacy model

**Status: honest statement of the current system plus the target.** Every claim
here is one that can be verified against the code today or is explicitly marked
as not yet true.

---

## 1. What TNP provides today

Single-hop encrypted transport to TNP service nodes, plus name resolution.

Concretely, right now:

- The relay cannot read tunnel payloads.
- The relay **can** see your IP, which service node you are talking to, when, and
  how much.
- The TNP API **can** transparently decrypt your traffic by substituting the
  service node's public key, because nothing signs it and the client verifies
  nothing (audit S3).
- Your public DNS queries currently go to a hardcoded third-party DoH endpoint
  regardless of your configured upstream (audit B4).
- Multi-hop routing does not exist. `--privacy private` currently changes nothing
  (audit B5).

**TNP does not provide anonymity today.** It provides confidentiality against the
relay and against a passive network observer, conditional on the API behaving.

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
| Resolver | Nothing | n/a | Nothing | Nothing — Oxy sees native lookups |
| Access | The destination | Content only | Nothing | Which domain you resolved |
| Proxy | The destination, for proxied apps | Content only | Nothing | As above |
| Private (Phase 6) | The destination | Client↔destination linkage | Nothing | Should be nothing — pending §7 of the threat model |
| Full tunnel (Phase 8+) | All destinations | Content only | Nothing | Directory usage |

The "hides from the destination: nothing" column is the one users most often get
wrong. TNP changes how your traffic arrives. It does not change what you say when
it gets there.
