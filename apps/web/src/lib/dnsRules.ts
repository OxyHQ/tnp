/**
 * Personal DNS rules in the browser: unlock, edit, re-encrypt, save.
 *
 * Policy: docs/architecture/naming.md §3. Everything secret stays in this
 * tab's memory: the passphrase is used once and dropped, the key derived from
 * it is wiped right after unwrapping, and the rules key lives in React state
 * until the page is left or locked. Nothing here touches localStorage or
 * sessionStorage. The API sees only the envelope.
 *
 * Network and crypto are injected (`RulesApi`, `RulesCrypto`) so the tests
 * run the real logic — and capture the real PUT body — without a browser.
 */

import {
  createRulesEnvelope,
  openRulesEnvelope,
  type RulesEnvelope,
  RulesEnvelopeError,
  resealRulesEnvelope,
  unlockRulesKey,
} from '@tnp/crypto/dns-rules';
import { BUILTIN_NATIVE_TLDS, classifyName } from '@tnp/namespace';
import {
  type DnsRule,
  type DnsRulesRecord,
  type PutDnsRulesRequest,
  parseDnsRuleSet,
  parseDnsRulesRecord,
  type RejectedDnsRule,
  serializeDnsRuleSet,
} from '@tnp/shared-types';

/** The shortest sync passphrase the form accepts. */
export const MIN_PASSPHRASE_LENGTH = 12;

/**
 * Whether a name is TNP-native, from the built-in native TLDs. The client CLI
 * checks again with the TLD table its resolver synced, so a TLD approved
 * after this build is still refused there.
 */
export function isNativeName(name: string): boolean {
  return classifyName(name, BUILTIN_NATIVE_TLDS) === 'tnp-native';
}

export interface RulesApi {
  /** `GET /me/dns-rules`; null on 404. */
  get(): Promise<unknown | null>;
  /** `PUT /me/dns-rules`. Throws `RulesConflictError` on 409. */
  put(body: PutDnsRulesRequest): Promise<unknown>;
  /** `DELETE /me/dns-rules`. */
  remove(): Promise<void>;
}

/** The Argon2id-heavy calls, so the page can run them off the main thread. */
export interface RulesCrypto {
  unlock(args: {
    passphrase: string;
    userId: string;
    envelope: RulesEnvelope;
  }): Promise<Uint8Array>;
  create(args: {
    passphrase: string;
    userId: string;
    body: Uint8Array;
  }): Promise<{ envelope: RulesEnvelope; rulesKey: Uint8Array }>;
}

/** The same calls on the current thread. */
export const inlineCrypto: RulesCrypto = {
  unlock: async (args) => unlockRulesKey(args),
  create: async (args) => createRulesEnvelope(args),
};

/** Someone else saved a newer version first (409). */
export class RulesConflictError extends Error {
  constructor() {
    super('the rule set changed on another device');
    this.name = 'RulesConflictError';
  }
}

/** The stored record failed the contract, or the API answered something else. */
export class RulesFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesFormatError';
  }
}

export interface UnlockedRules {
  record: DnsRulesRecord;
  rulesKey: Uint8Array;
  rules: DnsRule[];
  /** Rules in the stored set this build cannot use (shown, then dropped on the next save). */
  rejected: RejectedDnsRule[];
}

function asRecord(raw: unknown): DnsRulesRecord {
  const parsed = parseDnsRulesRecord(raw);
  if (!parsed.ok) throw new RulesFormatError(parsed.error);
  return parsed.value;
}

export async function loadRulesRecord(api: RulesApi): Promise<DnsRulesRecord | null> {
  const raw = await api.get();
  return raw === null ? null : asRecord(raw);
}

function decrypt(
  rulesKey: Uint8Array,
  record: DnsRulesRecord,
): { rules: DnsRule[]; rejected: RejectedDnsRule[] } {
  const body = openRulesEnvelope({ rulesKey, userId: record.userId, envelope: record });
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new RulesFormatError('the decrypted rule set is not JSON');
  }
  const parsed = parseDnsRuleSet(json, isNativeName);
  if (!parsed.ok) throw new RulesFormatError(parsed.error);
  return parsed.value;
}

/** Unlock a stored rule set with the passphrase. Throws `RulesEnvelopeError` ('wrong-passphrase', 'tampered', …). */
export async function unlockRules(
  record: DnsRulesRecord,
  passphrase: string,
  userId: string,
  crypto: RulesCrypto = inlineCrypto,
): Promise<UnlockedRules> {
  if (record.userId !== userId) {
    throw new RulesEnvelopeError('tampered', 'the stored rule set belongs to another account');
  }
  const rulesKey = await crypto.unlock({ passphrase, userId, envelope: record });
  return { record, rulesKey, ...decrypt(rulesKey, record) };
}

/** Create the first, empty rule set under a new passphrase and store it. */
export async function createRules(
  api: RulesApi,
  passphrase: string,
  userId: string,
  crypto: RulesCrypto = inlineCrypto,
): Promise<UnlockedRules> {
  const { envelope, rulesKey } = await crypto.create({
    passphrase,
    userId,
    body: new TextEncoder().encode(serializeDnsRuleSet([])),
  });
  const record = asRecord(await api.put(envelope));
  return { record, rulesKey, rules: [], rejected: [] };
}

/**
 * Re-encrypt `rules` as the next version and store it. On a 409 the caller
 * reloads: `reloadRules` re-opens the newer set with the same in-memory key.
 */
export async function saveRules(
  api: RulesApi,
  unlocked: Pick<UnlockedRules, 'record' | 'rulesKey'>,
  rules: readonly DnsRule[],
): Promise<UnlockedRules> {
  const { record, rulesKey } = unlocked;
  const envelope = resealRulesEnvelope({
    rulesKey,
    userId: record.userId,
    previous: record,
    body: new TextEncoder().encode(serializeDnsRuleSet(rules)),
  });
  const saved = asRecord(await api.put(envelope));
  return { record: saved, rulesKey, rules: [...rules], rejected: [] };
}

/**
 * Fetch the stored set again and open it with the key already in memory.
 * Returns null when it no longer opens (re-created elsewhere with a new
 * passphrase, or deleted): the page locks and asks again.
 */
export async function reloadRules(
  api: RulesApi,
  rulesKey: Uint8Array,
  userId: string,
): Promise<UnlockedRules | null> {
  const record = await loadRulesRecord(api);
  if (!record || record.userId !== userId) return null;
  try {
    return { record, rulesKey, ...decrypt(rulesKey, record) };
  } catch (err) {
    if (err instanceof RulesEnvelopeError) return null;
    throw err;
  }
}

type Request = <T>(
  method: 'GET' | 'PUT' | 'DELETE',
  path: string,
  options?: { body?: unknown },
) => Promise<T>;

/** `RulesApi` over the app's authenticated API client: 404 is "none stored", 409 a conflict. */
export function httpRulesApi(
  request: Request,
  statusOf: (err: unknown) => number | undefined,
): RulesApi {
  return {
    async get() {
      try {
        return await request<unknown>('GET', '/me/dns-rules');
      } catch (err) {
        if (statusOf(err) === 404) return null;
        throw err;
      }
    },
    async put(body) {
      try {
        return await request<unknown>('PUT', '/me/dns-rules', { body });
      } catch (err) {
        if (statusOf(err) === 409) throw new RulesConflictError();
        throw err;
      }
    },
    async remove() {
      try {
        await request<unknown>('DELETE', '/me/dns-rules');
      } catch (err) {
        if (statusOf(err) !== 404) throw err;
      }
    },
  };
}

/** Best-effort erasure of the rules key when the page locks or unmounts. */
export function wipeKey(key: Uint8Array | null | undefined): void {
  key?.fill(0);
}
