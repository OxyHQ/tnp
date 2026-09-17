# Provider admission record: Namecheap

**Status: under evaluation. Not approved for sales.** Governed by
[`../architecture/services.md`](../architecture/services.md) §11. Every fact
below is from Namecheap's public documentation as read on 2026-09-17 and must
be re-validated against TNP's actual account and environment before it is
relied on. "Documented" is not "validated".

## Scope

| Product family | Adapter | Decision |
|---|---|---|
| Domain registration and management (API) | `namecheap` | Evaluating — first registrar adapter |
| DNS hosting for domains registered there (`domains.dns.*`) | `namecheap` | Evaluating, with the `setHosts` rules in `services.md` §6 |
| Reseller hosting (WHM/cPanel) | none | **Not evaluated.** No evidence the domains API provisions hosting or that TNP's account has the WHM functions required |
| SSL, email, VPN, other products | none | Out of the first release |

## Record

| Item | Documented | Validated |
|---|---|---|
| Right to resell | Resale through the API is permitted without a separate domain reseller program ([KB 754](https://www.namecheap.com/support/knowledgebase/article.aspx/754/63/do-you-have-a-domain-reseller-program/)) | No — needs contract review |
| Authentication | `ApiUser`, `ApiKey`, `UserName`, `ClientIp` query parameters over HTTPS ([intro](https://www.namecheap.com/support/api/intro/)) | No |
| Source IP | Calls must come from a whitelisted IPv4 ([intro](https://www.namecheap.com/support/api/intro/)) | No — needs a stable egress address in `oxy-infra` |
| Production access | Account activation requirements apply to production API access ([FAQ](https://www.namecheap.com/support/knowledgebase/article.aspx/9739/63/api-faq/)) | No |
| Sandbox | `api.sandbox.namecheap.com`, a separate system with separate accounts | No |
| Rate limits | 50/minute, 700/hour, 8000/day per key ([FAQ](https://www.namecheap.com/support/knowledgebase/article.aspx/9739/63/api-faq/)) | No |
| Response format | XML; `ApiResponse/@Status` is `OK` or `ERROR`, errors in `Errors/Error` with a `Number` | Fixtures only (adapter tests, see [Adapter](#adapter)) |
| Methods used | `domains.check`, `domains.getTldList`, `users.getPricing`, `users.getBalances`, `domains.create`, `domains.renew`, `domains.getInfo`, `domains.getList`, `domains.getContacts`, `domains.setContacts`, `domains.getRegistrarLock`, `domains.setRegistrarLock`, `domains.dns.getHosts`, `domains.dns.setHosts`, `domains.transfer.create`, `domains.transfer.getStatus` ([methods](https://www.namecheap.com/support/api/methods/)) | Fixtures only |
| `setHosts` semantics | Records omitted from the call are deleted ([setHosts](https://www.namecheap.com/support/api/methods/domains-dns/set-hosts/)) | Fixtures only |
| FreeDNS / PremiumDNS | API management is limited ([FAQ](https://www.namecheap.com/support/knowledgebase/article.aspx/9739/63/api-faq/)) | No |
| Webhooks | None relied upon; polling reconciliation is the implemented path | n/a |
| Outbound transfer (EPP code) | No confirmed API method found | Assisted workflow until verified |
| Renewal pricing and changes | Via `users.getPricing` | No |
| Export and exit | `domains.getList` + `getInfo` + `getContacts` + `getHosts` give a provider-neutral export; registrar transfer-out per extension | No |
| Data policy and locations | Not yet reviewed | No |
| Support, escalation, incident and abuse procedure | Not yet reviewed | No |
| Observed reliability | None — no calls made | No |

## Before approval

1. Contract and resale terms reviewed and accepted by whoever owns that
   decision for Oxy.
2. Sandbox account and production account created, credentials stored in the
   secret manager through `oxy-infra`, egress IPv4 whitelisted.
3. Sandbox run of the adapter's opt-in suite, with the capability matrix in the
   adapter updated to the validation date.
4. Data policy, support/escalation and abuse procedures reviewed.
5. Exit plan rehearsed: export and a transfer-out of a sandbox or test domain.

## Adapter

Code: `apps/api/src/services/providers/namecheap/` (`namecheapFactory`, adapter
name `namecheap`). Implements `RegistrarAdapter` and `DnsAdapter` against the
method pages as archived on 2026-09-17. **Validated: fixtures only.** Every
capability declares `validatedAt: null`; no call has reached a Namecheap
environment.

### Transport

| Rule | Implementation |
|---|---|
| Endpoint | Constant per account environment: `https://api.sandbox.namecheap.com/xml.response` or `https://api.namecheap.com/xml.response`. Never from config or input. |
| Authentication | `ApiUser`, `ApiKey` (resolved from `secretRef` when the adapter is built), `UserName`, `ClientIp` from account config. |
| `ClientIp` | Must be a public IPv4 literal; private, loopback, link-local, CGNAT, documentation, benchmarking, multicast and reserved ranges are refused at build time with `credentials`. |
| Method | HTTP POST, `application/x-www-form-urlencoded`. The intro page describes GET; the create page recommends POST and the setHosts page recommends POST above 10 hosts. A body also keeps the key out of URLs. |
| Size | Body abandoned past 1 MiB, while streaming. |
| XML | `<!DOCTYPE`/`<!ENTITY` rejected before parsing; well-formedness validated (a truncated body is an error, not a partial tree); `fast-xml-parser` with entity processing off; the five predefined entities and character references decoded in one pass. |
| Quota | `quota.acquire` before every request: `interactive` for check, getTldList and getPricing, `critical` for everything else. |
| `beforeSubmit` | Awaited after quota and immediately before every mutating request. If it rejects, nothing is sent. |

Timeouts: check and getBalances 15 s; reads 30 s; setContacts,
setRegistrarLock and setHosts 60 s; create, renew and transfer.create 120 s
(the documented create/renew examples report an `ExecutionTime` of 29.9 s).

### Mutating methods and unknown outcomes

Mutating: `domains.create`, `domains.renew`, `domains.setContacts`,
`domains.setRegistrarLock`, `domains.dns.setHosts`, `domains.transfer.create`.

| Failure | Read | Mutating |
|---|---|---|
| Quota refused | `rate_limited`, not submitted | same, and `beforeSubmit` is not called |
| DNS failure, connection refused, TLS verification failure (`ConnectionRefused`, `ENOTFOUND`, `CERT_*`, …) | `provider_unavailable`, `submitted: false` | same — proven not sent |
| Timeout, reset, unclassified transport error, caller abort in flight | `provider_unavailable`, submitted | `unknown_outcome`, submitted |
| HTTP 429 | `rate_limited` (with `Retry-After`) | `unknown_outcome` — Namecheap documents no 429, so it proves nothing |
| HTTP 5xx / other non-2xx | `provider_unavailable` | `unknown_outcome` |
| Oversized, truncated, malformed, DTD-bearing body | `provider_unavailable` | `unknown_outcome` |
| `Status="OK"` but `Registered`/`Renew`/`Transfer`/`IsSuccess` not true, or `NonRealTimeDomain="true"` | — | `unknown_outcome` |
| `Status="ERROR"` | mapped by number (below) | mapped by number, with the provider-side rule below |

### Error numbers

Unknown numbers are `permanent` on a read. On a mutating command, a number
beginning 3 (upstream registry), 4 (Namecheap internal) or 5 (unhandled
exception), or any unrecognised number outside 1…/2…, is `unknown_outcome`
unless listed as a refusal (3019166, 4019166, 3013288, 4013288, 3016166,
3019510, 3011288, 4011103). The leading-digit grouping is inferred from the
tables, not documented, and is used only in that conservative direction.

| Code | Numbers |
|---|---|
| `credentials` | 1010101, 1010102, 1011102, 1010105, 1011105, 1030408, 1011150 (IP not whitelisted), 1017150, 1017105, 1017101, 1019103, 1016103, 1017103, 2011166, 2033409; 4011103 when its description names the user name |
| `rate_limited` | 1017411 |
| `validation` | 2005, 2010323–2010327, 2011168, 2011169, 2011170, 2011280, 2011298, 2011322, 2015167, 2015170, 2015182, 2015267, 2015278, 2015610, 2033407, 2033270, 2511623, 3013288, 4013288 |
| `unsupported` | 2030280, 2030166, 2030288, 3011288 |
| `conflict` | 2515610, 2515623 (price changed / premium mismatch) |
| `not_available` | 3019166, 4019166 |
| `not_found` | 2019166, 2016166, 3016166, 3019510, 4011103, 4019329 |
| `insufficient_funds` | 2528166 only when its description mentions funds or balance — **no insufficient-balance number is documented** |
| `permanent` | 1010104, 1017410, 2020166, 2528166, 4023166, 4023271, 4024167, 4026312, 4022337, 5026900, and any unlisted number on a read |
| `provider_unavailable` | 1050900, 2011323, 3011511, 3028166, 3031166, 3031510, 3031900, 3050900, 4019337, 4022288, 4022312, 4022323, 4023330, 5019169, 5050169, 5050900 |

Messages carry the command, the number and at most 200 characters of the
provider's description, with the API key, EPP code (plain and base64) and
every contact value of the call redacted. `safeMessage` never carries provider
text.

### Lifecycle and transfer mapping

`domains.getInfo` `Status` (case-insensitive): `OK` → `active`, `Locked` →
`locked_by_registry`, `Expired` → `expired`, anything else → `unknown`. The raw
status is always kept. `IsOwner="false"` (a domain shared from another user) →
`not_found`.

Transfer `StatusID` ([transfer statuses](https://www.namecheap.com/support/api/transfer-statuses/)):
5 → `completed`; 27, 45 → `cancelled`; 0, 1, 3, 9–14, 28, 29, 35, -1, -2, -5 →
`pending`; 2, 4, 8, 15–26, 30–34, 36, 37, 48–51, -4 → `failed`; -22 (documented
twice with opposite meanings), 6, 7 (charge problems), -202 and undocumented ids
→ `unknown`.

### Documentation ambiguities and the choices made

| Ambiguity | Choice |
|---|---|
| getPricing defines `Price` as "final price" and `YourPrice` as "the user's price" without saying which is charged | The larger is the cost, so `maxCost` can only refuse too much |
| getPricing: is `Price` per year or for the whole `Duration`? | Per year: the example quotes .biz at 8.55 for 1 year and 8.87 for 2. Cost = price × years |
| `AdditionalCost`/`YourAdditonalCost` are not in the documented example | Read as the itemized fee when present (larger of the two, per year) |
| check, create and renew state amounts without a currency | Premium prices from check are not converted; `register` refuses premium names (`unsupported`). `charged` uses the currency getPricing stated in the same call |
| No max-price parameter for regular names on create/renew/transfer.create | getPricing is read immediately before and compared with `maxCost`; a price change between that read and the order is not prevented — the quote/order layer owns that race |
| Dates carry no time zone (`GMTTimeDifference` is not a parseable offset, e.g. `--4:00`) | `MM/DD/YYYY` and `M/D/YYYY h:mm:ss AM` parsed explicitly as UTC; rolled-over dates rejected |
| getInfo's documented example has no `IsUsingOurDNS`, nameservers or lock details | `usesProviderDns` and `locked` are `null` when absent; `getLock` is authoritative for the lock |
| getHosts' response table omits `EmailType`, setHosts marks it required | Carried in `settings.EmailType` when returned; `replaceZone` refuses a zone without it |
| setHosts only affects Namecheap BasicDNS; FreeDNS/PremiumDNS cannot be managed by API (FAQ) | `replaceZone` refuses when `servedByProvider` is false; getHosts error 2030288 is `unsupported` |
| setHosts documents CAA `Flag`/`Tag` params not returned by getHosts; NS/ALIAS/MXE interact with delegation or `EmailType` | `supportedRecordTypes`: A, AAAA, CNAME, MX, TXT, URL, URL301, FRAME |
| setHosts marks `HostName[1..n]` required | An empty zone is refused |
| Same number, different meanings (2030166, 4011103) | Mapped to the safest reading; 4011103 refined by description |
| Field-name casing differs between pages (`Domainname`/`DomainName`) | Element and attribute lookups are case-insensitive |
| create/setContacts need extended attributes for some extensions; the contract has no field for them | Those extensions are refused before sending |
| IDN registration needs an `IdnCode` language tag the contract does not carry | Names with an `xn--` label are refused for registration |
| transfer.create: "Years … should be set to 1 year only"; EPP codes with special characters must be `base64:` | Years other than 1 refused; non-alphanumeric codes sent as `base64:<code>` |
| No API method releases an EPP code or approves a transfer out | `transfer_out` is `manual` |

setHosts has **no compare-and-swap**: an edit made in Namecheap's panel between
the apply planner's read and this write is overwritten. The planner's re-read
narrows that window; nothing closes it.

### Opt-in sandbox suite

`apps/api/test-sandbox/namecheap.sandbox.test.ts`, not part of `bun run test`
or CI:

```bash
cd apps/api
NAMECHEAP_SANDBOX_API_USER=… NAMECHEAP_SANDBOX_API_KEY=… \
NAMECHEAP_SANDBOX_USERNAME=… NAMECHEAP_SANDBOX_CLIENT_IP=<whitelisted egress IPv4> \
bun run test:sandbox:namecheap
```

Missing variables fail the run. It performs getTldList, check, getPricing,
getBalances and getList; `domains.create` of a random `tnp-sandbox-….com` runs
only with `NAMECHEAP_SANDBOX_ALLOW_CREATE=1` (sandbox registrations cannot be
deleted). The account is hard-wired to the sandbox environment. Typecheck it
with `bunx tsc --noEmit -p test-sandbox`. After a successful run, set
`validatedAt`/`validatedIn` in `capabilities.ts` for exactly the operations
exercised, and record the run here.
