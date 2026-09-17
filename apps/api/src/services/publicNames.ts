/**
 * Public DNS name normalization for the services layer.
 *
 * Deliberately separate from `@tnp/namespace`'s native classifier
 * (docs/architecture/services.md §4): a public name and a TNP-native name are
 * different resources, and a shared parser is how `nombre.co.uk` would end up
 * read as the second-level name `co` under `.uk`.
 *
 * What this module does NOT decide is whether a name can be bought. The
 * registrable suffix is the longest suffix the provider account actually
 * offers, passed in by the caller; a public-suffix list entry alone proves
 * nothing about purchasability.
 */

import { domainToASCII, domainToUnicode } from "node:url";
import { isPublicRootTld } from "@tnp/namespace";

/** A public name, split at the suffix a provider offers. */
export interface PublicDomainName {
  /** Canonical ASCII (Punycode) form, lower case, no trailing dot. */
  readonly ascii: string;
  /** Unicode form for display. Never used as a key. */
  readonly unicode: string;
  /** The label registered under the suffix: `example` in `example.co.uk`. */
  readonly sld: string;
  /** The offered suffix, ASCII: `co.uk`. */
  readonly suffix: string;
}

export type NormalizedName =
  | { readonly ok: true; readonly ascii: string; readonly unicode: string; readonly labels: readonly string[] }
  | { readonly ok: false; readonly reason: "syntax" | "not_public"; readonly detail: string };

const MAX_NAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const ASCII_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Normalize user input to a canonical public DNS name.
 *
 * Unicode is converted with UTS #46 (`domainToASCII`), case folded, and the
 * root dot removed. The result must have at least two labels and end in a TLD
 * the public root delegates — a TNP-native TLD such as `.ox` is `not_public`,
 * never silently accepted as a public domain.
 */
export function normalizePublicName(input: string): NormalizedName {
  const trimmed = input.trim().replace(/\.$/, "");
  if (!trimmed) return { ok: false, reason: "syntax", detail: "name is empty" };
  if (/[\s/@:]/.test(trimmed)) {
    return { ok: false, reason: "syntax", detail: "name may not contain spaces, slashes, @ or :" };
  }

  const ascii = domainToASCII(trimmed).toLowerCase();
  if (!ascii) return { ok: false, reason: "syntax", detail: "name is not a valid domain name" };
  if (ascii.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: "syntax", detail: `name must be at most ${MAX_NAME_LENGTH} characters` };
  }

  const labels = ascii.split(".");
  if (labels.length < 2) {
    return { ok: false, reason: "syntax", detail: "name must include a top-level domain" };
  }
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH || !ASCII_LABEL_RE.test(label)) {
      return { ok: false, reason: "syntax", detail: `invalid label ${JSON.stringify(label)}` };
    }
  }

  const tld = labels[labels.length - 1];
  if (!isPublicRootTld(tld)) {
    return {
      ok: false,
      reason: "not_public",
      detail: `.${tld} is not delegated by the public DNS root`,
    };
  }

  return { ok: true, ascii, unicode: domainToUnicode(ascii), labels };
}

export type SplitResult =
  | { readonly ok: true; readonly name: PublicDomainName }
  | { readonly ok: false; readonly reason: "syntax" | "not_public" | "suffix_not_offered" | "not_registrable"; readonly detail: string };

/**
 * Split a name at the longest suffix in `offeredSuffixes`.
 *
 * Exactly one label may precede the suffix: `www.example.com` is a host under
 * a registrable name, not a registrable name, and is refused rather than
 * truncated.
 */
export function splitRegistrableName(
  input: string,
  offeredSuffixes: ReadonlySet<string>,
): SplitResult {
  const normalized = normalizePublicName(input);
  if (!normalized.ok) return normalized;

  const { labels } = normalized;
  for (let i = 1; i < labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    if (!offeredSuffixes.has(suffix)) continue;
    if (i !== 1) {
      return {
        ok: false,
        reason: "not_registrable",
        detail: `${normalized.ascii} is a host under ${labels.slice(i - 1).join(".")}, not a registrable name`,
      };
    }
    return {
      ok: true,
      name: { ascii: normalized.ascii, unicode: normalized.unicode, sld: labels[0], suffix },
    };
  }

  return {
    ok: false,
    reason: "suffix_not_offered",
    detail: `no offered extension matches ${normalized.ascii}`,
  };
}
