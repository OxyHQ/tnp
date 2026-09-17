import type {
  OperationStatusDto,
  PublicAvailabilityStatus,
  PublicDomainLifecycleDto,
  ServicesStatus,
} from "@tnp/shared-types";

/**
 * Status → presentation for the services area. Pure, so the one rule that
 * matters most is testable: an answer that is not a confirmed "available"
 * never renders in the tone of one, and an outcome that is still being
 * reconciled never renders as a failure.
 *
 * `labelKey` is a key in the `services` i18n namespace.
 */

export type Tone = "success" | "neutral" | "info" | "warning" | "error";

export interface StatusPresentation {
  labelKey: string;
  tone: Tone;
}

/** Utility classes per tone; every colour is a Bloom token. */
export const TONE_CLASSES: Readonly<Record<Tone, string>> = {
  success: "border-success-text/30 bg-success-subtle text-success-text",
  neutral: "border-border bg-accent text-muted-foreground",
  info: "border-info-text/30 bg-info-subtle text-info-text",
  warning: "border-warning-text/30 bg-warning-subtle text-warning-text",
  error: "border-error-text/30 bg-error-subtle text-error-text",
};

const AVAILABILITY: Readonly<Record<PublicAvailabilityStatus, StatusPresentation>> = {
  available: { labelKey: "availability.available", tone: "success" },
  unavailable: { labelKey: "availability.unavailable", tone: "neutral" },
  // Not a "no" and certainly not a "yes": the provider could not say.
  unknown: { labelKey: "availability.unknown", tone: "warning" },
  unsupported: { labelKey: "availability.unsupported", tone: "warning" },
  invalid: { labelKey: "availability.invalid", tone: "error" },
};

export function availabilityPresentation(status: PublicAvailabilityStatus): StatusPresentation {
  return AVAILABILITY[status] ?? { labelKey: "availability.unknown", tone: "warning" };
}

/** Only a confirmed `available` may offer a quote. */
export function canQuote(status: PublicAvailabilityStatus): boolean {
  return status === "available";
}

const LIFECYCLE: Readonly<Record<PublicDomainLifecycleDto, StatusPresentation>> = {
  pending: { labelKey: "lifecycle.pending", tone: "info" },
  active: { labelKey: "lifecycle.active", tone: "success" },
  expired: { labelKey: "lifecycle.expired", tone: "error" },
  redemption: { labelKey: "lifecycle.redemption", tone: "warning" },
  transferring_in: { labelKey: "lifecycle.transferring_in", tone: "info" },
  transferred_out: { labelKey: "lifecycle.transferred_out", tone: "neutral" },
  locked_by_registry: { labelKey: "lifecycle.locked_by_registry", tone: "warning" },
  failed: { labelKey: "lifecycle.failed", tone: "error" },
  unknown: { labelKey: "lifecycle.unknown", tone: "warning" },
};

export function lifecyclePresentation(lifecycle: PublicDomainLifecycleDto): StatusPresentation {
  return LIFECYCLE[lifecycle] ?? { labelKey: "lifecycle.unknown", tone: "warning" };
}

const OPERATION: Readonly<Record<OperationStatusDto, StatusPresentation>> = {
  queued: { labelKey: "operation.queued", tone: "info" },
  running: { labelKey: "operation.running", tone: "info" },
  succeeded: { labelKey: "operation.succeeded", tone: "success" },
  failed: { labelKey: "operation.failed", tone: "error" },
  // The outcome is being reconciled against the provider: not a failure.
  unknown: { labelKey: "operation.unknown", tone: "warning" },
  // A person will look at it: not a failure either.
  manual_review: { labelKey: "operation.manual_review", tone: "warning" },
};

export function operationPresentation(status: OperationStatusDto): StatusPresentation {
  return OPERATION[status] ?? { labelKey: "operation.unknown", tone: "warning" };
}

/**
 * Whether polling can stop. Mirrors the API's terminal set: `unknown` is not
 * terminal, because reconciliation keeps working on it.
 */
export function isTerminalOperation(status: OperationStatusDto): boolean {
  return status === "succeeded" || status === "failed" || status === "manual_review";
}

type ZoneState = "unmanaged" | "in_sync" | "pending" | "conflict" | "unknown";

const ZONE: Readonly<Record<ZoneState, StatusPresentation>> = {
  unmanaged: { labelKey: "zone.state.unmanaged", tone: "neutral" },
  in_sync: { labelKey: "zone.state.in_sync", tone: "success" },
  pending: { labelKey: "zone.state.pending", tone: "info" },
  conflict: { labelKey: "zone.state.conflict", tone: "warning" },
  unknown: { labelKey: "zone.state.unknown", tone: "warning" },
};

export function zoneStatePresentation(state: ZoneState): StatusPresentation {
  return ZONE[state] ?? { labelKey: "zone.state.unknown", tone: "warning" };
}

export type ServicesAvailability =
  | { kind: "loading" }
  /** `/services` is not deployed (404) or the catalog flag is off. */
  | { kind: "not_available"; reason: "not_deployed" | "catalog_off" | "unreachable" }
  | { kind: "available"; status: ServicesStatus };

/**
 * What the services area may show. An absent route and a disabled catalog are
 * the same thing to a visitor — services are not available yet — and neither
 * is an error. An unreachable API is reported as not available too, with the
 * reason kept so the page can offer to check again.
 */
export function servicesAvailability(result: { status: ServicesStatus } | { httpStatus: number | null }): ServicesAvailability {
  if ("status" in result) {
    return result.status.catalog
      ? { kind: "available", status: result.status }
      : { kind: "not_available", reason: "catalog_off" };
  }
  return { kind: "not_available", reason: result.httpStatus === 404 ? "not_deployed" : "unreachable" };
}

/** The explanation key for a non-purchasable status. */
export function purchaseBlockedKey(reason: ServicesStatus["purchaseBlockedReason"]): string {
  return reason === "sales_disabled" ? "purchase.blocked.sales_disabled" : "purchase.blocked.payments_not_configured";
}
