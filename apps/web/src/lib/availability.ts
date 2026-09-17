import type { NativeAvailabilityReason } from "@tnp/shared-types";

/**
 * A native availability answer as the web holds it.
 *
 * `reason` is optional because an API image older than this build sends only
 * `{ domain, available }`; the web then says "taken" for every refusal, as it
 * always did.
 */
export interface AvailabilityResult {
  domain: string;
  available: boolean;
  reason?: NativeAvailabilityReason;
}

/**
 * The `common:availability.*` message for an answer.
 *
 * `invalid` is split by the one case people actually type — a subdomain — so
 * the message can say what to do instead (add a record) in the page's
 * language, rather than showing the API's English `detail`.
 */
export function availabilityMessageKey(result: AvailabilityResult): string {
  if (result.available) return "common:availability.available";
  switch (result.reason) {
    case "reserved":
      return "common:availability.reserved";
    case "tld_not_available":
      return "common:availability.tldNotAvailable";
    case "invalid":
      return result.domain.replace(/\.$/, "").split(".").length > 2
        ? "common:availability.subdomain"
        : "common:availability.invalid";
    default:
      return "common:availability.taken";
  }
}

/** The registrable parent of a subdomain, for the "add a record under …" message. */
export function parentDomain(domain: string): string {
  return domain.replace(/\.$/, "").split(".").slice(-2).join(".");
}
