# Services: public domains, DNS and hosting (ADR)

**Status: accepted 2026-09-17, normative for the optional services layer.**
Coordinating issue: #62. Supersedes the "out of scope" entries for domain sale,
renewal, transfer, resellers and checkout in `roadmap.md`, `overview.md` and the
README, and the "OpenProvider first" decision in #12 — **for the optional
services layer only**. Nothing here changes the network architecture.

State of each part is marked: **Implemented**, **Designed** (model and contract
fixed, no production path) or **Blocked** (waiting on a decision outside this
repository). Nothing Designed or Blocked may be presented as available.

---

## 1. Decision

TNP exists for **TNP Network**: the namespace, resolution, service publication
and clients. That stays the default experience and the product's centre.

Next to it, TNP gets a second, optional product area — **Services** — for
contracting and managing public DNS domains, DNS zones and, later, hosting,
through trusted providers. Namecheap is the first registrar adapter. It is not
the architecture.

Invariants that hold for the whole implementation:

1. **The network runs with every commercial feature off.** No Namecheap
   variable, no provider account and no payment configuration is needed to
   start the API, resolve a name, register a native name or publish a service.
   A CI step starts the API image with none of them set.
2. **Native names and public domains are different resources.** A `.com`
   bought through TNP is a row in `public_domains`, never in `domains`, never in
   `tlds`, and never on `/dns/tlds`. It resolves through the public DNS
   authority exactly as it would without TNP (`naming.md` rule N1 is untouched).
3. **Registering, hosting a zone, hosting a site and publishing a TNP service
   compose; they are not one product tied to one provider.**
4. **One identity: Oxy.** No second login, no new auth subdomain.
5. **Capabilities are proven, not assumed.** Every adapter operation declares
   `automated | manual | unsupported` with the date and environment it was
   validated in. `unknown` is a valid outcome of a remote call; an empty
   operation that returns success is not.
6. **External services never run on the resolution or transport path.** No
   provider API call happens during a DNS lookup, a relay hop or a service-node
   heartbeat.
7. **This ADR authorizes no purchase, deployment, infrastructure change or relay
   activation.** Those each need their own explicit approval.

## 2. Boundaries

```text
apps/api/src/
  routes/ ...                 TNP Network (native registry, DNS, nodes, relays)
  services/                   optional commercial layer
    config.ts                 feature flags, all off by default
    money.ts                  integer minor units + ISO 4217 currency
    publicNames.ts            public-name normalization (IDN, case, root dot)
    providers/
      contracts.ts            RegistrarAdapter · DnsAdapter · HostingAdapter
      errors.ts               normalized ProviderError taxonomy
      registry.ts             adapter lookup by (adapter, environment)
      secrets.ts              secret references, never secret values
      rateLimit.ts            PostgreSQL-backed shared quota windows
      namecheap/              the first registrar/DNS adapter
    operations/               durable outbox, leases, reconciliation
    dns/                      safe full-zone apply (read, merge, diff, re-read)
    orders/ quotes/           quotes, orders, lines, idempotency
    routes.ts                 /services router
  workers/commerce.ts         separate process: same code, own pool and quotas
```

Import rules, enforced by `scripts/check-import-boundaries.ts` in CI:

| From | May import `apps/api/src/services/**` |
|---|---|
| `apps/api/src/routes/**`, `apps/api/src/db/**` (except the schema module), `apps/api/src/middleware/**` | **No** |
| `apps/dns-server`, `apps/relay`, `apps/web`, `packages/**` | **No** |
| `apps/api/src/index.ts` | Only `services/routes.ts` and `services/config.ts` |
| `apps/api/src/workers/**` | Yes |

Adapters holding secrets stay in the API process tree and are never a
transitive dependency of the web app, the CLI, the resolver or a mobile app.
Public wire contracts for `/services` live in `@tnp/shared-types` like every
other contract. The native registry may appear in a unified inventory through a
read-only façade in the web app; it never depends on the services layer.

A new library is extracted only when it has a second real consumer.

## 3. Capability model

Separate concepts, separate tables:

| Concept | Meaning | Where |
|---|---|---|
| Provider | An external company and its operational evaluation | `docs/providers/<name>.md` |
| Adapter | Code for one API family, versioned, with a capability matrix | `services/providers/<name>/` |
| Provider account | TNP's credentials for an adapter in one environment, with sales and management modes | `provider_accounts` |
| Offer / quote | Product, term, price, currency and expiry one account can supply | `quotes` |
| Binding | TNP resource ↔ the account and remote resource that really manages it | `public_domains.provider_account_id` + `remote_id`, `dns_zones` |
| Operation | Durable intent to change something remotely, reconciled | `operations` |

The same company can have unrelated adapters (Namecheap domains API vs.
Namecheap WHM reseller hosting). A shared brand implies no shared credentials,
permissions or semantics.

Contracts are narrow (`contracts.ts`):

- **Registrar** — offers by extension/operation/term, availability, pricing,
  register, renew, contacts, locks, transfer in, transfer status, info, list,
  balance.
- **DNS** — read zone, apply a full desired zone, supported record types and
  fields.
- **Hosting** — plans, provision, status, change plan, suspend, resume, cancel,
  access, backup/export. **Designed only**: no adapter, no table, no UI until a
  provider and product pass the hosting gate (§9).

A DNS-only provider does not pretend to register domains; a registrar does not
pretend to host.

### Normalized errors

`validation`, `not_available`, `unsupported`, `credentials`, `rate_limited`,
`insufficient_funds`, `conflict`, `permanent`, `provider_unavailable`, and
**`unknown_outcome`**. `retryable` is a property of the error *and* of the
operation kind: a timeout on a read is retried; a timeout after a `create` or a
`renew` was sent is `unknown_outcome` and is never retried blind. Messages shown
to users carry no XML, secrets or another customer's data.

### Provider selection

Among approved accounts, by capability, region, total renewal cost, observed
reliability and explicit policy — never on first-year price alone. Provider,
account and price are pinned in the quote and copied into the operation. An
existing domain's operations go back to the account it is bound to. An outage
never authorizes buying through another provider after a timeout or silently
moving a domain between registrars. Registrar transfer, DNS migration and
hosting migration are three separate workflows, each with pre-validation,
confirmation and a recovery plan.

A second adapter exists **only in tests** (`providers/testing/`), with
deliberately different capabilities and latency, so the contracts are exercised
by more than one implementation. It is never registered in a running process.

## 4. Data

Additive PostgreSQL migrations. Native tables and ids are untouched.

| Table | Holds | Rules |
|---|---|---|
| `provider_accounts` | adapter, environment (`sandbox`/`production`), label, `sales_state` (`enabled`/`sales_disabled`), `management_mode` (`active`/`read_only`/`disabled`), `secret_ref`, non-secret config, validated capabilities | A secret reference, never a secret. Sales and management are separate switches: disabling sales never stops renewals or support for existing resources. |
| `public_domains` | canonical ASCII name, Unicode display name, registrable suffix, owner, account, remote id, registrar dates and raw statuses, normalized lifecycle, lock, privacy, renewal mode and consent, last sync | Unique per `(provider_account_id, canonical_name)`. Expiry comes from the registrar, never `now + 1 year`. |
| `domain_contacts` | registrant/admin/tech/billing contact per domain | Never in a public DTO, log, trace or fixture. The legal registrant, the Oxy access owner, the payer and TNP's wholesale account are four different things. |
| `dns_zones` | authority (`provider`/`external`), account, observed hash, desired/applied version, state, last verification | One per public domain. |
| `dns_zone_snapshots` | observed and applied record sets with hash | For operational recovery. Never restored blind over later changes. |
| `quotes` | account, operation, subject, term, currency, cost/price/fees/renewal price in minor units, premium, expiry, consumption | Money is `bigint` minor units plus currency. Never floating point. |
| `orders`, `order_lines` | owner, idempotency key + intent hash, immutable amounts, order state, payment state, per-line state and references | Payment state and fulfilment state are separate: a captured payment does not prove a registration. |
| `operations` | kind, resource, account, idempotency key, intent hash, non-sensitive payload, state, attempts, lease, next run, `submitted_at`, result, error | The outbox. See §5. |
| `provider_rate_windows` | per-account minute/hour/day counters | Shared across replicas. |
| `audit_events` | actor, action, resource, correlation id, outcome, minimized metadata | Restricted access. No traffic data, queries or keys. |

Public names are normalized before they touch storage or a provider: Unicode →
Punycode, lowercase, trailing dot removed, label and total length checked. The
registrable suffix is the **longest suffix the provider account actually offers**
(its TLD list), not `split('.')` and not a public-suffix list on its own — a PSL
entry does not prove a name can be bought. `nombre.co.uk` stays one domain. The
native classifier in `@tnp/namespace` is not shared with this parser.

## 5. Operations: durable, idempotent, reconciled

A remote call is not a PostgreSQL transaction, and `try/catch` does not make it
exactly-once.

```text
search -> quote (expires) -> consent
       -> payment authorization verified server-side      [Blocked, §8]
       -> order + operation written in ONE transaction
       -> worker claims with a lease -> provider
       -> confirmation / reconciliation -> resource active
```

States: `queued`, `running`, `succeeded`, `failed`, `unknown`,
`manual_review`.

- **Idempotency** — `(owner, idempotency_key)` is unique and stores a hash of
  the intent. The same key with the same intent returns the existing order; the
  same key with a different intent is `409`.
- **Claiming** — `FOR UPDATE SKIP LOCKED`, a lease with an expiry, and one
  running operation per resource enforced by a unique
  `operation_resource_leases` row (an advisory lock cannot outlive the claiming
  transaction on a pooled connection). A crashed worker's lease expires and the
  operation is reclaimed; a mutating operation whose `submitted_at` is set is
  reclaimed into **reconciliation**, not re-execution. A stale worker cannot
  mark a submission or record a result once its lease is gone.
- **Persist, then call** — the intent and `submitted_at` are committed before
  the provider is called. No transaction is held open across the call.
- **Unknown outcome** — a timeout or dropped connection after a mutating call
  was sent moves the operation to `unknown`. The reconciler looks for evidence
  (remote list/info, dates, ids). Found → `succeeded`; proven absent after the
  provider's settle window → safe to retry once; still unprovable →
  `manual_review`. It never registers twice, renews twice, switches provider or
  refunds automatically while the outcome is unknown.
- **Retries** — reads retry with backoff; writes retry only on errors that
  prove nothing was applied (`validation` never, `rate_limited` and
  `provider_unavailable` before submission only).
- **Partial fulfilment** — if a domain registers and a later line fails, the
  domain is kept and the failed line resolved on its own. No generic
  compensation that tries to undo an irreversible purchase.

## 6. DNS for public domains

TNP is **never** the authority for a public name by copying its zone. Public
resolution uses the public DNS; nothing in the resolver or `/dns/resolve` reads
`public_domains` or `dns_zones`.

A public domain's zone is hosted by its registrar's DNS, another integrated
provider, or externally by the owner. External zones are `unmanaged`: TNP shows
instructions and verification state and never pretends a local edit was
published. Nameservers never change as a side effect of another purchase; a
change needs preview, consent and a check of the existing zone.

**Namecheap `domains.dns.setHosts` deletes every record not included in the
call.** The apply path therefore:

1. Serializes writes per zone across replicas: each change is a `dns.apply`
   operation on the zone, and the per-resource lease above lets only one run at
   a time (not an in-memory mutex).
2. Re-reads the full remote zone and compares its hash with the last observed
   hash. A mismatch is an external change: the operation stops in `conflict`
   and asks the owner to reconcile.
3. Merges the owner's change into the full remote set, preserving every record
   and field TNP is not editing (MX, verification TXT, …), validates it, and
   records a snapshot of what it observed.
4. Sends the complete set, re-reads, and confirms the result matches before
   marking the zone `in_sync`.

The lock serializes TNP's own writers; it does not stop someone editing in the
provider's panel. The provider exposes no compare-and-swap, so the re-read in
step 2 narrows the window and does not close it. That is stated in the UI.
DNSSEC, CAA, SRV and glue appear only once the adapter implements and validates
them.

## 7. Namecheap

Facts from the official documentation (sources in `docs/providers/namecheap.md`),
**to be re-validated against the actual account and environment**: reselling
through the API is permitted without a separate reseller program; responses are
XML; calls must come from a whitelisted IPv4; published limits are 50/min,
700/hour and 8000/day per key; sandbox is a separate system that proves nothing
about production availability.

Adapter rules:

- Server-side HTTPS only; XML parsed with a size cap, DOCTYPE/entities
  rejected, and `Status="ERROR"` treated as a failure even under HTTP 200.
- Sandbox and production are separate accounts with separate credentials; an
  operation carries its account's environment and a guard refuses to act on a
  resource bound to the other.
- `ClientIp` comes from verified server configuration, never a request header.
  It must be the **egress** address of the process making the call, provisioned
  in `oxy-infra` — not the NLB address the DNS server listens on.
- Per-operation timeouts, the shared rate limiter above, and a reserved share of
  each window for renewals and reconciliation so public search cannot starve
  them.
- Balance is monitored and never shown to customers. Topping it up is an
  authorized operational process.
- Importing domains already in the wholesale account never assigns them to an
  Oxy user by guesswork.
- No webhooks are assumed. Polling reconciliation is the implemented path.
- `ApiKey`, contacts, EPP codes and sensitive responses are redacted in logs,
  errors, traces and fixtures.
- Outbound transfer (EPP code retrieval) has no confirmed API method: it is an
  assisted, audited workflow until one is verified.

Out of the first release: hosting, SSL, email or any other Namecheap product.

## 8. Payments — Blocked

Oxy owns billing across the ecosystem (`~/Oxy/docs/project-map.md`). TNP keeps
orders and fulfilment state; it does not become a bank, a wallet or a second
billing system. **The payment method and the service that executes it are not
decided.** Stripe, FairCoin, a currency and an Oxy checkout are all unassumed.
#14's FairCoin-only requirement is not revived by inertia.

Until a mechanism is approved and integrated, the order route refuses with
`payments_not_configured`: there is a `PaymentAuthorizer` seam with exactly
one production implementation, which refuses. Payment confirmation never comes
from a client-supplied boolean. Sandbox fulfilment is exercised by an operator
script that only accepts sandbox accounts and never charges anyone.

Before sales: currency and pricing, taxes, invoices, renewal consent, failed
charges, refunds, cancellation and support responsibilities are defined.

## 9. Launch gates

| Gate | Requires | State |
|---|---|---|
| Foundation | Contracts, registry, schema, outbox, worker, import gate, commerce-off start, two adapters in tests, real-PostgreSQL tests | **Implemented** (#62 Phase 2) |
| Namecheap sandbox | Adapter against sandbox with real credentials, capability matrix dated, uncertain-timeout drill | Designed — adapter in progress (#62 Phase 3); **sandbox run Blocked** on credentials and an egress IP in `oxy-infra` |
| Domain pilot | Approved payment mechanism, terms, support, runbooks, alerts, balance monitoring, limited authorized pilot | **Blocked** (§8) |
| First hosting | Approved provider and product, API/permission validation, isolation, backup restore demonstrated | **Blocked** — no provider approved |
| Second provider | A real, evaluated second provider on the same contracts, export/migration rehearsed | **Blocked** — no provider approved |
| Edge integration | Public gateway, TLS trust design, transport gates of #19 | **Blocked** on #19/#21 |

Feature flags are independent — `TNP_SERVICES_CATALOG`, `TNP_SERVICES_SALES`,
`TNP_SERVICES_DNS_WRITE`, and `TNP_SERVICES_WORKER` for the outbox worker — and
all default to off. No flag disables TNP Network, and turning a product flag off
never stops the worker syncing and reconciling what already exists. Renewals get
a switch with the payment mechanism, not before: a flag with no behaviour behind
it would be a claim the code does not support.

### Operating the foundation

| What | How |
|---|---|
| Worker | `bun run worker:services` in `apps/api` (image command `bun apps/api/src/workers/commerce.ts`). Runs only with `TNP_SERVICES_WORKER=1`; otherwise exits, logging `worker.disabled`. |
| Provider account | `bun src/services/scripts/provider-account.ts --adapter … --environment sandbox --label … --secret-ref env:NAME --config '{…}'`. Production needs `--confirm-production`. |
| Sandbox order | `bun src/services/scripts/sandbox-order.ts --account <id> --owner <oxy user id> --name … --contact contact.json` — the no-charge authorizer refuses anything but sandbox. |
| Routes | `GET /services/status`; with flags: `GET /services/domains/availability`, `POST /services/quotes`, `POST /services/orders` (503 `payments_not_configured`), `GET /services/domains[/:id[/operations]]`, `POST /services/domains/:id/zone/preview`, `POST /services/domains/:id/zone/changes`. |
| Gates | `bun run validate:boundaries`; `bun run test:db` (outbox, reconciliation, quota, DNS apply, routes against PostgreSQL); CI starts the API image with no services configuration and requires `/services/status` to report off and the worker to stay disabled. |

Retail pricing is also undecided: a quote's price is the provider's cost plus
its itemized fees, with no margin, until a pricing policy is approved with the
payment mechanism.

## 10. Hosting — Designed

A site is a resource independent of any domain: plan, region, quotas, remote
reference, status and billing. A **binding** links a domain (public or native)
to a site, a TNP service or an origin, with its own permission and proof of
control, so a domain can have several bindings without changing its identity.
Tables and adapter arrive with the first real product, not before.

Rules fixed now: one bounded family first (managed web, static or VPS — not
all three); no "unlimited" claims; a domain is optional at site creation and may
come from another registrar after proof of control; `.ox` is never sent to a
provider as if it were a public domain and gets no promise of public
certificates; a provider advertising backups is not a restore TNP has
demonstrated; wholesale credentials are never shared with customers.

Namecheap's reseller hosting is WHM/cPanel, with permissions controlled by the
server administrator. That proves nothing about the domains API provisioning
hosting or about TNP's account having the WHM functions needed.

Reaching a TNP service from a browser without a TNP client needs a real public
gateway, DNS and TLS; it does not appear by buying a domain. Edge TLS
termination and opaque end-to-end transport have different trust boundaries and
stay explicit in the UI and in `privacy-model.md`. No anonymity, origin-hiding
or DDoS guarantees that have not been demonstrated.

## 11. Security

- Authorization by user, resource and action on every `/services` route. A
  `providerAccountId` or remote id from the browser is never trusted.
- Provider endpoints are allowlisted constants, never URLs from a client.
- Rate limits on public search, mutations and queued work; defence against
  draining the provider balance or quota.
- Registrant data and transfer codes are separated from the public directory,
  UI caches and analytics.
- Native registration never asks for legal contact data because another
  product needs it.
- Support access is scoped and audited; transfers and owner changes need
  stronger confirmation.
- Account deletion, a registered domain and a retention obligation are three
  different things; the flow is designed before launch.

Each provider gets an admission record: contract and resale right, auth and
limits, observed reliability, support and escalation, renewal pricing, export
and transfer, data policy and locations, incident and abuse procedure, exit
plan. Approval is per product family and account, and reviewed periodically.

## 12. Operations

- Separate metrics for the network (DNS latency/errors, API health) and for
  services (queue depth, `unknown` operations, sync lag, upcoming expiries,
  quota and balance).
- `/health` is liveness and touches nothing external; `/health/ready` checks
  the database. Neither consults a provider, so a commercial outage never takes
  the network out of rotation.
- The worker runs as its own process with its own pool size and concurrency.
- Infrastructure — secrets, IAM, stable egress, the worker service, alarms — is
  owned by `oxy-infra`. This repository creates none of it.
- Rollback is code plus read-only mode. A database rollback never pretends to
  undo an irreversible provider operation.
- Gradual promotion: sandbox, then an authorized limited pilot. CI never makes
  a real purchase.

## 13. Relationship to earlier decisions

| Issue / doc | Effect |
|---|---|
| #6, `overview.md` | Network architecture unchanged. The "not a registrar" line now refers to the network; the services layer is optional and separate. |
| #12 | "OpenProvider first" is superseded by "Namecheap first, multi-provider by contract". Its decoupling and portability requirements are kept. A further provider is added only after evaluation. |
| #14 | FairCoin-only is not revived. The payment decision is open (§8). |
| #19 | Mandatory gate for any product using the relay/edge. It does not block a domains adapter. |
| `audit-2026-08-06.md` §7 | The "out of scope" list is historical; this ADR replaces it for the services layer. |
