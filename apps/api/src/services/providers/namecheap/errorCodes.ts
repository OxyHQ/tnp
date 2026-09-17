/**
 * Namecheap error numbers → the normalized taxonomy.
 *
 * Source: the global list (https://www.namecheap.com/support/api/global-parameters/),
 * the full list (https://www.namecheap.com/support/api/error-codes/) and each
 * method page's table, read 2026-09-17. The mapping is explicit: a number not
 * in this table is not guessed from its description.
 *
 * What the documentation does NOT give, and how that is handled:
 *
 * - **No "insufficient balance" number.** No method page lists one. `create`,
 *   `renew` and `transfer.create` document `2528166 Order creation failed`,
 *   which is where a refused charge would surface. That number stays
 *   `permanent`; it is refined to `insufficient_funds` only when the
 *   provider's own description mentions funds or balance. Both codes are
 *   refusals (`provesNothingApplied`), so a wrong refinement changes the
 *   message an operator reads, never whether a purchase is retried.
 * - **The same number means different things on different pages.** `2030166`
 *   is "Domain is invalid" on getInfo and "Edit permission for domain is not
 *   supported" elsewhere; `4011103` is "DomainName not Available", "UserName
 *   not Available" or "Access denied" on getInfo. Each is mapped to the reading
 *   that is safest across its pages, and `4011103` is disambiguated by its
 *   description where the page itself says the description varies.
 * - **Provider-side failures after a write.** Numbers beginning 3 (upstream
 *   registry/Enom), 4 (Namecheap internal) and 5 (unhandled exception) on a
 *   MUTATING command include "Error while adding domain", "Unknown error while
 *   adding a domain to your account" and "Error in refunding funds" — all
 *   consistent with the charge or the change having happened. That leading-
 *   digit grouping is an inference from the tables, not a documented scheme,
 *   so it is used in one direction only: on a mutating command such a number
 *   is `unknown_outcome` unless it is listed in `MUTATION_REFUSALS` as a
 *   refusal that proves nothing was applied.
 */

import type { ProviderErrorCode } from "../errors.js";

export const ERROR_NUMBERS: Readonly<Record<string, ProviderErrorCode>> = {
  // --- Global authentication errors (every command) ---
  "1010101": "credentials", // Parameter APIUser is missing
  "1010102": "credentials", // Parameter APIKey is missing
  "1011102": "credentials",
  "1010104": "permanent", // Parameter Command is missing — a bug in this adapter, not configuration
  "1010105": "credentials", // Parameter ClientIP is missing
  "1011105": "credentials",
  "1030408": "credentials", // Unsupported authentication type
  "1050900": "provider_unavailable", // Unknown error when validating APIUser
  "1011150": "credentials", // Parameter RequestIP is invalid — the egress IP is not whitelisted
  "1017150": "credentials", // Parameter RequestIP is disabled or locked
  "1017105": "credentials", // Parameter ClientIP is disabled or locked
  "1017101": "credentials", // Parameter ApiUser is disabled or locked
  "1017410": "permanent", // Too many declined payments — account state, needs an operator
  "1017411": "rate_limited", // Too many login attempts
  "1019103": "credentials", // Parameter UserName is not available
  "1016103": "credentials", // Parameter UserName is unauthorized
  "1017103": "credentials", // Parameter UserName is disabled or locked
  "2011166": "credentials", // UserName is invalid (getTldList)
  "2033409": "credentials", // Order chargeable for the Username is not found (auth phase)

  // --- Validation of what TNP sent ---
  "2005": "validation", // Country name is not valid
  "2010323": "validation", // Required billing contact fields
  "2010324": "validation", // Registrant contacts missing
  "2010325": "validation", // Tech contacts missing
  "2010326": "validation", // Admin contacts missing
  "2010327": "validation", // AuxBilling contacts missing
  "2011168": "validation", // Nameservers are not valid
  "2011169": "validation", // Only 50 domains are allowed in a single check command
  "2011170": "validation", // PromotionCode is invalid
  "2011280": "validation", // TLD is invalid
  "2011298": "validation", // ProductType is invalid
  "2011322": "validation", // Extended Attributes are not valid
  "2011323": "provider_unavailable", // Error retrieving domain Contacts from Enom
  "2015167": "validation", // Years invalid / premium renewable for 1 year only
  "2015170": "validation", // Promotion code not allowed for premium domains
  "2015182": "validation", // Contact phone is invalid
  "2015267": "validation", // EUAgreeDelete option should not be set to NO
  "2015278": "validation", // Invalid data specified for LockAction
  "2015610": "validation", // Premium prices cannot be zero for premium domains
  "2033407": "validation", // Cannot enable privacy when AddWhoisguard is NO
  "2033270": "validation",
  "2511623": "validation", // Domain name is not premium
  "3013288": "validation", // Too many records (setHosts)
  "4013288": "validation",

  // --- Not offered for this name or account ---
  "2030280": "unsupported", // TLD is not supported in API
  "2030166": "unsupported", // Edit permission for domain is not supported / Domain is invalid
  "2030288": "unsupported", // Domain is not using proper DNS servers (dns.getHosts)
  "3011288": "unsupported", // Invalid name server specified (dns.getHosts)

  // --- Price moved between quote and order ---
  "2515610": "conflict", // Prices do not match / premium price is incorrect
  "2515623": "conflict", // Premium while considered regular, or the reverse

  // --- Not available / not held ---
  "3019166": "not_available", // Domain not available
  "4019166": "not_available",
  "2019166": "not_found", // Domain not found
  "2016166": "not_found", // Domain is not associated with your account
  "3016166": "not_found", // Domain is not associated with Enom
  "3019510": "not_found", // Expired / transferred out / not associated with your account
  "4011103": "not_found", // getInfo: DomainName not Available | Access denied (see refineByDescription)
  "4019329": "not_found", // TransferStatus not available
  "2020166": "permanent", // Domain has expired. Please reactivate your domain.

  // --- Order failures ---
  "2528166": "permanent", // Order creation failed (see refineByDescription)
  "4023271": "permanent", // Error while adding a free PositiveSSL
  "4023166": "permanent", // Error while adding a domain / during renewal
  "4024167": "permanent", // Failed to update years for your domain
  "4026312": "permanent", // Error in refunding funds
  "4022337": "permanent", // Error in refunding funds (renew)
  "5026900": "permanent", // Unknown exceptions error while refunding funds

  // --- Provider-side failures ---
  "3011511": "provider_unavailable", // Unknown response from the provider (check)
  "3028166": "provider_unavailable", // Error from Enom
  "3031166": "provider_unavailable", // Error while getting information from the provider
  "3031510": "provider_unavailable", // Error from Enom when error count != 0
  "3031900": "provider_unavailable", // Unknown response from the provider
  "3050900": "provider_unavailable", // Unknown response from provider
  "4019337": "provider_unavailable", // Unable to retrieve domain contacts
  "4022288": "provider_unavailable", // Unable to get nameserver list
  "4022312": "provider_unavailable", // Balance information is not available
  "4022323": "provider_unavailable", // Error retrieving domain Contacts
  "4023330": "provider_unavailable", // Unable to get DNS hosts from list
  "5019169": "provider_unavailable", // Unknown exceptions (getInfo)
  "5050169": "provider_unavailable", // Unknown exceptions (getList)
  "5050900": "provider_unavailable", // Unknown / unhandled exceptions
};

/**
 * Numbers beginning 3/4/5 that, on a mutating command, still prove the
 * provider refused the request before changing anything.
 */
export const MUTATION_REFUSALS: ReadonlySet<string> = new Set([
  "3019166", // Domain not available
  "4019166",
  "3013288", // Too many records — the set was rejected, not partially written
  "4013288",
  "3016166", // Domain is not associated with Enom
  "3019510", // Expired / transferred out / not associated with your account
  "3011288", // Invalid name server specified
  "4011103", // DomainName not Available / Access denied
]);

export interface ClassifiedError {
  readonly code: ProviderErrorCode;
  readonly number: string;
}

function refineByDescription(number: string, code: ProviderErrorCode, description: string): ProviderErrorCode {
  if (number === "2528166" && /insufficient|balance|funds/i.test(description)) return "insufficient_funds";
  // getInfo documents three messages under 4011103; only "UserName not
  // Available" is a configuration problem rather than "this account does not
  // hold that name".
  if (number === "4011103" && /user\s*name/i.test(description)) return "credentials";
  return code;
}

/** Classify one `<Error Number="…">` for a command that is or is not mutating. */
export function classifyErrorNumber(number: string, description: string, mutating: boolean): ClassifiedError {
  const known = ERROR_NUMBERS[number];
  const base = known === undefined ? "permanent" : refineByDescription(number, known, description);
  if (mutating) {
    const providerSide = /^[345]/.test(number) && !MUTATION_REFUSALS.has(number);
    // A number this table has never seen, outside the auth (1…) and request
    // validation (2…) ranges, is not evidence that nothing was applied.
    const unrecognised = known === undefined && !/^[12]/.test(number);
    if (providerSide || unrecognised) return { code: "unknown_outcome", number };
  }
  return { code: base, number };
}
