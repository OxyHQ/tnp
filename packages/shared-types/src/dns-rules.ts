/**
 * Personal DNS rules: the wire contract for the encrypted envelope, and the
 * rule model the browser and the client CLI share.
 *
 * Normative policy: docs/architecture/naming.md §3. The API only ever sees
 * `DnsRulesEnvelope` — ciphertext, a wrapped key and its KDF parameters — and
 * validates its shape here. The rules themselves (`DnsRule`) exist in
 * plaintext only on the user's devices; their parser runs in the browser
 * before encrypting and in the CLI after decrypting.
 *
 * Browser-safe on purpose: no `node:*`, no Buffer, no dependencies. Name
 * normalization uses the WHATWG URL host parser, which implements UTS #46
 * (IDNA) identically in browsers, Bun and Node.
 */

import { asRecord, type ParseResult } from './parse.js';
import { isValidIpv4, isValidIpv6 } from './dns-records.js';

// ---------------------------------------------------------------------------
// Envelope (what the API stores)
// ---------------------------------------------------------------------------

/** Envelope format version. Mirrors `RULES_ENVELOPE_VERSION` in `@tnp/crypto/dns-rules`. */
export const DNS_RULES_ENVELOPE_VERSION = 1;
/** Largest ciphertext the API stores, in bytes (before base64). */
export const DNS_RULES_MAX_CIPHERTEXT_BYTES = 256 * 1024;
/** Smallest possible ciphertext: one 4 KiB padded bucket plus the 16-byte tag. */
export const DNS_RULES_MIN_CIPHERTEXT_BYTES = 4096 + 16;
/** Highest `version` accepted: the API stores it in a PostgreSQL `integer`. */
export const DNS_RULES_MAX_VERSION = 2_147_483_647;
const SALT_BYTES = 16;
const NONCE_BYTES = 24;
const WRAPPED_KEY_BYTES = 24 + 32 + 16;

/** Argon2id parameters. Bounds mirror `RULES_KDF_LIMITS` in `@tnp/crypto/dns-rules`. */
export interface DnsRulesKdfParams {
  alg: 'argon2id';
  /** Memory, KiB. */
  m: number;
  /** Passes. */
  t: number;
  /** Lanes. */
  p: number;
}

export const DNS_RULES_KDF_LIMITS = {
  m: { min: 19_456, max: 1_048_576 },
  t: { min: 2, max: 10 },
  p: { min: 1, max: 4 },
} as const;

/**
 * The encrypted rule set as stored: `PUT /me/dns-rules` sends exactly this.
 * Binary fields are canonical base64. Nothing in it names a rule, a domain or
 * how many rules there are (the plaintext is padded to a power-of-two bucket).
 */
export interface DnsRulesEnvelope {
  v: 1;
  kdfParams: DnsRulesKdfParams;
  salt: string;
  wrappedKey: string;
  nonce: string;
  ciphertext: string;
  /**
   * Monotonic, also authenticated inside the ciphertext. A write is accepted
   * only when it is exactly the stored version plus one (1 for a first write).
   */
  version: number;
}

/** `PUT /me/dns-rules` request body. */
export type PutDnsRulesRequest = DnsRulesEnvelope;

/** `GET /me/dns-rules` and `PUT /me/dns-rules` response body. */
export interface DnsRulesRecord extends DnsRulesEnvelope {
  /** The caller's own Oxy user id, which the ciphertext's associated data binds. */
  userId: string;
  updatedAt: string;
}

/** `409` body: the write was not exactly current + 1. */
export interface DnsRulesConflict {
  error: string;
  code: 'version_conflict';
  currentVersion: number;
}

/**
 * Canonical base64 of `bytes` length, or exactly that: standard alphabet,
 * correct padding, zero trailing bits. One value, one spelling (security.md §1).
 */
function canonicalBase64Length(value: unknown): number | null {
  if (typeof value !== 'string' || value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if (padding > 0) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const last = alphabet.indexOf(value[value.length - padding - 1]);
    if ((padding === 2 && (last & 0x0f) !== 0) || (padding === 1 && (last & 0x03) !== 0)) {
      return null;
    }
  }
  return (value.length / 4) * 3 - padding;
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

function parseKdfParams(value: unknown): ParseResult<DnsRulesKdfParams> {
  const record = asRecord(value);
  const { m, t, p } = DNS_RULES_KDF_LIMITS;
  if (
    record?.alg !== 'argon2id' ||
    !inRange(record.m, m.min, m.max) ||
    !inRange(record.t, t.min, t.max) ||
    !inRange(record.p, p.min, p.max)
  ) {
    return {
      ok: false,
      error: `kdfParams must be argon2id with m ${m.min}-${m.max} KiB, t ${t.min}-${t.max}, p ${p.min}-${p.max}`,
    };
  }
  return { ok: true, value: { alg: 'argon2id', m: record.m, t: record.t, p: record.p } };
}

function parseEnvelopeFields(record: Record<string, unknown>): ParseResult<DnsRulesEnvelope> {
  if (record.v !== DNS_RULES_ENVELOPE_VERSION) {
    return { ok: false, error: `v must be ${DNS_RULES_ENVELOPE_VERSION}` };
  }
  const kdf = parseKdfParams(record.kdfParams);
  if (!kdf.ok) return kdf;
  if (canonicalBase64Length(record.salt) !== SALT_BYTES) {
    return { ok: false, error: 'salt must be 16 bytes of canonical base64' };
  }
  if (canonicalBase64Length(record.wrappedKey) !== WRAPPED_KEY_BYTES) {
    return { ok: false, error: 'wrappedKey must be 72 bytes of canonical base64' };
  }
  if (canonicalBase64Length(record.nonce) !== NONCE_BYTES) {
    return { ok: false, error: 'nonce must be 24 bytes of canonical base64' };
  }
  const ciphertextBytes = canonicalBase64Length(record.ciphertext);
  if (ciphertextBytes === null) {
    return { ok: false, error: 'ciphertext must be canonical base64' };
  }
  if (ciphertextBytes > DNS_RULES_MAX_CIPHERTEXT_BYTES) {
    return {
      ok: false,
      error: `ciphertext is larger than ${DNS_RULES_MAX_CIPHERTEXT_BYTES} bytes`,
    };
  }
  if (ciphertextBytes < DNS_RULES_MIN_CIPHERTEXT_BYTES) {
    return { ok: false, error: 'ciphertext is too short to be a padded rule set' };
  }
  if (!inRange(record.version, 1, DNS_RULES_MAX_VERSION)) {
    return {
      ok: false,
      error: `version must be an integer between 1 and ${DNS_RULES_MAX_VERSION}`,
    };
  }
  return {
    ok: true,
    value: {
      v: DNS_RULES_ENVELOPE_VERSION,
      kdfParams: kdf.value,
      salt: record.salt as string,
      wrappedKey: record.wrappedKey as string,
      nonce: record.nonce as string,
      ciphertext: record.ciphertext as string,
      version: record.version,
    },
  };
}

/**
 * Validate a `PUT /me/dns-rules` body. Unknown fields are dropped, so nothing
 * a client adds (a rule count, a label) reaches the database.
 */
export function parsePutDnsRulesRequest(body: unknown): ParseResult<PutDnsRulesRequest> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: 'body must be a JSON object' };
  return parseEnvelopeFields(record);
}

/** Validate a `GET /me/dns-rules` response before decrypting it. */
export function parseDnsRulesRecord(body: unknown): ParseResult<DnsRulesRecord> {
  const record = asRecord(body);
  if (!record) return { ok: false, error: 'response must be a JSON object' };
  const envelope = parseEnvelopeFields(record);
  if (!envelope.ok) return envelope;
  if (typeof record.userId !== 'string' || record.userId === '' || record.userId.length > 256) {
    return { ok: false, error: 'userId is required' };
  }
  if (typeof record.updatedAt !== 'string' || Number.isNaN(Date.parse(record.updatedAt))) {
    return { ok: false, error: 'updatedAt must be a timestamp' };
  }
  return {
    ok: true,
    value: { ...envelope.value, userId: record.userId, updatedAt: record.updatedAt },
  };
}

// ---------------------------------------------------------------------------
// Rules (plaintext, devices only)
// ---------------------------------------------------------------------------

/** Most rules one set may hold. Far below what the ciphertext cap allows. */
export const MAX_DNS_RULES = 2000;

export type DnsRuleTarget =
  | { kind: 'ipv4'; value: string }
  | { kind: 'ipv6'; value: string }
  | { kind: 'name'; value: string };

/**
 * One rule. At most one rule per exact name.
 *
 * - `block`: the name (and, with `subdomains`, every name under it) answers
 *   NXDOMAIN on the user's devices.
 * - `redirect`: exactly this name answers with `target` — an address, or a
 *   CNAME to another name resolved through the normal path. Never allowed
 *   for a TNP-native name, and on a device only after local approval.
 */
export type DnsRule =
  | { type: 'block'; name: string; subdomains: boolean }
  | { type: 'redirect'; name: string; target: DnsRuleTarget };

/** The decrypted payload. */
export interface DnsRuleSet {
  rules: DnsRule[];
}

export type DnsRuleField = 'body' | 'type' | 'name' | 'target';

export type DnsRuleErrorCode =
  | 'body_invalid'
  | 'too_many'
  | 'type_invalid'
  | 'name_required'
  | 'name_invalid'
  | 'name_single_label'
  | 'name_ip'
  | 'target_required'
  | 'target_invalid'
  | 'target_self'
  | 'redirect_native'
  | 'duplicate';

export interface DnsRuleParseError {
  readonly ok: false;
  readonly code: DnsRuleErrorCode;
  readonly field: DnsRuleField;
  readonly error: string;
}

export type DnsRuleParseResult<T> = { readonly ok: true; readonly value: T } | DnsRuleParseError;

function fail(field: DnsRuleField, code: DnsRuleErrorCode, error: string): DnsRuleParseError {
  return { ok: false, field, code, error };
}

/** Whether a normalized name is TNP-native. Supplied by the caller from `@tnp/namespace`. */
export type IsNativeName = (name: string) => boolean;

const LDH_LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const FORBIDDEN_NAME_CHARS_RE = /[\s/:?#@[\]\\%]/;

/**
 * Normalize a domain name a person typed: trim, IDNA to ASCII (UTS #46,
 * so `bücher.de` becomes `xn--bcher-kva.de` and full-width dots are dots),
 * lowercase, drop one trailing root dot.
 *
 * Returns a stable `code` instead of a name when it is not a usable hostname:
 * an IP literal (`name_ip`), a single label (`name_single_label` — a rule may
 * never cover a whole TLD, naming.md §3), or anything else (`name_invalid`).
 */
export function normalizeRuleName(
  input: string,
):
  | { ok: true; name: string }
  | { ok: false; code: 'name_required' | 'name_invalid' | 'name_single_label' | 'name_ip' } {
  const raw = typeof input === 'string' ? input.trim().replace(/\.$/, '') : '';
  if (raw === '') return { ok: false, code: 'name_required' };
  if (isValidIpv4(raw) || isValidIpv6(raw.replace(/^\[|\]$/g, ''))) {
    return { ok: false, code: 'name_ip' };
  }
  if (FORBIDDEN_NAME_CHARS_RE.test(raw)) return { ok: false, code: 'name_invalid' };

  let host: string;
  try {
    host = new URL(`http://${raw}/`).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return { ok: false, code: 'name_invalid' };
  }
  // The URL parser reads numeric and hex forms ("1.2.3", "0x7f.1") as IPv4.
  if (isValidIpv4(host) || host.startsWith('[')) return { ok: false, code: 'name_ip' };
  if (host.length === 0 || host.length > 253) return { ok: false, code: 'name_invalid' };

  const labels = host.split('.');
  if (!labels.every((label) => LDH_LABEL_RE.test(label))) {
    return { ok: false, code: 'name_invalid' };
  }
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return { ok: false, code: 'name_ip' };
  if (labels.length < 2) return { ok: false, code: 'name_single_label' };
  return { ok: true, name: host };
}

/**
 * Parse a redirect target typed as one string: an IPv4 or IPv6 address
 * (brackets allowed), or a hostname, which becomes a CNAME-like target.
 */
export function parseDnsRuleTargetInput(input: string): DnsRuleTarget | null {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (raw === '') return null;
  if (isValidIpv4(raw)) return { kind: 'ipv4', value: raw };
  const v6 = raw.replace(/^\[|\]$/g, '');
  if (isValidIpv6(v6)) return { kind: 'ipv6', value: v6.toLowerCase() };
  const name = normalizeRuleName(raw);
  return name.ok ? { kind: 'name', value: name.name } : null;
}

const NAME_ERRORS: Record<string, string> = {
  name_required: 'name is required',
  name_invalid: 'name is not a valid domain name',
  name_single_label: 'a rule must name a domain, never a whole TLD',
  name_ip: 'name must be a domain name, not an IP address',
};

function parseTarget(value: unknown): DnsRuleTarget | null {
  const record = asRecord(value);
  if (!record || typeof record.value !== 'string') return null;
  if (record.kind === 'ipv4')
    return isValidIpv4(record.value) ? { kind: 'ipv4', value: record.value } : null;
  if (record.kind === 'ipv6') {
    return isValidIpv6(record.value) ? { kind: 'ipv6', value: record.value.toLowerCase() } : null;
  }
  if (record.kind === 'name') {
    const name = normalizeRuleName(record.value);
    return name.ok ? { kind: 'name', value: name.name } : null;
  }
  return null;
}

/**
 * Validate one rule. `isNative` decides whether a redirect is refused: the
 * TNP namespace is authoritative for native names, so a personal rule may
 * block one but never point it elsewhere.
 */
export function parseDnsRule(input: unknown, isNative: IsNativeName): DnsRuleParseResult<DnsRule> {
  const record = asRecord(input);
  if (!record) return fail('body', 'body_invalid', 'a rule must be an object');
  if (record.type !== 'block' && record.type !== 'redirect') {
    return fail('type', 'type_invalid', 'type must be block or redirect');
  }
  const name = normalizeRuleName(typeof record.name === 'string' ? record.name : '');
  if (!name.ok) return fail('name', name.code, NAME_ERRORS[name.code]);

  if (record.type === 'block') {
    return {
      ok: true,
      value: { type: 'block', name: name.name, subdomains: record.subdomains === true },
    };
  }

  if (isNative(name.name)) {
    return fail(
      'name',
      'redirect_native',
      'a TNP-native name cannot be redirected: the TNP namespace is authoritative for it',
    );
  }
  if (record.target === undefined || record.target === null) {
    return fail('target', 'target_required', 'target is required');
  }
  const target = parseTarget(record.target);
  if (!target)
    return fail(
      'target',
      'target_invalid',
      'target must be an IPv4 or IPv6 address or a domain name',
    );
  if (target.kind === 'name' && target.value === name.name) {
    return fail('target', 'target_self', 'a name cannot redirect to itself');
  }
  return { ok: true, value: { type: 'redirect', name: name.name, target } };
}

/** A rule the set carried but that cannot be used, with why. */
export interface RejectedDnsRule {
  index: number;
  code: DnsRuleErrorCode;
  error: string;
}

/**
 * Parse a decrypted rule set.
 *
 * Structure errors fail the whole set. A single unusable rule does not: it is
 * reported in `rejected` and left out, so (for example) a redirect for a name
 * whose TLD has since become native stops applying without taking every
 * other rule down with it. A second rule for a name already covered is
 * rejected as `duplicate`.
 */
export function parseDnsRuleSet(
  input: unknown,
  isNative: IsNativeName,
): ParseResult<{ rules: DnsRule[]; rejected: RejectedDnsRule[] }> {
  const record = asRecord(input);
  if (!record || !Array.isArray(record.rules)) {
    return { ok: false, error: 'a rule set is an object with a rules array' };
  }
  if (record.rules.length > MAX_DNS_RULES) {
    return { ok: false, error: `a rule set holds at most ${MAX_DNS_RULES} rules` };
  }
  const rules: DnsRule[] = [];
  const rejected: RejectedDnsRule[] = [];
  const seen = new Set<string>();
  record.rules.forEach((raw, index) => {
    const parsed = parseDnsRule(raw, isNative);
    if (!parsed.ok) {
      rejected.push({ index, code: parsed.code, error: parsed.error });
      return;
    }
    if (seen.has(parsed.value.name)) {
      rejected.push({ index, code: 'duplicate', error: 'another rule already covers this name' });
      return;
    }
    seen.add(parsed.value.name);
    rules.push(parsed.value);
  });
  return { ok: true, value: { rules, rejected } };
}

/**
 * The plaintext encoding of a rule set: JSON, rules sorted by name, each with
 * exactly its fields. Deterministic, so the same rules always encrypt from
 * the same bytes.
 */
export function serializeDnsRuleSet(rules: readonly DnsRule[]): string {
  const sorted = [...rules].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify({
    rules: sorted.map((rule) =>
      rule.type === 'block'
        ? { type: 'block', name: rule.name, subdomains: rule.subdomains }
        : {
            type: 'redirect',
            name: rule.name,
            target: { kind: rule.target.kind, value: rule.target.value },
          },
    ),
  });
}

/** One-line description of a redirect target, for approval prompts and the rules file. */
export function describeDnsRuleTarget(target: DnsRuleTarget): string {
  return `${target.kind} ${target.value}`;
}
