# Naming and namespace policy

**Status: normative policy. Rules N1–N5 are implemented in `@tnp/namespace` and
enforced by both the registry and the client. Migration steps M1–M3 and M7 are
done; M4–M6 remain. See §6.**

---

## 0. The one rule

> **A public DNS name resolves identically with TNP installed and without it.**

No exception, no default, no "helpful" behaviour, no silent shortcut. If a user
looks up `google.com` on a machine running TNP, they get what the public DNS
would have given them. The only way to change that is an explicit, visible,
per-name override the user installed themselves, and which `tnp status` reports.

Everything else in this document exists to make that rule mechanically true
rather than a matter of care.

---

## 1. Namespace types

Every name is classified into exactly one type **before** any lookup happens.
Classification is a pure function of the name and the TLD policy table — it never
depends on a network call, on cache state, or on whether a record happens to
exist.

```ts
type NamespaceType = "tnp-native" | "public-dns";
```

| Type | Authority | Answered from |
|---|---|---|
| `tnp-native` | TNP registry | TNP data only. Never forwarded to public DNS. |
| `public-dns` | The public DNS root | The configured upstream only. Never answered from TNP data. |

There is no third state and no fallthrough between them. A `tnp-native` name that
does not exist is `NXDOMAIN` from TNP — it is not then tried against public DNS,
because that would let a TNP registration outrank a public one by simply not
existing yet. A `public-dns` name is never looked up in the TNP registry at all,
which is what makes rule N1 hold by construction rather than by care.

---

## 2. TLD classes

| Class | Meaning | Serving behaviour |
|---|---|---|
| **Native** | Exists only inside TNP. TNP is authoritative. | `tnp-native` |
| **Reserved** | The public DNS root delegates it, or IANA has reserved it. | `public-dns`. TNP refuses registration outright. |
| **Proposed** | A community proposal that has not been approved. | Not served. Does not affect classification. |

### N1 — TNP never claims a TLD the public root delegates

The reserved set is, at minimum:

- Every TLD in the current IANA root zone (`.com`, `.app`, `.net`, `.org`,
  `.dev`, `.io`, …).
- Every special-use name from RFC 6761 and RFC 8375: `.local`, `.localhost`,
  `.invalid`, `.test`, `.example`, `.onion`, `.home.arpa`, `.arpa`, and `.alt`
  (RFC 9476).
- The IANA private-use TLD `.internal`.
- Names in widespread private use on home and corporate networks, which some
  router, Active Directory domain or mDNS stack already answers: `.lan`,
  `.home`, `.corp`, `.mail` (the three ICANN deferred indefinitely over
  collision risk), `.localdomain`, `.intranet`, `.private`, `.workgroup`
  (`PRIVATE_USE_TLDS` in `@tnp/namespace`).

A registration request for a reserved TLD is rejected at the registry with a
`TLD_RESERVED` error. This is enforced server-side in the API, not only in the
web form — the API is the authority.

### N2 — The reserved set is data with a known source, not a hardcoded list

The root-zone-derived portion is refreshed from the IANA root zone database on a
schedule and stored as registry data with a fetch timestamp. A stale list is a
namespace-collision risk: a TLD delegated by IANA *after* someone registered it in
TNP is exactly the collision this rule exists to prevent, and the recovery path
for it is §6.

### N3 — Native TLDs are approved, never implicit

A native TLD becomes servable only through the existing TLD proposal and approval
flow, and only after passing the N1 reserved check at approval time as well as at
proposal time.

### N4 — Classification is offline and deterministic

The client caches the TLD policy table and classifies from that cache. It never
asks a network service "is this name mine?", because that question leaks every
name the user looks up to the TNP API — including their public browsing. Today's
client does exactly this for names under non-native TLDs; Phase 2 removes it.

### N5 — A name's classification never depends on registration state

Whether `example.ox` is registered changes what it resolves to. It never changes
whether it is a TNP name. Otherwise an attacker learns the registry's contents
by observing resolution behaviour, and an unregistered native name would silently
fall through to public DNS.

---

## 3. Overrides — the only way a public name changes meaning

An override is a per-name, user-installed rule that answers a `public-dns` name
differently on the user's own device. Requirements, all mandatory:

1. **Per name.** Never per TLD, never a wildcard over a TLD, never "all of
   TNP". The one subtree form is a *block* of a name and its subdomains
   (below); it can only remove answers, and never covers a single-label name.
2. **User-authored and device-applied.** The registry cannot create one, and
   no API response can — otherwise a registry compromise silently re-points
   arbitrary public names. For synced rules this is cryptographic, not a
   policy: the API stores only ciphertext and never holds the key.
3. **Visible.** `tnp status` reports the active rules and where they live;
   `tnp rules status` and the dashboard list every one. They survive no
   upgrade silently.
4. **Explicit at install.** A rule that makes a public name answer something
   else (a redirect) takes effect on a device only after a consent prompt
   there that names the exact name and target and states that its public
   meaning is being replaced on this device.
5. **Auditable.** The rules in force on a device are in one file, in one
   place, human-readable.

### Synced personal rules

**Status: implemented** (`@tnp/crypto/dns-rules`, `@tnp/shared-types`
`dns-rules`, `packages/client/src/dns-rules*.ts`, `/dashboard/dns-rules`;
user guide `docs/dns-rules.mdx`). This is the only mechanism by which a public
name is answered differently by any TNP code path.

- **Authorship.** A rule set is encrypted end to end under a random *rules
  key*, itself wrapped under a key derived (Argon2id) from the user's sync
  passphrase. Only someone holding the rules key — that is, the passphrase or
  a device that already pulled — can author a rule set that decrypts. The
  registry stores `{wrappedKey, kdfParams, salt, ciphertext, nonce, version,
  updatedAt}` per Oxy account and nothing else; it cannot read, edit or
  create a rule. Associated data binds the Oxy user id and the version, the
  version is also inside the plaintext, and a device refuses a version lower
  than one it accepted (and the same version with different bytes), so the
  server can neither swap blobs between accounts nor roll a device back
  silently.
- **Block rules** answer `NXDOMAIN` for one exact name, or for a name and all
  its subdomains. They may cover native and public names alike, and they
  apply on a device as soon as it pulls: they can only make a name stop
  resolving (fail closed), never point it anywhere. A holder of the rules key
  can therefore deny names on the user's devices, but never redirect one.
- **Redirect rules** cover one exact name, never its subdomains, and answer
  with an IPv4 or IPv6 address (other types: NODATA) or a CNAME to another
  name resolved through the normal path, without applying rules again (no
  chains, no loops). A redirect of a **native** name is refused everywhere —
  the web form, the client's parser, and the resolver at answer time — because
  the TNP namespace is authoritative for it. A redirect of a public name
  applies on a device only after `tnp rules approve` on that device; the
  approval pins the exact target, and a later change of target needs
  approving again. So neither the registry nor anyone who learns the
  passphrase can change what a public name means on a device without a person
  at that device agreeing.
- **Where they apply.** Only to queries answered by the user's local TNP
  resolver (`tnp run`, `tnp connect`) or by a router the user configured from
  the dashboard's local export. The public TNP resolver never applies personal
  rules: it has no key and is never given a rules file.
- **Per-name OS routing.** With `tnp install` the OS routes only native TLDs
  to the local resolver (resolution.md §10). For the public names a device's
  *active* rules cover — blocks the user pulled, and redirects the user
  approved on that device, nothing else — `tnp rules pull/approve/revoke`
  also install per-name routing to the installed resolver: a separate
  systemd-resolved delegate (`tnp-rules.dns-delegate`, `Domains=~name …`, no
  default route; a `tnp2` link before systemd 258), one `/etc/resolver/<name>`
  per name on macOS, or NRPT rules tagged `Managed by TNP (personal rules)` on
  Windows (an exact FQDN rule, plus the `.name` suffix for a block with
  subdomains). On Linux and macOS a routed name carries its subdomains to the
  TNP resolver too; those it simply forwards upstream. What was written is
  recorded in the root-only `dns-routing-rules.json`, and revoke, forget and
  uninstall remove exactly that. A pre-existing `/etc/resolver/<name>` or a
  foreign file at the delegate path is never overwritten, and nothing is
  routed without an installed resolver (a name sent to a resolver that is not
  running would stop resolving). These OS routing objects are readable by
  other local accounts, so a routed name is visible to them.
- **One file.** The device writes the decrypted, approved set to
  `<configDir>/dns-rules.conf` (Linux `/etc/tnp/dns-rules.conf`, root:tnp
  0640 so the sandboxed daemon can read it; 0600 elsewhere). The rules key,
  the rollback record and approvals stay in root's state directory, which the
  daemon cannot read. The resolver refuses the file outright if it is a
  symlink, not owned by root (or itself), writable by group or others, or not
  exactly what `tnp rules` writes.

Rules the user writes into a router from the export are the router's
configuration, outside TNP: the export is generated in the browser and never
sent to the API, and its format-specific limits are documented there.

---

## 4. Ownership, delegation and lifecycle

| Property | Rule |
|---|---|
| Ownership | A domain is owned by exactly one Oxy identity. Ownership is proven with the owner's own credential, never a service credential. |
| Delegation | An owner may authorize other Oxy identities to publish under a domain. The grant is explicit, revocable, and recorded. |
| Records | Records are authoritative TNP data and are signed (§5) once Phase 2 lands. |
| Expiry | A native registration lasts one year and is renewed free by its owner. States, windows and enforcement are below. A name is never released by lapsing: an expired name is held for its owner. |
| Reservations | Names may be reserved (trademark, abuse, infrastructure) and are unregistrable while reserved. |
| Recovery | A name recovered from an abusive registrant is placed in hold, not immediately re-issued, so the previous key material cannot be silently re-bound to the same name. |

### Native expiry and renewal

**Status: policy implemented and shown to owners; enforcement implemented but
off.** The policy is `nativeExpiryState` in `@tnp/namespace`
(`packages/namespace/src/expiry.ts`), a pure function of the stored `expiresAt`
and a clock. It applies to native registrations only; public domains in the
services layer take their dates from the registrar (`services.md` §4).

| State | When | Resolves | Owner may renew |
|---|---|---|---|
| `active` | more than 90 days before `expiresAt`, or `expiresAt` is null | yes | no |
| `renewable` | from 90 days before `expiresAt` until it | yes | yes |
| `grace` | from `expiresAt` until 30 days after, inclusive | yes | yes |
| `expired` | more than 30 days after `expiresAt` | yes, unless enforcement is on | yes |

- **No expiry.** `expiresAt = null` is a registration that does not expire.
  Rows written before expiry existed are never made to expire by this policy.
- **Renewal** (`POST /domains/:id/renew`) is free, owner-only and native-only
  (a legacy row under a reserved TLD is migrated per §6, not renewed). It sets
  `expiresAt` to one calendar year (UTC) after the later of the current expiry
  and now, so renewing early loses nothing and renewing a lapsed name does not
  back-date it. The write is a compare-and-set on the expiry that was read: two
  concurrent renewals extend the name once, and the second reports a conflict.
- **Held, not released.** An expired name keeps its row, so it stays
  unregistrable by anyone else, and `/domains/check` reports it `registered`.
  Nothing in this policy deletes a registration or its records.
- **Enforcement** is `TNP_NATIVE_EXPIRY_ENFORCED`, off unless exactly `true`.
  When on, an `expired` name is answered by `/dns/resolve` like an unregistered
  one (parking only; no records, no overlay) and its parking page says "expired,
  held" — never "available". It stays off until owners of existing
  registrations have been told, through an approved communication, that their
  names expire (#62): switching it on retroactively without that is forbidden.

### Abuse prevention

Registration is rate-limited per identity. Homoglyph and confusable-label
detection runs at registration and flags rather than silently rejects — a false
positive that blocks a legitimate registration is worse than a flagged one that
a human clears. Bulk registration by one identity is capped.

---

## 5. Record authenticity

TNP-native answers must be verifiable by the client without trusting the
transport that carried them or the server that served them.

Target design (Phase 2):

- Each domain has a **domain signing key**, authorized by the owner's Oxy
  identity through the key hierarchy in [`security.md`](./security.md).
- A record set is serialized canonically, given a validity window and a monotonic
  serial, and signed with the domain signing key.
- The client verifies the signature and the chain to the owner before using the
  answer, and rejects a serial lower than one it has already seen (rollback
  defence).
- The service node's transport key is published **inside this signed record set**.

**Implemented so far** (Phase 3 transport, [`security.md`](./security.md) §1):
each native name has an owner-held **domain key** — not chained to the Oxy
identity, deliberately, so a compelled operator cannot mint one — and the
service node's transport key reaches the client as a grant chain and
certificate rooted at it, which the client verifies against the domain key it
pinned for the name on first use. That closes audit S3 for the transport key,
for names a client has already used. **DNS records are still not signed**: a
TNP-native answer is trusted because the API served it over TLS, not because
it is authenticated, and `docs/` and every user-facing surface must say so.

---

## 6. Migration away from the current collision

### What was wrong

Verified in the audit (finding S4):

1. `apps/api/src/seed.ts` seeded `.com` and `.app` as active TNP TLDs.
2. `packages/client/src/service.ts` wrote `/etc/resolver/com` on macOS, pointing
   every `.com` lookup on that machine at the TNP resolver.
3. The Linux installer wrote a systemd-resolved drop-in with `Domains=~.`,
   making TNP the routing domain for **all** DNS.

Together these meant a TNP registration of a public name changed that name's
meaning for TNP users. That is the thing rule N1 forbids.

### Migration, in order — no step may be skipped

Deliberately staged so that nobody's working setup breaks without warning.

**M1 — Stop the bleeding. ✅ Done.** The registry rejects registrations and
proposals under reserved TLDs (`TLD_RESERVED`), `.com` and `.app` are out of the
seed, and reserved TLDs are filtered out of `/tlds`, `/dns/tlds` and
`/dns/resolve` at read time — so the fix takes effect on a database that still
holds those rows, without waiting for a data migration. Existing registrations
keep working. *(No user-visible breakage.)*

**M2 — Narrow the capture. ✅ Done.** Installers capture native TLDs only. macOS
writes `/etc/resolver/<native-tld>` and nothing else, and removes any
`/etc/resolver/<reserved>` a previous version wrote — but only when the file
points at TNP's own loopback resolver, since an entry pointing elsewhere belongs
to another tool. Linux writes per-TLD routing domains instead of `Domains=~.`,
and the drop-in is overwritten on upgrade. *(Public names stop being routed
through TNP. This is the fix.)* That drop-in still put `DNS=127.0.0.1` in
resolved's global section, which receives every lookup that matches no
routing domain, and the installers still replaced the default interface's
servers (Linux) or prepended 127.0.0.1 to every adapter (Windows). Since
then, routing is a resolved DNS delegate or a dedicated link on Linux and an
NRPT rule on Windows, scoped to the native TLDs, and the user's own DNS
settings are never written (resolution.md §10).

**M3 — Enforce classification. ✅ Done.** `classifyName` is pure and offline.
Reserved-TLD names never reach the registry — which is both the namespace
guarantee and a privacy property, since the API no longer learns the user's
public browsing. The client re-checks the reserved set itself and drops reserved
TLDs the API offers, so a stale or hostile registry cannot make it shadow a
public name. *(Public names now provably cannot be answered from TNP data.)*

**M4 — Inventory and notify.** Enumerate every existing registration under a
reserved TLD. Notify each owner with the timeline and their options.

**M5 — Offer a native equivalent.** Each affected owner is offered the same label
under a native TLD, with the registration transferred rather than re-purchased,
and a redirect from the old record for the hold period.

**M6 — Retire.** After the notice period, reserved-TLD registrations move to
`status: retired`: not served, not deleted, not re-registrable. Retained so an
owner who missed the notice can still recover their name.

**M7 — Overrides. ✅ Done** as synced personal rules (§3): a user who genuinely
wants a private meaning for a public name can install one, deliberately and
visibly, on their own devices.

### What must not be done

- Do not delete affected registrations. Data loss for a policy error is not the
  owner's fault.
- Do not silently stop serving them without notice.
- Do not add a `preferTnp` global setting. A global override is the thing rule N1
  forbids, wearing a settings toggle.
- Do not keep serving them "just for existing users". A permanent grandfathered
  set is a permanent collision.
