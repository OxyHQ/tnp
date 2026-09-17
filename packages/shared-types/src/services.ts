/**
 * Wire contracts for `/services` — the optional public-domain, DNS and hosting
 * layer (docs/architecture/services.md).
 *
 * Browser-safe: no Node imports. Money crosses the wire as a decimal string of
 * minor units, because a JSON number is a double.
 */

import { asRecord, stringField, type ParseResult } from "./parse.js";

export interface MoneyDto {
  currency: string;
  /** Integer count of the currency's minor unit, as a decimal string. */
  amountMinor: string;
}

export interface ServicesStatus {
  catalog: boolean;
  dnsWrite: boolean;
  renewals: boolean;
  /**
   * Whether an order can be placed right now. False until a payment mechanism
   * is approved and integrated, whatever the flags say.
   */
  purchasable: boolean;
  /** Why `purchasable` is false, when it is. */
  purchaseBlockedReason: "sales_disabled" | "payments_not_configured" | null;
}

export type PublicAvailabilityStatus = "available" | "unavailable" | "unknown" | "unsupported" | "invalid";

export interface PublicAvailability {
  input: string;
  /** Canonical ASCII name, when the input parsed. */
  name: string | null;
  displayName: string | null;
  status: PublicAvailabilityStatus;
  premium: boolean;
  detail: string | null;
}

export interface PublicAvailabilityResponse {
  results: PublicAvailability[];
  /** Availability is a moment's answer, not a reservation. */
  notice: "availability_is_not_a_reservation";
}

export interface QuoteDto {
  id: string;
  name: string;
  displayName: string;
  operation: "register" | "renew" | "transfer_in";
  years: number;
  price: MoneyDto;
  /** Provider fees included in `price`, itemized. */
  fees: MoneyDto;
  /** One-year renewal price, when the provider quotes it. Shown before purchase. */
  renewalPrice: MoneyDto | null;
  premium: boolean;
  expiresAt: string;
}

export type PublicDomainLifecycleDto =
  | "pending"
  | "active"
  | "expired"
  | "redemption"
  | "transferring_in"
  | "transferred_out"
  | "locked_by_registry"
  | "failed"
  | "unknown";

export type OperationStatusDto = "queued" | "running" | "succeeded" | "failed" | "unknown" | "manual_review";

/** Owner view. Contacts are never included. */
export interface OwnedPublicDomain {
  id: string;
  name: string;
  displayName: string;
  /** Always `public-dns`: never a TNP-native name. */
  namespace: "public-dns";
  provider: { adapter: string; environment: "sandbox" | "production" };
  lifecycle: PublicDomainLifecycleDto;
  expiresAt: string | null;
  locked: boolean | null;
  renewalOwner: "none" | "tnp" | "provider";
  lastSyncedAt: string | null;
  zone: {
    authority: "provider" | "external";
    state: "unmanaged" | "in_sync" | "pending" | "conflict" | "unknown";
    lastVerifiedAt: string | null;
  } | null;
  createdAt: string;
}

export interface OwnedPublicDomainPage {
  domains: OwnedPublicDomain[];
  total: number;
  page: number;
  pages: number;
}

export interface OperationDto {
  id: string;
  kind: string;
  status: OperationStatusDto;
  attempts: number;
  errorCode: string | null;
  /** Safe, user-facing text only. */
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ZoneRecordDto {
  host: string;
  type: string;
  value: string;
  ttl: number;
  priority: number | null;
}

export type ZoneChangeDto =
  | { action: "add"; record: ZoneRecordDto }
  | { action: "update"; match: { host: string; type: string; value: string }; record: ZoneRecordDto }
  | { action: "delete"; match: { host: string; type: string; value: string } };

export interface ZonePreviewRequest {
  changes: ZoneChangeDto[];
}

export interface ZonePreviewResponse {
  /** Hash of the zone as just read. Send it back with the change to apply. */
  baseHash: string;
  current: ZoneRecordDto[];
  proposed: ZoneRecordDto[];
  added: ZoneRecordDto[];
  removed: ZoneRecordDto[];
  /** The provider has no compare-and-swap; an edit in its panel can still race. */
  notice: "provider_panel_edits_can_race";
}

export interface ZoneApplyRequest {
  changes: ZoneChangeDto[];
  baseHash: string;
}

export interface ZoneApplyResponse {
  operation: OperationDto;
}

export interface QuoteRequest {
  name: string;
  years: number;
}

export const MAX_ZONE_CHANGES = 50;
export const MAX_AVAILABILITY_NAMES = 10;

export function parseQuoteRequest(body: unknown): ParseResult<QuoteRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: "request body must be an object" };
  const name = stringField(record, "name");
  if (!name.ok) return name;
  if (name.value.length > 253) return { ok: false, error: "name is too long" };
  const years = record.years ?? 1;
  if (typeof years !== "number" || !Number.isInteger(years) || years < 1 || years > 10) {
    return { ok: false, error: "years must be an integer between 1 and 10" };
  }
  return { ok: true, value: { name: name.value, years } };
}

export function parseAvailabilityNames(query: unknown): ParseResult<string[]> {
  const raw = Array.isArray(query) ? query : typeof query === "string" ? query.split(",") : null;
  if (!raw) return { ok: false, error: "name query parameter is required" };
  const names = raw
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (names.length === 0) return { ok: false, error: "name query parameter is required" };
  if (names.length > MAX_AVAILABILITY_NAMES) {
    return { ok: false, error: `at most ${MAX_AVAILABILITY_NAMES} names per search` };
  }
  if (names.some((n) => n.length > 253)) return { ok: false, error: "name is too long" };
  return { ok: true, value: names };
}

function parseRecord(value: unknown, path: string): ParseResult<ZoneRecordDto> {
  const record = asRecord(value);
  if (!record) return { ok: false, error: `${path} must be an object` };
  const host = stringField(record, "host");
  if (!host.ok) return { ok: false, error: `${path}.host is required` };
  const type = stringField(record, "type");
  if (!type.ok) return { ok: false, error: `${path}.type is required` };
  const val = stringField(record, "value");
  if (!val.ok) return { ok: false, error: `${path}.value is required` };
  const ttl = record.ttl ?? 1800;
  if (typeof ttl !== "number" || !Number.isInteger(ttl)) {
    return { ok: false, error: `${path}.ttl must be an integer` };
  }
  const priority = record.priority ?? null;
  if (priority !== null && (typeof priority !== "number" || !Number.isInteger(priority))) {
    return { ok: false, error: `${path}.priority must be an integer` };
  }
  return { ok: true, value: { host: host.value, type: type.value.toUpperCase(), value: val.value, ttl, priority } };
}

function parseMatch(value: unknown, path: string): ParseResult<{ host: string; type: string; value: string }> {
  const record = asRecord(value);
  if (!record) return { ok: false, error: `${path} must be an object` };
  const host = stringField(record, "host");
  const type = stringField(record, "type");
  const val = stringField(record, "value");
  if (!host.ok || !type.ok || !val.ok) return { ok: false, error: `${path} needs host, type and value` };
  return { ok: true, value: { host: host.value, type: type.value.toUpperCase(), value: val.value } };
}

export function parseZoneChanges(body: unknown): ParseResult<ZoneChangeDto[]> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: "request body must be an object" };
  const changes = record.changes;
  if (!Array.isArray(changes) || changes.length === 0) return { ok: false, error: "changes must be a non-empty array" };
  if (changes.length > MAX_ZONE_CHANGES) return { ok: false, error: `at most ${MAX_ZONE_CHANGES} changes per request` };

  const parsed: ZoneChangeDto[] = [];
  for (const [i, raw] of changes.entries()) {
    const change = asRecord(raw);
    const path = `changes[${i}]`;
    if (!change) return { ok: false, error: `${path} must be an object` };
    if (change.action === "add") {
      const rec = parseRecord(change.record, `${path}.record`);
      if (!rec.ok) return rec;
      parsed.push({ action: "add", record: rec.value });
    } else if (change.action === "update") {
      const match = parseMatch(change.match, `${path}.match`);
      if (!match.ok) return match;
      const rec = parseRecord(change.record, `${path}.record`);
      if (!rec.ok) return rec;
      parsed.push({ action: "update", match: match.value, record: rec.value });
    } else if (change.action === "delete") {
      const match = parseMatch(change.match, `${path}.match`);
      if (!match.ok) return match;
      parsed.push({ action: "delete", match: match.value });
    } else {
      return { ok: false, error: `${path}.action must be add, update or delete` };
    }
  }
  return { ok: true, value: parsed };
}

export function parseZoneApplyRequest(body: unknown): ParseResult<ZoneApplyRequest> {
  const changes = parseZoneChanges(body);
  if (!changes.ok) return changes;
  const record = asRecord(body);
  const baseHash = record ? stringField(record, "baseHash") : null;
  if (!baseHash?.ok || !/^[0-9a-f]{64}$/.test(baseHash.value)) {
    return { ok: false, error: "baseHash from a preview is required" };
  }
  return { ok: true, value: { changes: changes.value, baseHash: baseHash.value } };
}

export interface ContactDto {
  firstName: string;
  lastName: string;
  organization?: string;
  address1: string;
  address2?: string;
  city: string;
  stateProvince: string;
  postalCode: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  /** `+CC.NUMBER`, the form registrars accept. */
  phone: string;
  email: string;
}

export interface PlaceOrderRequest {
  quoteIds: string[];
  /** One contact used for every role; per-role contacts arrive with the contact editor. */
  contact: ContactDto;
  privacy: boolean;
  /** The owner accepted the terms and saw the renewal price. Recorded, not trusted for payment. */
  acceptedTerms: true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COUNTRY_RE = /^[A-Z]{2}$/;
const PHONE_RE = /^\+\d{1,3}\.\d{4,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseContact(value: unknown): ParseResult<ContactDto> {
  const record = asRecord(value);
  if (!record) return { ok: false, error: "contact must be an object" };
  const required = ["firstName", "lastName", "address1", "city", "stateProvince", "postalCode", "country", "phone", "email"] as const;
  const out: Record<string, string> = {};
  for (const key of required) {
    const field = stringField(record, key);
    if (!field.ok) return { ok: false, error: `contact.${key} is required` };
    if (field.value.length > 255) return { ok: false, error: `contact.${key} is too long` };
    out[key] = field.value;
  }
  for (const key of ["organization", "address2"] as const) {
    const raw = record[key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw !== "string" || raw.length > 255) return { ok: false, error: `contact.${key} must be a short string` };
    out[key] = raw.trim();
  }
  const country = out.country.toUpperCase();
  if (!COUNTRY_RE.test(country)) return { ok: false, error: "contact.country must be an ISO 3166-1 alpha-2 code" };
  if (!PHONE_RE.test(out.phone)) return { ok: false, error: "contact.phone must look like +1.5555555555" };
  if (!EMAIL_RE.test(out.email)) return { ok: false, error: "contact.email is not an email address" };
  return {
    ok: true,
    value: {
      firstName: out.firstName,
      lastName: out.lastName,
      ...(out.organization ? { organization: out.organization } : {}),
      address1: out.address1,
      ...(out.address2 ? { address2: out.address2 } : {}),
      city: out.city,
      stateProvince: out.stateProvince,
      postalCode: out.postalCode,
      country,
      phone: out.phone,
      email: out.email,
    },
  };
}

export function parsePlaceOrderRequest(body: unknown): ParseResult<PlaceOrderRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: "request body must be an object" };
  const ids = record.quoteIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 10 || !ids.every((id) => typeof id === "string" && UUID_RE.test(id))) {
    return { ok: false, error: "quoteIds must be 1–10 quote ids" };
  }
  const contact = parseContact(record.contact);
  if (!contact.ok) return contact;
  if (record.acceptedTerms !== true) return { ok: false, error: "the terms must be accepted" };
  return {
    ok: true,
    value: { quoteIds: ids as string[], contact: contact.value, privacy: record.privacy === true, acceptedTerms: true },
  };
}
