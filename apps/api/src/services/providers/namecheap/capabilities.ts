/**
 * What the Namecheap adapter declares it can do (services.md §3).
 *
 * Nothing here has been exercised against a live Namecheap environment:
 * every `validatedAt`/`validatedIn` is `null` until the opt-in sandbox suite
 * (`apps/api/test-sandbox/`) runs with real credentials, and the dates are
 * set then — by hand, in the same change that records the run in
 * `docs/providers/namecheap.md`.
 */

import type { CapabilityDeclaration, CapabilityMatrix, DnsOperation, RegistrarOperation } from "../contracts.js";

const fixturesOnly = { validatedAt: null, validatedIn: null } as const;

function automated(conditions?: string): CapabilityDeclaration {
  return { support: "automated", ...(conditions ? { conditions } : {}), ...fixturesOnly };
}

export const NAMECHEAP_REGISTRAR_CAPABILITIES: CapabilityMatrix<RegistrarOperation> = {
  suffixes: automated(
    "domains.getTldList; IsApiRegisterable/IsApiRenewable/IsApiTransferable are per extension. Namecheap asks that the list be cached.",
  ),
  availability: automated(
    "domains.check, at most 50 names per call. Premium names are flagged; their prices are not converted because the response states no currency. Sandbox availability says nothing about production.",
  ),
  pricing: automated(
    "users.getPricing per extension and action. Price is per year; the larger of Price and YourPrice is used.",
  ),
  register: automated(
    "domains.create. Refused before sending: premium names, IDN names (need IdnCode), and extensions requiring extended attributes (.us, .eu, .ca, .co.uk, .org.uk, .me.uk, .nu, .asia, .com.au, .net.au, .org.au, .es, .nom.es, .com.es, .org.es, .de, .fr). maxCost is checked against getPricing immediately before; no max-price parameter exists for regular names.",
  ),
  renew: automated(
    "domains.renew. Premium renewals (need PremiumPrice) are refused by Namecheap (2515623). An expired domain needs domains.reactivate, which is not implemented (2020166).",
  ),
  info: automated("domains.getInfo. A domain shared from another Namecheap user (IsOwner=false) is not_found."),
  list: automated("domains.getList, PageSize 10–100."),
  "contacts.read": automated("domains.getContacts; the privacy-service contacts are ignored."),
  "contacts.update": automated(
    "domains.setContacts. Refused for extensions requiring extended attributes; IsDisableModContact extensions are refused by Namecheap.",
  ),
  "lock.read": automated("domains.getRegistrarLock."),
  "lock.update": automated("domains.setRegistrarLock."),
  transfer_in: automated(
    "domains.transfer.create: only .biz, .ca, .cc, .co, .com, .com.es, .com.pe, .es, .in, .info, .me, .mobi, .net, .net.pe, .nom.es, .org, .org.es, .org.pe, .pe, .tv, .us, for exactly 1 year. Premium names cannot be transferred (status 50).",
  ),
  transfer_status: automated("domains.transfer.getStatus; StatusID -22, 6, 7 and undocumented ids map to unknown."),
  transfer_out: {
    support: "manual",
    conditions:
      "No documented API method releases an EPP code or approves an outbound transfer. Assisted, audited workflow through Namecheap support until one is verified.",
    ...fixturesOnly,
  },
  balance: automated("users.getBalances AvailableBalance. Never shown to customers."),
};

export const NAMECHEAP_DNS_CAPABILITIES: CapabilityMatrix<DnsOperation> = {
  "zone.read": automated(
    "domains.dns.getHosts. Only for domains registered in this account; FreeDNS and PremiumDNS zones cannot be managed through the API (API FAQ).",
  ),
  "zone.replace": automated(
    "domains.dns.setHosts replaces the whole host set: records omitted are deleted. Only while the domain uses Namecheap BasicDNS; no compare-and-swap exists, so an edit in Namecheap's panel between read and write is lost. TTL 60–60000. Record types limited to the adapter's supportedRecordTypes.",
  ),
};
