# Provider admission record: Namecheap

**Status: under evaluation. Not approved for sales.** Governed by
[`../architecture/services.md`](../architecture/services.md) §11. Every fact
below is from Namecheap's public documentation as read on 2026-09-17 and must
be re-validated against TNP's actual account and environment before it is
relied on. "Documented" is not "validated".

## Scope

| Product family | Adapter | Decision |
|---|---|---|
| Domain registration and management (API) | `namecheap-domains` | Evaluating — first registrar adapter |
| DNS hosting for domains registered there (`domains.dns.*`) | `namecheap-domains` | Evaluating, with the `setHosts` rules in `services.md` §6 |
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
| Response format | XML; `ApiResponse/@Status` is `OK` or `ERROR`, errors in `Errors/Error` with a `Number` | Fixtures only |
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
