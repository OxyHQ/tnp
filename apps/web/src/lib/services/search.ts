import { MAX_AVAILABILITY_NAMES } from "@tnp/shared-types";

export interface SearchInput {
  /** Distinct names to send, in the order typed, at most MAX_AVAILABILITY_NAMES. */
  names: string[];
  /** How many distinct names were dropped by the limit. */
  dropped: number;
}

/**
 * Splits what the user typed into names: separated by commas, whitespace or
 * newlines, trimmed, lower-cased for de-duplication, capped at the API's
 * limit. Validation of each name stays on the server, which answers `invalid`
 * per name instead of failing the whole search.
 */
export function parseSearchInput(raw: string): SearchInput {
  const seen = new Set<string>();
  const names: string[] = [];
  let dropped = 0;
  for (const token of raw.split(/[\s,]+/)) {
    const name = token.trim().toLowerCase();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (names.length < MAX_AVAILABILITY_NAMES) names.push(name);
    else dropped++;
  }
  return { names, dropped };
}

/** Query string for `GET /services/domains/availability`. */
export function availabilityPath(names: string[]): string {
  return `/services/domains/availability?name=${names.map(encodeURIComponent).join(",")}`;
}

/** An `Idempotency-Key`: 8–128 characters, generated once per confirmed intent. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
