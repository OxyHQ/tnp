/**
 * The normalized provider error taxonomy (docs/architecture/services.md §3).
 *
 * Every adapter translates its provider's failures into exactly these codes, so
 * the operation engine decides retry, reconciliation and user messaging once,
 * not once per provider. `safeMessage` is the only text that may reach a user:
 * no XML, no secrets, no other customer's data.
 */

export type ProviderErrorCode =
  | "validation"
  | "not_available"
  | "unsupported"
  | "credentials"
  | "rate_limited"
  | "insufficient_funds"
  | "conflict"
  | "not_found"
  | "permanent"
  | "provider_unavailable"
  | "unknown_outcome";

export interface ProviderErrorOptions {
  /** Text safe to show a customer. Defaults to a generic message for the code. */
  safeMessage?: string;
  /** The provider's own error number or code, for operators. Never shown to users. */
  providerCode?: string;
  /**
   * Whether the request may have reached the provider. A transport failure
   * before any byte was written is `false`; a timeout waiting for the response
   * is `true`. For a mutating call, `true` means the outcome is unknown.
   */
  submitted?: boolean;
  /** For `rate_limited`: how long to wait, when the provider or limiter knows. */
  retryAfterMs?: number;
  cause?: unknown;
}

const DEFAULT_MESSAGES: Readonly<Record<ProviderErrorCode, string>> = {
  validation: "The request was rejected as invalid.",
  not_available: "That is not available.",
  unsupported: "This provider does not support that operation.",
  credentials: "The provider account is not configured correctly.",
  rate_limited: "The provider is temporarily limiting requests. Try again shortly.",
  insufficient_funds: "The operation cannot be completed right now.",
  conflict: "Something changed at the provider. Review before trying again.",
  not_found: "The provider has no record of that resource.",
  permanent: "The provider refused the operation.",
  provider_unavailable: "The provider is temporarily unavailable.",
  unknown_outcome: "The provider did not confirm the result. It is being checked.",
};

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly safeMessage: string;
  readonly providerCode: string | undefined;
  readonly submitted: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.code = code;
    this.safeMessage = options.safeMessage ?? DEFAULT_MESSAGES[code];
    this.providerCode = options.providerCode;
    this.submitted = options.submitted ?? false;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isProviderError(err: unknown): err is ProviderError {
  return err instanceof ProviderError;
}

/**
 * Whether an error proves the provider applied nothing, so a mutating call may
 * be attempted again without first reconciling.
 *
 * Only failures that happened before submission, or that the provider
 * explicitly reports as a refusal, qualify. Anything else after submission is
 * an unknown outcome.
 */
export function provesNothingApplied(err: ProviderError): boolean {
  if (err.code === "unknown_outcome") return false;
  if (!err.submitted) return true;
  // The provider answered, and its answer was a refusal of the request.
  return (
    err.code === "validation" ||
    err.code === "not_available" ||
    err.code === "unsupported" ||
    err.code === "credentials" ||
    err.code === "insufficient_funds" ||
    err.code === "rate_limited" ||
    err.code === "conflict" ||
    err.code === "permanent"
  );
}
