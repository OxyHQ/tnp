/**
 * Wire contracts and validation for DNS records under a native domain.
 *
 * One parser, imported by the API routes that write records and by the web
 * editor that shows inline errors — so the form cannot accept what the API
 * refuses, or the reverse. The API is still the authority; the web runs the
 * same code only to answer sooner.
 *
 * Browser-safe on purpose: no `node:net`, no Buffer. The web bundles this file.
 *
 * Each failure carries a stable `code` and the `field` it concerns alongside
 * the English `error`, so the web can translate the message and put it next to
 * the right input without parsing prose.
 */

import { asRecord } from "./parse.js";

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export const DNS_RECORD_TTL_MIN = 60;
export const DNS_RECORD_TTL_MAX = 86_400;
/** Applied only when the request carries no TTL. An out-of-range TTL is an error. */
export const DNS_RECORD_TTL_DEFAULT = 3600;
/** Longest TXT value accepted. */
export const DNS_TXT_MAX_LENGTH = 2048;
/** Records one domain may hold. Enforced by the API, published for the web. */
export const MAX_DNS_RECORDS_PER_DOMAIN = 100;

const MAX_HOSTNAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const MX_PRIORITY_MAX = 65_535;

/** `POST /domains/:id/records` request. */
export interface CreateDnsRecordRequest {
  type: DnsRecordType;
  /** `@` for the apex, or labels relative to the domain (`www`, `a.b`). */
  name: string;
  /** For MX, the mail host alone when `priority` is given, or `"<priority> <host>"`. */
  value: string;
  ttl?: number;
  /** MX only. */
  priority?: number;
}

/** `PUT /domains/:id/records/:rid` request. Every field optional; the merged record is validated. */
export type UpdateDnsRecordRequest = Partial<CreateDnsRecordRequest>;

/**
 * A validated record in its stored form.
 *
 * There is no priority column: an MX record's priority lives in `value` as
 * `"<priority> <host>"`, which is also the form the resolver has always parsed.
 */
export interface DnsRecordInput {
  type: DnsRecordType;
  name: string;
  value: string;
  ttl: number;
}

/** A record as the API returns it. */
export interface DnsRecordDto {
  _id: string;
  type: DnsRecordType;
  name: string;
  value: string;
  ttl: number;
  createdAt: string;
  updatedAt: string;
}

export type DnsRecordField = "body" | "type" | "name" | "value" | "priority" | "ttl";

export type DnsRecordErrorCode =
  | "body_invalid"
  | "type_invalid"
  | "name_required"
  | "name_invalid"
  | "name_wildcard"
  | "value_required"
  | "ipv4_invalid"
  | "ipv6_invalid"
  | "hostname_invalid"
  | "txt_too_long"
  | "txt_invalid_chars"
  | "priority_invalid"
  | "ttl_invalid";

export interface DnsRecordParseError {
  readonly ok: false;
  readonly error: string;
  readonly field: DnsRecordField;
  readonly code: DnsRecordErrorCode;
}

export type DnsRecordParseResult<T> = { readonly ok: true; readonly value: T } | DnsRecordParseError;

function fail(field: DnsRecordField, code: DnsRecordErrorCode, error: string): DnsRecordParseError {
  return { ok: false, field, code, error };
}

export function isDnsRecordType(value: unknown): value is DnsRecordType {
  return typeof value === "string" && (DNS_RECORD_TYPES as readonly string[]).includes(value);
}

/** Strict dotted quad: four decimal octets, 0-255, no leading zeros. */
export function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every(
    (part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255,
  );
}

/**
 * RFC 4291 §2.2 text form, without zone identifiers.
 *
 * Eight groups of 1-4 hex digits; one `::` may stand for one or more zero
 * groups; the last 32 bits may be written as a dotted quad. Written by hand
 * because `node:net` is not available in the browser bundle.
 */
export function isValidIpv6(value: string): boolean {
  if (value.length === 0 || value.length > 45) return false;

  const doubleColon = value.indexOf("::");
  if (doubleColon !== -1 && value.indexOf("::", doubleColon + 1) !== -1) return false;

  const groupsOf = (part: string): string[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    return groups.some((group) => group === "") ? null : groups;
  };

  let head: string[] | null;
  let tail: string[] | null;
  if (doubleColon === -1) {
    head = groupsOf(value);
    tail = [];
  } else {
    head = groupsOf(value.slice(0, doubleColon));
    tail = groupsOf(value.slice(doubleColon + 2));
  }
  if (head === null || tail === null) return false;

  const groups = [...head, ...tail];
  let width = 0;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const isLast = i === groups.length - 1;
    if (isLast && group.includes(".")) {
      if (!isValidIpv4(group)) return false;
      width += 2;
    } else if (/^[0-9a-fA-F]{1,4}$/.test(group)) {
      width += 1;
    } else {
      return false;
    }
  }

  // `::` must replace at least one group; without it the address is exactly 128 bits.
  return doubleColon === -1 ? width === 8 : width <= 7;
}

const HOST_LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Normalize a target hostname (CNAME, NS, MX exchange): lowercase, one optional
 * trailing root dot removed. Returns null when it is not a hostname.
 *
 * Letters, digits and interior hyphens per label; labels 1-63; total 253. The
 * last label may not be all digits (RFC 1123 §2.1): that is what refuses an IP
 * address typed where a hostname belongs, the commonest CNAME mistake, which
 * would otherwise pass as a four-label name.
 */
export function normalizeHostname(input: string): string | null {
  const host = input.trim().toLowerCase().replace(/\.$/, "");
  if (!host || host.length > MAX_HOSTNAME_LENGTH) return null;
  const labels = host.split(".");
  const valid = labels.every(
    (label) => label.length <= MAX_LABEL_LENGTH && HOST_LABEL_RE.test(label),
  );
  if (!valid || /^[0-9]+$/.test(labels[labels.length - 1])) return null;
  return host;
}

/**
 * A record-name label. Same as a hostname label, plus one leading underscore,
 * because service and verification names (`_dmarc`, `_acme-challenge`) are
 * the main reason anyone writes a TXT record.
 */
const RECORD_NAME_LABEL_RE = /^_?[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function parseRecordName(raw: unknown): DnsRecordParseResult<string> {
  if (typeof raw !== "string" || raw.trim() === "") {
    return fail("name", "name_required", "name is required");
  }
  const name = raw.trim().toLowerCase();
  if (name === "@") return { ok: true, value: name };

  // The resolver matches record names exactly; a wildcard would be stored and
  // then never answered, which is worse than refusing it.
  if (name.split(".").includes("*")) {
    return fail("name", "name_wildcard", "Wildcard records are not supported");
  }

  const labels = name.split(".");
  const valid =
    name.length <= MAX_HOSTNAME_LENGTH &&
    labels.every(
      (label) => label.length <= MAX_LABEL_LENGTH && RECORD_NAME_LABEL_RE.test(label),
    );
  if (!valid) {
    return fail(
      "name",
      "name_invalid",
      "name must be @ or labels of letters, digits and hyphens relative to the domain",
    );
  }
  return { ok: true, value: name };
}

function parseType(raw: unknown): DnsRecordParseResult<DnsRecordType> {
  const type = typeof raw === "string" ? raw.trim().toUpperCase() : raw;
  if (!isDnsRecordType(type)) {
    return fail("type", "type_invalid", `type must be one of ${DNS_RECORD_TYPES.join(", ")}`);
  }
  return { ok: true, value: type };
}

/** Absent (undefined or null) means "use the default"; anything present must be in range. */
function parseTtl(raw: unknown): DnsRecordParseResult<number | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < DNS_RECORD_TTL_MIN ||
    raw > DNS_RECORD_TTL_MAX
  ) {
    return fail(
      "ttl",
      "ttl_invalid",
      `ttl must be an integer between ${DNS_RECORD_TTL_MIN} and ${DNS_RECORD_TTL_MAX}`,
    );
  }
  return { ok: true, value: raw };
}

function parsePriority(raw: unknown): DnsRecordParseResult<number | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MX_PRIORITY_MAX) {
    return fail(
      "priority",
      "priority_invalid",
      `priority must be an integer between 0 and ${MX_PRIORITY_MAX}`,
    );
  }
  return { ok: true, value: raw };
}

function parseValueString(raw: unknown): DnsRecordParseResult<string> {
  if (typeof raw !== "string" || raw.trim() === "") {
    return fail("value", "value_required", "value is required");
  }
  return { ok: true, value: raw.trim() };
}

/** `"<priority> <host>"`, the stored MX form. */
const MX_VALUE_RE = /^(\d+)\s+(\S+)$/;

/** Split a stored MX value. Null when it is not in the stored form. */
export function splitMxValue(value: string): { priority: number; host: string } | null {
  const match = MX_VALUE_RE.exec(value.trim());
  return match ? { priority: Number(match[1]), host: match[2] } : null;
}

// Control characters: C0 and DEL. Built from code points rather than written as
// escapes in a regex literal, so no tool along the way can turn them into the
// raw bytes they describe.
const CONTROL_CHARS_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}]`,
);

function parseValue(
  type: DnsRecordType,
  value: string,
  priority: number | undefined,
): DnsRecordParseResult<string> {
  switch (type) {
    case "A":
      return isValidIpv4(value)
        ? { ok: true, value }
        : fail("value", "ipv4_invalid", "An A record needs an IPv4 address like 192.0.2.1");
    case "AAAA":
      return isValidIpv6(value)
        ? { ok: true, value: value.toLowerCase() }
        : fail("value", "ipv6_invalid", "An AAAA record needs an IPv6 address like 2001:db8::1");
    case "CNAME":
    case "NS": {
      const host = normalizeHostname(value);
      return host
        ? { ok: true, value: host }
        : fail("value", "hostname_invalid", `A ${type} record needs a hostname like host.example.ox`);
    }
    case "MX": {
      let host = value;
      let effectivePriority = priority;
      if (effectivePriority === undefined) {
        const split = splitMxValue(value);
        if (!split) {
          return fail("priority", "priority_invalid", "An MX record needs a priority between 0 and 65535");
        }
        const parsedPriority = parsePriority(split.priority);
        if (!parsedPriority.ok) return parsedPriority;
        effectivePriority = parsedPriority.value;
        host = split.host;
      }
      const normalized = normalizeHostname(host);
      if (!normalized) {
        return fail("value", "hostname_invalid", "An MX record needs a mail host like mail.example.ox");
      }
      return { ok: true, value: `${effectivePriority} ${normalized}` };
    }
    case "TXT":
      if (value.length > DNS_TXT_MAX_LENGTH) {
        return fail("value", "txt_too_long", `A TXT value may be at most ${DNS_TXT_MAX_LENGTH} characters`);
      }
      if (CONTROL_CHARS_RE.test(value)) {
        return fail("value", "txt_invalid_chars", "A TXT value may not contain control characters");
      }
      return { ok: true, value };
  }
}

/** Validate and normalize a new record. */
export function parseCreateDnsRecordRequest(body: unknown): DnsRecordParseResult<DnsRecordInput> {
  const record = asRecord(body);
  if (!record) return fail("body", "body_invalid", "request body must be an object");

  const type = parseType(record.type);
  if (!type.ok) return type;
  const name = parseRecordName(record.name);
  if (!name.ok) return name;
  const rawValue = parseValueString(record.value);
  if (!rawValue.ok) return rawValue;
  const priority = parsePriority(record.priority);
  if (!priority.ok) return priority;
  const ttl = parseTtl(record.ttl);
  if (!ttl.ok) return ttl;

  const value = parseValue(type.value, rawValue.value, priority.value);
  if (!value.ok) return value;

  return {
    ok: true,
    value: {
      type: type.value,
      name: name.value,
      value: value.value,
      ttl: ttl.value ?? DNS_RECORD_TTL_DEFAULT,
    },
  };
}

/**
 * Validate the shape of an update.
 *
 * Only the fields that can be checked alone are checked here. Whether the
 * value fits the type depends on the record it is merged into — see
 * {@link mergeDnsRecordUpdate}, whose result is what gets validated in full.
 */
export function parseUpdateDnsRecordRequest(
  body: unknown,
): DnsRecordParseResult<UpdateDnsRecordRequest> {
  const record = asRecord(body);
  if (!record) return fail("body", "body_invalid", "request body must be an object");

  const patch: UpdateDnsRecordRequest = {};

  if (record.type !== undefined) {
    const type = parseType(record.type);
    if (!type.ok) return type;
    patch.type = type.value;
  }
  if (record.name !== undefined) {
    const name = parseRecordName(record.name);
    if (!name.ok) return name;
    patch.name = name.value;
  }
  if (record.value !== undefined) {
    const value = parseValueString(record.value);
    if (!value.ok) return value;
    patch.value = value.value;
  }
  if (record.ttl !== undefined) {
    // An explicit null on update is not "use the default": it would silently
    // reset a TTL the owner set. Refused like any other out-of-range value.
    const ttl = record.ttl === null ? parseTtl(Number.NaN) : parseTtl(record.ttl);
    if (!ttl.ok) return ttl;
    patch.ttl = ttl.value;
  }
  if (record.priority !== undefined) {
    const priority = parsePriority(record.priority);
    if (!priority.ok) return priority;
    patch.priority = priority.value;
  }

  return { ok: true, value: patch };
}

/**
 * Apply an update to a stored record and validate the result as a whole.
 *
 * Validating the patch alone is how a record ends up an A record holding a
 * hostname: change only the type, and the old value is never looked at.
 *
 * MX is the one type whose value is two fields. An update that sends only a
 * new `priority` keeps the stored host; one that sends only a bare host keeps
 * the stored priority; a value already in `"<priority> <host>"` form stands
 * on its own.
 */
export function mergeDnsRecordUpdate(
  existing: DnsRecordInput,
  patch: UpdateDnsRecordRequest,
): DnsRecordParseResult<DnsRecordInput> {
  const type = patch.type ?? existing.type;
  const merged: Record<string, unknown> = {
    type,
    name: patch.name ?? existing.name,
    ttl: patch.ttl ?? existing.ttl,
  };

  if (type === "MX") {
    const stored = existing.type === "MX" ? splitMxValue(existing.value) : null;
    if (patch.value !== undefined) {
      merged.value = patch.value;
      merged.priority =
        patch.priority ?? (splitMxValue(patch.value) ? undefined : stored?.priority);
    } else {
      merged.value = stored?.host ?? existing.value;
      merged.priority = patch.priority ?? stored?.priority;
    }
  } else {
    merged.value = patch.value ?? existing.value;
  }

  return parseCreateDnsRecordRequest(merged);
}
