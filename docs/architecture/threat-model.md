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
| Update signing keys | Ship code to every device | Offline custody |

## 2. Trust matrix — what each party can observe

Per mode. "Content" means the payload; "destination" means the name or address.

### Resolver mode

| Party | Sees |
|---|---|
| TNP API | Every **TNP-native** name the user resolves, and their IP. |
| Configured public upstream | Every **public** name the user resolves, and their IP. |
| Local network observer | That DNS is happening; the names, if classic DNS is used upstream. |

Today's client sends public queries to a hardcoded Google DoH endpoint regardless
of configuration (audit B4), and asks the TNP API about names under non-native
TLDs (audit S4/N4). Both leak more than this table says. Phase 2 fixes both.

### Access / proxy mode (single hop, today)

| Party | Sees |
|---|---|
| Service relay | Client IP, service node identity, timing, byte volumes. **Not** content. |
| TNP API | Which domain was resolved and which relay was handed out. |
| Service node | Client's circuit, content, and the client's request contents. Not the client's IP (the relay is between them). |
| Local observer | A TLS connection to a relay. Not the destination. |
| **TNP API (as an attacker)** | **Everything** — it can substitute the service node key and transparently decrypt (audit S3). |

That last row is the current reality and is why "end-to-end encrypted" is not an
honest description of the deployed system.

### Private mode (Phase 6, not implemented)

| Party | Sees |
|---|---|
| Guard | Client IP; that the client uses TNP. Not the destination. |
| Middle | Previous and next hop only. Neither client nor destination. |
| Exit / service relay | Destination; not the client IP. |
| Anyone watching both ends | Can correlate by timing and volume. See [`privacy-model.md`](./privacy-model.md). |

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
| 1 | Malicious client | Flood a relay, exhaust memory, abuse an exit | Authenticated circuits, quotas, frame limits, exit policy | **None today** (S2, S6) |
| 2 | Malicious service node | Serve hostile content under its own domain | Out of scope — it owns the name. Users trust names, not TNP. | By design |
| 3 | Malicious relay | Drop, delay, reorder, count, correlate; today: hijack a domain, inject into another client's circuit | Authenticated registration, per-connection circuit scoping, E2E crypto, multi-hop | **None today** (S1, S2) |
| 4 | Malicious exit | Read and modify unencrypted traffic; log destinations | Published policy, TLS end to end, reputation, user selection | Not implemented |
| 5 | Compromised directory | Steer every client onto attacker relays | Signed directory, pinned key, diversity constraints, stale-rejection | **None today** — directory is unsigned |
| 6 | Compromised API | Substitute keys → transparent MITM; rewrite records | Signed record sets chained to owner identity (naming.md §5) | **None today** (S3) — this is the single largest gap |
| 7 | Compromised Oxy account | Take over the user's domains and devices | Oxy 2FA; device revocation; per-domain key custody | Partial (Oxy side) |
| 8 | Stolen node key | Impersonate a node until noticed | Rotation, revocation, short-lived grants | Not implemented |
| 9 | Timing correlation | Deanonymize by matching flows at both ends | Padding, batching — **partial mitigation only** | Not implemented |
| 10 | Global passive adversary | Observe everything; correlate at will | **Out of scope. TNP does not defend against this and must never claim to.** | Explicitly out of scope |
| 11 | Sybil | Flood the directory with attacker relays to own whole paths | Operator diversity, registration cost, path constraints | Not implemented |
| 12 | Replay | Re-inject recorded frames | Counter inside the AEAD envelope | **None today** (S5) |
| 13 | Downgrade | Force a weaker version or capability set | Transcript signature; security capabilities non-negotiable downward | **None today** (S5) |
| 14 | Key substitution | Swap a key mid-flight | Grant chains; no unchained key is usable | **None today** (S3) |
| 15 | DNS poisoning / impersonation | Answer with attacker records | DNSSEC for public; signed record sets for native | **None today** (S8) |
| 16 | Malformed input | Crash or corrupt a parser | Bounds, fuzzing, structured errors | Partial — frame decode has a minimum, no maximum (S6) |
| 17 | Memory exhaustion | Unbounded frames, queues, caches | Hard limits everywhere | **None today** (S6, S9) |
| 18 | Connection exhaustion | Open connections until the relay dies | Per-IP and per-identity limits | **None today** |
| 19 | Exit abuse | Use TNP to attack third parties; expose the operator legally | Port policy, rate limits, private-range blocking, abuse handling | Not implemented |
| 20 | Update compromise | Ship malicious code to every device | Signed artefacts, channel separation, downgrade protection | Not implemented |
| 21 | Local privilege attack | Unprivileged local process reconfigures the daemon | Authenticated owner-only IPC; `0600` config | Partial |
| 22 | DNS leak | Names resolved outside the tunnel | Remote resolution, port-53 capture, encrypted-DNS capture | Not implemented |
| 23 | IPv6 leak | v6 escapes a v4-only tunnel | Full dual-stack capture or explicit v6 block | Not implemented |
| 24 | WebRTC leak | Browser reveals the local IP | Documented; browser-side guidance; cannot be fixed by the tunnel alone | Documented only |
| 25 | Accidental logging | Domains, IPs, tokens in logs | Redaction at generation; explicit logging policy | Partial |

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
| Access | Above, plus the service node's key chain |
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
