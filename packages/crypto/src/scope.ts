/**
 * Grant scopes: what a key speaks for, and when one scope is inside another.
 *
 * Normative spec: docs/architecture/security.md §1 ("Scope").
 *
 * A scope is always a DNS-style name in canonical form — a TNP domain for
 * domain-bound purposes, the relay's hostname for RELAY. Using one syntax for
 * both is what lets narrowing be a single rule. The previous code treated
 * scope as an opaque string and only compared the leaf's, so an intermediate
 * scoped to `a.ox` could authorize a key for `b.ox` and the chain still
 * verified.
 *
 * Canonical form: lowercase ASCII LDH labels (`[a-z0-9]`, inner `-`), each 1–63
 * bytes, joined by single dots, no leading or trailing dot, at most 253 bytes.
 * Uppercase is REJECTED rather than folded: a signature covers exact bytes, so
 * a verifier that folds case accepts a spelling the signer never signed.
 * Internationalised names appear in their A-label (`xn--`) form.
 */

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MAX_NAME_LENGTH = 253;

/** Whether `value` is a scope in canonical form. */
export function isValidScope(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_NAME_LENGTH) return false;
  return value.split('.').every((label) => LABEL.test(label));
}

/**
 * Whether `inner` is `outer` or a subdomain of it, at a label boundary.
 *
 * `scopeCovers('example.ox', 'www.example.ox')` is true;
 * `scopeCovers('example.ox', 'badexample.ox')` is false — a bare `endsWith`
 * would say true, which is exactly the bug a label boundary exists to stop.
 *
 * Both arguments must already be valid scopes; an invalid one never covers or
 * is covered.
 */
export function scopeCovers(outer: string, inner: string): boolean {
  if (!isValidScope(outer) || !isValidScope(inner)) return false;
  return inner === outer || inner.endsWith(`.${outer}`);
}
