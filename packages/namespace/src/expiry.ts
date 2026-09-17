/**
 * Native name expiry — the lifecycle of a registration under a TNP-native TLD.
 *
 * Normative spec: docs/architecture/naming.md §4. This is namespace policy, not
 * billing: a native name is free, and renewing it proves only that its owner is
 * still around. Public domains bought through the services layer have their
 * own lifecycle, driven by the registrar's dates (services.md §4), and never go
 * through this module.
 *
 * Pure functions of a stored `expiresAt` and a caller-supplied clock, so the
 * API, the resolver path and the web all classify a name the same way and the
 * tests can pin every boundary without waiting for one.
 */

/**
 * Where a registration is in its lifecycle.
 *
 * - `active`    — not yet inside the renewal window.
 * - `renewable` — within {@link NATIVE_RENEWAL_WINDOW_DAYS} of expiry.
 * - `grace`     — expired less than {@link NATIVE_GRACE_DAYS} ago. Still resolves.
 * - `expired`   — past the grace period. Held for its owner, never re-issued
 *                 to someone else by this policy.
 */
export type NativeExpiryState = "active" | "renewable" | "grace" | "expired";

/** How long before expiry an owner may renew. */
export const NATIVE_RENEWAL_WINDOW_DAYS = 90;

/** How long after expiry a name keeps resolving while its owner renews. */
export const NATIVE_GRACE_DAYS = 30;

/** Length of one native registration term, in calendar years. */
export const NATIVE_TERM_YEARS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Classify a registration.
 *
 * `expiresAt === null` is a registration with no expiry, which is `active`
 * forever: rows created before expiry existed must not start expiring because
 * this function was written.
 *
 * Boundaries are closed on the side that favours the owner: exactly
 * {@link NATIVE_RENEWAL_WINDOW_DAYS} before expiry is already renewable, and a
 * name is `grace` from the instant it expires until exactly
 * {@link NATIVE_GRACE_DAYS} later, inclusive.
 */
export function nativeExpiryState(expiresAt: Date | null, now: Date): NativeExpiryState {
  if (expiresAt === null) return "active";

  const remaining = expiresAt.getTime() - now.getTime();
  if (remaining > NATIVE_RENEWAL_WINDOW_DAYS * DAY_MS) return "active";
  if (remaining > 0) return "renewable";
  if (-remaining <= NATIVE_GRACE_DAYS * DAY_MS) return "grace";
  return "expired";
}

/**
 * Whether the owner may renew a registration in this state.
 *
 * An `expired` name is renewable by its owner: the policy holds it rather than
 * releasing it, and a hold nobody can leave is a deletion by another name. The
 * registry is what guarantees the name is still theirs — the row still exists
 * and still names them.
 */
export function isNativeRenewalAllowed(state: NativeExpiryState): boolean {
  return state !== "active";
}

/**
 * Whether a name in this state is served — resolved, overlaid, parked as
 * registered — when expiry enforcement is on.
 *
 * `grace` is served deliberately: it is the owner's window to notice.
 */
export function isNativeNameServed(state: NativeExpiryState): boolean {
  return state !== "expired";
}

/**
 * The expiry a renewal sets: one term after the later of the current expiry
 * and now.
 *
 * Renewing early never loses the time already paid for, and renewing a lapsed
 * name starts its term from today rather than back-dating it into the past.
 *
 * Calendar arithmetic in UTC, so a term is a year on the calendar rather than
 * 365 days, and the result does not depend on the server's time zone.
 */
export function nextNativeExpiry(expiresAt: Date | null, now: Date): Date {
  const base = expiresAt === null || expiresAt.getTime() < now.getTime() ? now : expiresAt;
  const next = new Date(base.getTime());
  next.setUTCFullYear(next.getUTCFullYear() + NATIVE_TERM_YEARS);
  return next;
}
