# Naming and namespace policy

**Status: normative policy. Rules N1–N5 are implemented in `@tnp/namespace` and
enforced by both the registry and the client. Migration steps M1–M3 are done;
M4–M7 remain. See §6.**

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
  `.invalid`, `.test`, `.example`, `.onion`, `.home.arpa`, `.arpa`.
- The IANA private-use TLD `.internal`.

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
from TNP data. Requirements, all mandatory:

1. **Per name.** Never per TLD, never a wildcard, never "all of TNP".
2. **User-installed, locally.** It is a local device decision. The registry
   cannot push one, and no API response can create one — otherwise a registry
   compromise silently re-points arbitrary public names.
3. **Visible.** `tnp status` lists every active override. The dashboard lists
   them. They survive no upgrade silently.
4. **Explicit at install.** The consent prompt names the exact name and states
   that its public meaning is being replaced on this device.
5. **Auditable.** Stored in one file, in one place, human-readable.

Overrides are a Phase 2 feature. They do not exist today, and until they do, no
public name may be answered from TNP data by any code path.

---

## 4. Ownership, delegation and lifecycle

| Property | Rule |
|---|---|
| Ownership | A domain is owned by exactly one Oxy identity. Ownership is proven with the owner's own credential, never a service credential. |
| Delegation | An owner may authorize other Oxy identities to publish under a domain. The grant is explicit, revocable, and recorded. |
| Records | Records are authoritative TNP data and are signed (§5) once Phase 2 lands. |
| Expiry | A domain has an expiry. Expired names stop resolving and enter a hold period before re-registration. |
| Reservations | Names may be reserved (trademark, abuse, infrastructure) and are unregistrable while reserved. |
| Recovery | A name recovered from an abusive registrant is placed in hold, not immediately re-issued, so the previous key material cannot be silently re-bound to the same name. |

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
  This is what closes audit finding S3: today the API can hand a client any key
  it likes for any domain, and the client has no way to notice.

Until this exists, `docs/` and every user-facing surface must say that TNP-native
answers are trusted because the API served them over TLS, not because they are
authenticated.

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
through TNP. This is the fix.)*

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

**M7 — Overrides.** Ship the per-name override mechanism (§3) so a user who
genuinely wants a private meaning for a public name can install one, deliberately
and visibly.

### What must not be done

- Do not delete affected registrations. Data loss for a policy error is not the
  owner's fault.
- Do not silently stop serving them without notice.
- Do not add a `preferTnp` global setting. A global override is the thing rule N1
  forbids, wearing a settings toggle.
- Do not keep serving them "just for existing users". A permanent grandfathered
  set is a permanent collision.
