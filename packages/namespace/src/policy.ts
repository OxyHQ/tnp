/**
 * Namespace policy — the rule that keeps TNP from changing what a public name
 * means.
 *
 * Normative spec: docs/architecture/naming.md.
 *
 * > A public DNS name resolves identically with TNP installed and without it.
 *
 * Everything here exists to make that mechanically true rather than a matter of
 * care. The classification in `classifyName` is a pure function of the name and
 * the TLD policy table: it never makes a network call, never consults a cache,
 * and never depends on whether a registration happens to exist.
 */

import { IANA_ROOT_ZONE_TLDS } from "./iana-root-zone.js";

/**
 * Which authority owns a name.
 *
 * There is no third state and no fallthrough between the two. A `tnp-native`
 * name that does not exist is NXDOMAIN from TNP — it is not then tried against
 * public DNS, because that would let a TNP registration outrank a public one by
 * simply not existing yet. A `public-dns` name is never looked up in the TNP
 * registry at all, which is what makes the rule above hold by construction.
 */
export type NamespaceType = "tnp-native" | "public-dns";

/**
 * Names reserved by the IETF for special use, which no registry may delegate.
 *
 * RFC 6761 §6, RFC 8375 (`home.arpa`), RFC 7686 (`.onion`), and the IANA
 * private-use TLD `.internal`. These do not appear in the root zone, so the
 * IANA snapshot alone would leave them registrable.
 */
export const SPECIAL_USE_TLDS: readonly string[] = [
  "example",
  "internal",
  "invalid",
  "local",
  "localhost",
  "onion",
  "test",
];

/**
 * Every label TNP refuses to serve, as a Set for O(1) membership.
 *
 * `arpa` is in the IANA snapshot, which covers `home.arpa` at the TLD level.
 */
const RESERVED_TLDS: ReadonlySet<string> = new Set([
  ...IANA_ROOT_ZONE_TLDS,
  ...SPECIAL_USE_TLDS,
]);

/** Number of reserved labels. Exported so callers can assert the set is populated. */
export const RESERVED_TLD_COUNT = RESERVED_TLDS.size;

/** The public root zone alone, without the special-use labels. */
const PUBLIC_ROOT_TLDS: ReadonlySet<string> = new Set(IANA_ROOT_ZONE_TLDS);

/** Normalize a label or name for comparison: lowercase, no trailing root dot. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Whether the public DNS root (or the IETF) already owns this label.
 *
 * TNP is never authoritative for a reserved TLD. Registration under one is
 * rejected at the registry, and the resolver forwards such names upstream
 * without consulting TNP at all.
 */
export function isReservedTld(tld: string): boolean {
  return RESERVED_TLDS.has(normalizeName(tld));
}

/**
 * Whether the public DNS root delegates this TLD.
 *
 * Narrower than {@link isReservedTld}: `.onion` and `.test` are reserved from
 * TNP but are not public domains anyone can buy. The services layer uses this
 * to refuse a native or special-use name presented as a public one.
 */
export function isPublicRootTld(tld: string): boolean {
  return PUBLIC_ROOT_TLDS.has(normalizeName(tld));
}

/** The last label of a name, normalized. Empty string when there is no TLD. */
export function tldOf(name: string): string {
  const normalized = normalizeName(name);
  const lastDot = normalized.lastIndexOf(".");
  return lastDot === -1 ? "" : normalized.slice(lastDot + 1);
}

/**
 * Classify a name as TNP-native or public DNS.
 *
 * `nativeTlds` is the client's cached TLD policy table. A name is TNP-native
 * only when its TLD is in that table AND is not reserved — the reserved check
 * runs second deliberately, so that a registry which somehow published a
 * reserved TLD still cannot make the client shadow a public name. The client
 * does not have to trust the server to have got its own policy right.
 *
 * A single-label name (no dot) is `public-dns`: it is a local hostname or a
 * search-domain lookup, and TNP has no business answering it.
 */
export function classifyName(
  name: string,
  nativeTlds: Iterable<string>,
): NamespaceType {
  const tld = tldOf(name);
  if (!tld) return "public-dns";
  if (isReservedTld(tld)) return "public-dns";

  for (const candidate of nativeTlds) {
    if (normalizeName(candidate) === tld) return "tnp-native";
  }

  return "public-dns";
}

/** Why a TLD may not be registered as a TNP-native TLD. */
export type TldRejection =
  | { reason: "reserved"; detail: string }
  | { reason: "syntax"; detail: string };

export type TldValidation = { ok: true; tld: string } | { ok: false } & TldRejection;

/** Longest legal DNS label (RFC 1035 §2.3.4). */
const MAX_LABEL_LENGTH = 63;

/** A label: alphanumeric with interior hyphens. Leading/trailing hyphens are invalid. */
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Validate a proposed TNP-native TLD.
 *
 * Enforced at the registry, not only in a form: the API is the authority, and a
 * reserved-TLD registration is the collision that `naming.md` §6 has to migrate
 * users out of afterwards.
 */
export function validateNativeTld(input: string): TldValidation {
  const tld = normalizeName(input);

  if (!tld) {
    return { ok: false, reason: "syntax", detail: "TLD is empty" };
  }
  if (tld.includes(".")) {
    return { ok: false, reason: "syntax", detail: "TLD must be a single label" };
  }
  if (tld.length > MAX_LABEL_LENGTH) {
    return {
      ok: false,
      reason: "syntax",
      detail: `TLD must be at most ${MAX_LABEL_LENGTH} characters`,
    };
  }
  if (!LABEL_RE.test(tld)) {
    return {
      ok: false,
      reason: "syntax",
      detail: "TLD may contain only letters, digits and interior hyphens",
    };
  }
  // Reserved by the IETF for future IDN use; a TNP TLD starting with `xn--`
  // would be read as Punycode by resolvers that never heard of TNP.
  if (tld.startsWith("xn--")) {
    return { ok: false, reason: "syntax", detail: "TLD may not use the IDN prefix xn--" };
  }
  if (isReservedTld(tld)) {
    return {
      ok: false,
      reason: "reserved",
      detail: `.${tld} is delegated by the public DNS root or reserved by the IETF. TNP does not serve names it does not own.`,
    };
  }

  return { ok: true, tld };
}

/** Whether a second-level label may be registered under a native TLD. */
export type LabelValidation = { ok: true; label: string } | { ok: false; detail: string };

/**
 * Validate the registrable label of a native name — the `example` in
 * `example.ox`.
 *
 * The rule the registry has always applied at registration, kept in one place
 * so an availability check can never call a name available that registration
 * would then refuse.
 */
export function validateNativeLabel(input: string): LabelValidation {
  const label = input.trim().toLowerCase();
  if (!label) return { ok: false, detail: "Name is empty" };
  if (label.length > MAX_LABEL_LENGTH || !LABEL_RE.test(label)) {
    return {
      ok: false,
      detail:
        "Domain name must be 1-63 characters, alphanumeric and hyphens only, cannot start or end with a hyphen",
    };
  }
  return { ok: true, label };
}

/** A full native name split into its registrable parts, or why it is not one. */
export type NativeDomainParse =
  | { ok: true; name: string; tld: string }
  | { ok: false; reason: "syntax" | "reserved"; detail: string };

/**
 * Parse `name.tld` as a registrable TNP-native name.
 *
 * Exactly two labels. A deeper name like `a.b.ox` is not something anyone
 * registers: `a` is a record under `b.ox`, created by its owner. It is refused
 * with a message saying so, rather than split at some dot and answered as if it
 * were a different question.
 *
 * The TLD is checked before the label, so a name under `.com` is reported as
 * reserved whatever its label looks like.
 */
export function parseNativeDomainName(input: string): NativeDomainParse {
  const normalized = normalizeName(input);
  const labels = normalized.split(".");

  if (labels.length < 2 || labels.some((label) => label === "")) {
    return { ok: false, reason: "syntax", detail: "Format must be name.tld (e.g. example.ox)" };
  }
  if (labels.length > 2) {
    return {
      ok: false,
      reason: "syntax",
      detail: `Only name.tld can be registered. ${normalized} is a subdomain: create it as a record under ${labels.slice(-2).join(".")}.`,
    };
  }

  const [label, tldInput] = labels;
  const tld = validateNativeTld(tldInput);
  if (!tld.ok) return { ok: false, reason: tld.reason, detail: tld.detail };

  const name = validateNativeLabel(label);
  if (!name.ok) return { ok: false, reason: "syntax", detail: name.detail };

  return { ok: true, name: name.label, tld: tld.tld };
}
