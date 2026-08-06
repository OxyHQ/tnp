/**
 * Host header handling for the parking page.
 *
 * `req.hostname` is derived from the `Host` header and Express does not
 * validate it — verified against Express 5.2.1, `Host: a.ox<script>…</script>`
 * arrives intact. The parking-page middleware previously interpolated that
 * value straight into the response body, so both a validator and an escaper
 * live here, with tests, rather than being inlined at the call site.
 */

/** Longest legal DNS name, and longest legal label (RFC 1035 §2.3.4). */
const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

/** A label: alphanumeric, with interior hyphens. Leading/trailing hyphens are invalid. */
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

/**
 * Whether `host` is a plausible DNS hostname.
 *
 * Deliberately stricter than "does not contain HTML": a value that is not a
 * hostname has no business reaching a registry lookup either, so it is rejected
 * before the database query rather than sanitized on the way out.
 *
 * Underscores are rejected. They appear in service labels like `_dmarc`, but
 * nothing addressable by a browser is served under one, and the parking page is
 * a browser surface.
 */
export function isValidHostname(host: string): boolean {
  if (!host || host.length > MAX_HOSTNAME_LENGTH) return false;

  // A trailing dot is legal in a fully-qualified name but never appears in a
  // Host header; treating it as valid would create two spellings of one name.
  const labels = host.split(".");
  if (labels.length < 2) return false;

  return labels.every(
    (label) => label.length > 0 && label.length <= MAX_LABEL_LENGTH && LABEL_RE.test(label),
  );
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape a value for interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}
