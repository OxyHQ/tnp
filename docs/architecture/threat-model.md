# Threat model

**Status: initial. This is version 1 and is deliberately incomplete** — §7 lists
what is still open. It is enough to reason about the current system and to gate
claims; it is not enough to support an anonymity claim.

Scope: issue #13.

---

## 1. Assets

| Asset | Why it matters | Where it lives |
|---|---|---|
| Oxy identity credentials | Compromise means every domain and device | Oxy; device keystore |
| Device identity keys | Impersonate a device | Platform keystore |
| Node keys | Impersonate a service node or relay | Node secure storage |
| Domain signing keys | Forge records, redirect a name | Owner custody |
| Session keys | Decrypt one circuit | Memory only |
| The namespace registry | Ownership of every TNP name | API database |
| The relay/exit directory | Deciding who carries traffic | API, signed |
| User traffic content | The user's data | In transit |
| User traffic metadata | Who talks to whom, when, how much | Observable at every hop |
| Personal DNS rules and their rules key | Reveal which names a user blocks or redirects; re-point names on their devices | Ciphertext on the API; key wrapped by the user's passphrase; decrypted only on the user's devices ([naming.md §3](./naming.md#3-overrides--the-only-way-a-public-name-changes-meaning)) |
| Update signing keys | Ship code to every device | Target: offline custody. Today: a GitHub Actions secret ([security.md §7](./security.md#7-update-security)) |

## 2. Trust matrix — what each party can observe

Per mode. "Content" means the payload; "destination" means the name or address.

### Resolver mode

| Party | Sees |
|---|---|
| TNP API | Every **TNP-native** name the user resolves, and their IP. |
| The user's own resolver | Every **public** name, exactly as without TNP: the OS routes only native TLDs to TNP (resolution.md §10). |
| Configured public upstream (DoH by default) | Public names the TNP resolver itself forwards — the public resolver's users, or apps pointed straight at the local resolver — and the forwarding resolver's IP. |
| Local network observer | That DNS is happening; a TLS connection to the API for native names. Public names only as visible as the user's own resolver makes them. |

The client no longer asks the TNP API about names under non-native TLDs
(audit S4/N4), no longer forwards native names upstream when the registry is
unreachable, and its default upstream is encrypted (audit B4). A user of the
**public resolver** without the client sends all lookups to Oxy in plaintext:
for them the local observer sees, and can forge, every name.

### Access / proxy mode (single hop, today)

| Party | Sees |
|---|---|
| Service relay | Client IP, the destination name (the circuit's routing prefix), service node identity, circuit open/close times, timing, byte volumes. **Not** content, the target port, or why a stream failed. |
| TNP API | Which domain was resolved and which relay was handed out. |
| Service node | Client's circuit, content, and the client's request contents. Not the client's IP (the relay is between them). |
| Local observer | A TLS connection to a relay. Not the destination. |
| **TNP API (as an attacker)**, name the client has used before | It cannot substitute the service node's key: the client pinned the name's domain key and refuses a different one unless the pinned key signed a rotation (security.md §1). It can deny service, see which names are resolved, and steer relays (relays.md §2). |
| **TNP API (as an attacker)**, first contact with a name | **Everything for that name** — the client pins whatever domain key it is shown first (trust on first use), so a substituted key at first contact goes unnoticed until the genuine key is seen. |

This is the state of the code since the Phase 3 transport cutover (audit S3
closed for pinned names); it is not deployed while the relay is parked. Until a
key-transparency log exists, "end-to-end encrypted" is honest only with the
first-contact caveat attached.

### Private mode (Phase 6, not implemented)

| Party | Sees |
|---|---|
| Guard | Client IP; that the client uses TNP. Not the destination. |
| Middle | Previous and next hop only. Neither client nor destination. |
| Exit / service relay | Destination; not the client IP. |
| Anyone watching both ends | Can correlate by timing and volume. See [`privacy-model.md`](./privacy-model.md). |

### VPN, standard tier (WireGuard to a TNP exit; implemented, not deployed)

| Party | Sees |
|---|---|
| Local network observer, ISP | One WireGuard flow (UDP) to the exit's address, its timing and volume. Not destinations, DNS or contents. |
| TNP exit (operated by Oxy) | The device's IP (WireGuard endpoint) and tunnel address, every destination address and port, the content of anything not end-to-end encrypted, timing and volume. Kept in kernel memory only; no log ([exit-nodes.md §9.3](./exit-nodes.md)). |
| TNP API | Which account owns which public key and tunnel address. No connection data. Together with the exit, Oxy can tie traffic to an account. |
| TNP public resolver | Every name the device looks up, from the exit's address (not the device's). |
| Hosting provider (AWS) | What any network operator of the exit sees: the device's IP on one side, destinations on the other. |
| Destination | The exit's address. Whatever the user tells it. |

The exit operator seeing destinations is inherent (exit-nodes.md §1). This tier
is confidentiality from the local network and ISP, not anonymity.

### Full tunnel mode (Phase 8+, not implemented)

| Party | Sees |
|---|---|
| Exit operator | Every destination address and port, and the content of anything not protected by application-layer encryption. |
| Guard | Client IP and total volume. |
| ISP | A single encrypted flow to the guard. |

Exit operators seeing destinations is inherent, not a defect. It must be stated
in the exit picker and in the operator consent flow.

## 3. Adversaries and current status

| # | Adversary | Can do | Defence | Status |
|---|---|---|---|---|
| 1 | Malicious client | Flood a relay, exhaust memory, abuse an exit | Authenticated circuits, quotas, frame limits, exit policy | **Partial** — relay frame, circuit, connection, rate and buffer limits (relays.md §3); clients are unauthenticated by design; no exits exist |
| 2 | Malicious service node | Serve hostile content under its own domain | Out of scope — it owns the name. Users trust names, not TNP. | By design |
| 3 | Malicious relay | Drop, delay, reorder, count, correlate; hijack a domain; inject into another client's circuit | Authenticated registration, per-connection circuit scoping, E2E crypto, multi-hop | **Partial** — circuit scoping and service-node authentication (S1, S2 closed in code); replay, reorder, reflection, tampering, truncation and impersonation are detected end to end (transport.md §11). It can still drop, delay, count and correlate; it is not authenticated to clients; no multi-hop |
| 4 | Malicious exit | Read and modify unencrypted traffic; log destinations | Published policy, TLS end to end, reputation, user selection | **By design for the WireGuard tier:** the exit is Oxy's, it can do all of this, and users are told so (privacy-model.md §8). Defences there are operational (no log rule, in-memory journal) and TLS end to end. Community overlay exits: not implemented |
| 5 | Compromised directory | Steer every client onto attacker relays | Signed directory, pinned key, diversity constraints, stale-rejection | **None today** — directory is unsigned |
| 6 | Compromised API | Substitute keys → transparent MITM; rewrite records | Owner-held domain keys pinned by clients (security.md §1); signed record sets (naming.md §5); key transparency | **Partial** — key substitution refused for names a client has pinned; first contact still trusts the API; DNS records are not signed (S8) |
| 7 | Compromised Oxy account | Take over the user's domains and devices | Oxy 2FA; device revocation; per-domain key custody | Partial. The account cannot replace a name's domain key while registered (rotation must be signed by the key). Releasing and re-registering the name forces a rotation from the released key, or a 30-day hold after which the new key is published as a `keyReset`; pinned clients refuse it ([security.md](./security.md) §1). The account can still deny service (release the name, stop nodes). |
| 8 | Stolen node key | Impersonate a node until noticed | Rotation, revocation, short-lived grants | **Partial** — X25519 certificates last ≤ 7 days, node grants 30 days; retiring a node requires rotating the domain key; no per-key revocation |
| 9 | Timing correlation | Deanonymize by matching flows at both ends | Padding, batching — **partial mitigation only** | Not implemented |
| 10 | Global passive adversary | Observe everything; correlate at will | **Out of scope. TNP does not defend against this and must never claim to.** | Explicitly out of scope |
| 11 | Sybil | Flood the directory with attacker relays to own whole paths | Operator diversity, registration cost, path constraints | Not implemented |
| 12 | Replay | Re-inject recorded frames | Counter inside the AEAD envelope | **Implemented in the Phase 3 transport** — `REPLAY_DETECTED`, tested against a hostile relay (S5) |
| 13 | Downgrade | Force a weaker version or capability set | Transcript signature; security capabilities non-negotiable downward | **Partial** — the session has no negotiable suite and binds version, role and name in its prologue; there is no capability negotiation to downgrade, and the connection handshake that would carry one is not implemented |
| 14 | Key substitution | Swap a key mid-flight | Grant chains; no unchained key is usable | **Implemented** for pinned names — the handshake accepts only a key verified against the pinned domain key; first contact trusts the registry (S3) |
| 15 | DNS poisoning / impersonation | Answer with attacker records | DNSSEC for public; signed record sets for native | Partial — DoH upstream by default; classic answers must match a random ID, the question and the connected source. No DNSSEC validation (S8), no signed native records |
| 16 | Malformed input | Crash or corrupt a parser | Bounds, fuzzing, structured errors | Partial — the resolver vets raw DNS packets before decoding; v1 frames have exact length checks and a 65 535-byte payload cap, every overlay codec is exact-length, and malformed input costs a circuit or a connection, never the process (tested); no fuzzing |
| 17 | Memory exhaustion | Unbounded frames, queues, caches | Hard limits everywhere | Partial — resolver cache, rate-limit table, TCP buffers and in-flight work are bounded; relay frames, tables and buffers are bounded and end-to-end windows bound each circuit (relays.md §3) |
| 18 | Connection exhaustion | Open connections until the relay dies | Per-IP and per-identity limits | Partial — resolver caps TCP connections with an absolute deadline; the relay caps connections per IP and overall and rate-limits new ones per IP; no per-identity limits (clients have none), and behind a load balancer per-IP limits need `RELAY_TRUST_FORWARDED_FOR` |
| 19 | Exit abuse | Use TNP to attack third parties; expose the operator legally | Port policy, rate limits, private-range blocking, abuse handling | **Partial** (WireGuard exits) — every exit-nodes.md §3 range and the VPC refused per packet, TCP 25 and SMB refused, per-peer DNS limit, accounts capped at 10 devices; no general per-peer rate limit; abuse answerable from aggregates only |
| 20 | Update compromise | Ship malicious code to every device | Signed artefacts, channel separation, downgrade protection | **Partial** — releases are Ed25519-signed; `tnp update` verifies and refuses downgrades; installers verify (the shell installer checks the signature only where OpenSSL 3 exists; the PowerShell installer always does); the key is an online CI secret; no channels or signed metadata ([security.md §7](./security.md#7-update-security)) |
| 21 | Local privilege attack | Unprivileged local process reconfigures the daemon | Authenticated owner-only IPC; `0600` config | Partial |
| 22 | DNS leak | Names resolved outside the tunnel | Remote resolution, port-53 capture, encrypted-DNS capture | Partial — native names are never forwarded upstream and the OS routes only native TLDs to TNP. WireGuard tier: the config sets the resolver and routes everything through the tunnel; whether the OS honours it is the WireGuard client's job (vpn.md §10.5), not yet measured. TUN capture not implemented |
| 23 | IPv6 leak | v6 escapes a v4-only tunnel | Full dual-stack capture or explicit v6 block | **Implemented** for the WireGuard tier — every config captures `::/0`; the exit refuses forwarded IPv6 with an ICMP error. Not yet measured on devices |
| 24 | WebRTC leak | Browser reveals the local IP | Documented; browser-side guidance; cannot be fixed by the tunnel alone | Documented only |
| 25 | Accidental logging | Domains, IPs, tokens in logs | Redaction at generation; explicit logging policy | Partial — the resolver and SOCKS proxy do not log queried names |
| 26 | Reflection / amplification | Spoof a victim's address at the public resolver | Per-source response rate limiting with slip, 1232-byte UDP cap, DO never forwarded, QR=1 never answered | Implemented in the resolver; not yet load-tested. Residual: sources on `TNP_DNS_RATE_LIMIT_EXEMPT` (TNP's own exit addresses) have no per-source limit, so a flood spoofing one of them is bounded only by the resolver's overall capacity (the in-flight cap covers uncached names only) — and lands on a TNP host, not a third party |
| 27 | Browsing disclosure to the registry | Learn public browsing from client lookups | Classify locally; never query the API for a non-native name (DNS and SOCKS) | Implemented |
| 28 | Compelled or compromised API vs. personal DNS rules | Read a user's block/redirect lists; push a rule that re-points a public name; serve an older rule set | End-to-end encryption under a passphrase-wrapped key the API never holds; user id and version authenticated; device refuses lower versions and same-version forks; redirects need per-device approval pinned to the target; the public resolver never applies personal rules | Implemented. Residual: the API sees that an account has rules, their size bucket and save times; it can withhold or delete them (blocks stop applying only after `tnp rules forget`); the web dashboard's code is served by the operator, so a hostile deploy could capture a passphrase typed afterwards — the signed CLI is not exposed to this, and a captured passphrase still cannot redirect a public name on a device without local approval |
| 29 | Stolen exit token, or a compromised exit host | Token: list every device's public key and tunnel address. Host: observe and alter all of its peers' traffic; accept peers the registry never listed | Per-exit bearer token (at least 256 bits) compared in constant time, revocable alone (`TNP_EXIT_TOKENS`) — a revoked token makes the exit drop every peer at once; the listing carries no account or name; agent unprivileged (`CAP_NET_ADMIN` only); private key only in kernel memory, read from SSM at boot; no inbound port but UDP 51820; the agent cannot reach the metadata service (`IPAddressDeny`); IMDSv2 enforced by the bootstrap | Implemented. Residual: whoever holds the host holds everything the exit operator sees (row 4); a hostile web deploy could change the page that generates private keys — the signed CLI (`tnp vpn add`) is not exposed to this |

## 4. Trust boundaries

```
device ─┬─ unprivileged UI ──┐
        │                    ├── authenticated local IPC ── privileged daemon ──┐
        └─ applications ─────┘                                                  │
                                                                                │
                                   ┌────────────────────────────────────────────┘
                                   ▼
                      TLS ── guard relay ── TLS ── middle ── TLS ── exit / service relay
                                   │                                      │
                                   │                                      ▼
                                   │                              service node / internet
                                   ▼
                          directory + registry API  (signed data, untrusted transport)
```

Each `──` is a boundary that must authenticate both ends and carry authenticated
data. The API boundary is data-signed rather than transport-trusted, precisely so
that a compromised API cannot rewrite what the client acts on.

## 5. Minimum trusted computing base, per mode

| Mode | Must be trusted |
|---|---|
| Resolver | The device; the TNP registry (for native names); the chosen upstream (for public names) |
| Access | Above, plus the service node's key chain — rooted at the domain key the client pinned, so the registry is trusted for the first contact with each name only |
| Proxy | Above, plus the local daemon |
| Service | The device; Oxy for ownership; the relay for availability only |
| Relay | The device; the directory |
| Private | The device; the directory; **not** any individual relay |
| Exit | Above, plus the exit for anything not end-to-end encrypted |
| Full tunnel | Above, plus the OS routing and DNS configuration |

The point of private mode is that no *single* relay needs to be trusted. It does
not remove the directory from the trusted set — which is why the directory must
be signed and diverse.

## 6. Wording rules

Derived from issue #13, and binding on every surface — README, dashboard, CLI,
app store listings, marketing.

**Never say:** "anonymous", "untraceable", "absolute privacy", "military-grade",
"guaranteed", or "we cannot see your traffic" while the API can substitute keys.

**Say instead:** exactly which party can observe exactly what, and which
adversaries are out of scope.

Multiple encrypted hops do not make a system anonymous. Anonymity requires a
complete protocol design, metadata analysis, resistance testing and external
review. TNP has none of those yet.

## 7. Open questions — must be closed before private mode ships

1. **Anonymous client authentication.** A client must not have to identify itself
   to a guard in private mode, but relays need abuse control. Blinded tokens?
   Proof of work? Unresolved.
2. **Directory distribution.** How a client gets a trustworthy directory without
   the API being a single point of compromise, and how the signing key is
   rotated.
3. **Sybil economics.** What a relay registration must cost, and how operator
   diversity is measured without collecting operator identity.
4. **Padding budget.** How much cover traffic buys how much correlation
   resistance, at what bandwidth cost, measured rather than assumed.
5. **Exit abuse handling.** The concrete process — who receives complaints, what
   an operator can and cannot see while responding, retention.
6. **Mobile background limits.** What each platform actually guarantees when the
   app is suspended, measured on real devices.
7. **Metadata retention.** Exact fields, exact retention windows, exact deletion
   mechanism, for relays and for the API.
