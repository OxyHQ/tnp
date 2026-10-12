/**
 * The device side of synced personal DNS rules: the stored rules key, the
 * rollback record, local approvals, and the active rules file.
 *
 * Normative policy: docs/architecture/naming.md §3. Two places on disk:
 *
 * - **Secret state** (`<systemStateDir>/dns-rules/`, root only, 0700/0600):
 *   the rules key (so later pulls need no passphrase), the highest rule-set
 *   version accepted with its ciphertext digest (rollback and fork
 *   detection), the last accepted envelope, and this device's approvals.
 *   The resolver daemon never reads any of it — on Linux it cannot.
 * - **The active rules file** (`<configDir>/dns-rules.conf`): the decrypted
 *   rules that apply on this device — every block, and only the redirects
 *   approved here. Human-readable, one place (§3.5). On Linux root:tnp 0640,
 *   like `resolver.json`, so the sandboxed daemon can read it; elsewhere 0600
 *   (the daemon runs as root/SYSTEM there).
 *
 * The sync passphrase is never written anywhere.
 */

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decodeBase64Strict, encodeBase64 } from '@tnp/crypto';
import {
  openRulesEnvelope,
  type RulesEnvelope,
  RulesEnvelopeError,
  rulesCiphertextDigest,
  sameRulesKey,
  unlockRulesKey,
} from '@tnp/crypto/dns-rules';
import {
  describeDnsRuleTarget,
  type DnsRule,
  type DnsRulesRecord,
  type IsNativeName,
  parseDnsRuleSet,
  parseDnsRulesRecord,
  type RejectedDnsRule,
} from '@tnp/shared-types';
import { personalRulesPath, systemStateDir } from './config';
import { formatActiveRulesFile } from './dns-rules';
import { ensurePrivateDir, restrictWindowsAcl, writeFileAtomic } from './secure-fs';

export interface RulesPaths {
  /** Root-only directory for the key, the rollback record and approvals. */
  secretDir: string;
  /** The active rules file the resolver reads. */
  activeFile: string;
}

export function defaultRulesPaths(): RulesPaths {
  return {
    secretDir: join(systemStateDir(), 'dns-rules'),
    activeFile: personalRulesPath(),
  };
}

type Redirect = Extract<DnsRule, { type: 'redirect' }>;

/** Refusals a person can act on. The message says what to do. */
export class RulesStoreError extends Error {
  constructor(
    readonly code:
      | 'no-key'
      | 'other-account'
      | 'needs-passphrase'
      | 'wrong-passphrase'
      | 'tampered'
      | 'rollback'
      | 'fork'
      | 'malformed'
      | 'nothing-pulled',
    message: string,
  ) {
    super(message);
    this.name = 'RulesStoreError';
  }
}

interface StoredKey {
  v: 1;
  userId: string;
  rulesKey: string;
}

interface StoredState {
  v: 1;
  userId: string;
  /** Highest rule-set version accepted with the current key. */
  highestVersion: number;
  /** SHA-256 of that version's ciphertext: the same version with other bytes is a fork. */
  ciphertextDigest: string;
  /** Approved redirects on this device: name → the target approved, as `describeDnsRuleTarget`. */
  approvals: Record<string, string>;
}

const KEY_FILE = 'key.json';
const STATE_FILE = 'state.json';
const ENVELOPE_FILE = 'envelope.json';

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function loadKey(paths: RulesPaths): { userId: string; rulesKey: Uint8Array } | null {
  const raw = readJson(join(paths.secretDir, KEY_FILE)) as Partial<StoredKey> | null;
  if (!raw) return null;
  if (raw.v !== 1 || typeof raw.userId !== 'string' || typeof raw.rulesKey !== 'string') {
    throw new RulesStoreError(
      'malformed',
      `${join(paths.secretDir, KEY_FILE)} is not a TNP rules key`,
    );
  }
  return { userId: raw.userId, rulesKey: decodeBase64Strict(raw.rulesKey, 32) };
}

function loadState(paths: RulesPaths): StoredState | null {
  const raw = readJson(join(paths.secretDir, STATE_FILE)) as Partial<StoredState> | null;
  if (!raw) return null;
  if (
    raw.v !== 1 ||
    typeof raw.userId !== 'string' ||
    !Number.isSafeInteger(raw.highestVersion) ||
    typeof raw.ciphertextDigest !== 'string' ||
    typeof raw.approvals !== 'object' ||
    raw.approvals === null
  ) {
    throw new RulesStoreError(
      'malformed',
      `${join(paths.secretDir, STATE_FILE)} is not TNP rules state`,
    );
  }
  return raw as StoredState;
}

function loadEnvelope(paths: RulesPaths): DnsRulesRecord | null {
  const raw = readJson(join(paths.secretDir, ENVELOPE_FILE));
  if (!raw) return null;
  const parsed = parseDnsRulesRecord(raw);
  if (!parsed.ok) {
    throw new RulesStoreError(
      'malformed',
      `${join(paths.secretDir, ENVELOPE_FILE)}: ${parsed.error}`,
    );
  }
  return parsed.value;
}

function writeSecret(paths: RulesPaths, file: string, value: unknown): void {
  ensurePrivateDir(paths.secretDir);
  writeFileAtomic(join(paths.secretDir, file), `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * Write the active rules file so the resolver daemon can read it and nobody
 * else can: on Linux, in a config directory root owns with the service group
 * (`tnp install` makes `/etc/tnp` root:tnp 0750), the file is root:tnp 0640.
 */
function writeActiveFile(paths: RulesPaths, body: string): void {
  const dir = join(paths.activeFile, '..');
  if (!existsSync(dir)) {
    ensurePrivateDir(dir);
  } else if (process.platform === 'win32') {
    restrictWindowsAcl(dir, 'admin-only');
  }
  if (process.platform === 'win32') {
    writeFileAtomic(paths.activeFile, body);
    return;
  }
  const st = statSync(dir);
  const serviceGroup =
    process.platform === 'linux' && st.uid === 0 && st.gid !== 0 && process.geteuid?.() === 0
      ? st.gid
      : undefined;
  writeFileAtomic(
    paths.activeFile,
    body,
    serviceGroup === undefined ? { mode: 0o600 } : { mode: 0o640, gid: serviceGroup },
  );
}

/** What a pulled rule set means on this device. */
export interface RulesView {
  version: number;
  userId: string;
  /** Rules in force: every block and the approved redirects. */
  active: DnsRule[];
  /** Redirects awaiting `tnp rules approve` (new, or whose target changed since approval). */
  pending: Redirect[];
  /** Rules in the set that can never apply here (e.g. a redirect of a native name). */
  rejected: RejectedDnsRule[];
}

function decryptRules(
  rulesKey: Uint8Array,
  record: DnsRulesRecord,
  minVersion: number,
  isNative: IsNativeName,
): { rules: DnsRule[]; rejected: RejectedDnsRule[] } {
  const body = openRulesEnvelope({
    rulesKey,
    userId: record.userId,
    envelope: record as RulesEnvelope,
    minVersion,
  });
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new RulesStoreError('malformed', 'the decrypted rule set is not JSON');
  }
  const parsed = parseDnsRuleSet(json, isNative);
  if (!parsed.ok)
    throw new RulesStoreError('malformed', `the decrypted rule set is invalid: ${parsed.error}`);
  return parsed.value;
}

function viewOf(
  record: DnsRulesRecord,
  decrypted: { rules: DnsRule[]; rejected: RejectedDnsRule[] },
  approvals: Record<string, string>,
): RulesView {
  const active: DnsRule[] = [];
  const pending: Redirect[] = [];
  for (const rule of decrypted.rules) {
    if (rule.type === 'block') active.push(rule);
    else if (approvals[rule.name] === describeDnsRuleTarget(rule.target)) active.push(rule);
    else pending.push(rule);
  }
  return {
    version: record.version,
    userId: record.userId,
    active,
    pending,
    rejected: decrypted.rejected,
  };
}

function translate(err: unknown): never {
  if (err instanceof RulesEnvelopeError) {
    switch (err.code) {
      case 'rollback':
        throw new RulesStoreError('rollback', err.message);
      case 'wrong-passphrase':
        throw new RulesStoreError('wrong-passphrase', 'wrong sync passphrase');
      case 'tampered':
        throw new RulesStoreError('tampered', err.message);
      default:
        throw new RulesStoreError('malformed', err.message);
    }
  }
  throw err;
}

export interface PullResult {
  view: RulesView;
  /** The server held a rule set made with a different key (the user reset it with a new passphrase). */
  reset: boolean;
  /** Approvals dropped because the redirect is gone or now points elsewhere. */
  droppedApprovals: string[];
}

/**
 * Accept a rule set fetched from the API, decrypt it, and rewrite the active
 * rules file.
 *
 * With a stored key no passphrase is needed. `askPassphrase` is called only
 * when there is no stored key, or the stored key no longer opens the set
 * (it was re-created under a new passphrase); a set that the passphrase
 * opens with the SAME key as before is tampering, not a reset.
 *
 * Refused, before anything is written: a version lower than the highest
 * already accepted (rollback), the same version with different bytes (a
 * forked history), and a set belonging to another account.
 */
export async function acceptPulledRules(options: {
  paths: RulesPaths;
  record: DnsRulesRecord;
  isNative: IsNativeName;
  askPassphrase: (() => Promise<string>) | null;
  forcePassphrase?: boolean;
}): Promise<PullResult> {
  const { paths, record, isNative, askPassphrase } = options;
  const stored = loadKey(paths);
  const state = loadState(paths);

  if (stored && stored.userId !== record.userId) {
    throw new RulesStoreError(
      'other-account',
      'the stored rules key belongs to another Oxy account; run `tnp rules forget` first',
    );
  }

  let rulesKey: Uint8Array | null = null;
  let reset = false;
  let decrypted: { rules: DnsRule[]; rejected: RejectedDnsRule[] } | null = null;
  const minVersion = state && state.userId === record.userId ? state.highestVersion : 0;

  if (stored && !options.forcePassphrase) {
    // Decrypt first, compare versions after: a set made with a different key
    // (a reset) must fail as "does not open", not as a rollback of a version
    // number that belonged to the old key.
    try {
      decrypted = decryptRules(stored.rulesKey, record, 0, isNative);
      rulesKey = stored.rulesKey;
    } catch (err) {
      if (!(err instanceof RulesEnvelopeError) || err.code !== 'tampered') translate(err);
    }
    if (decrypted && record.version < minVersion) {
      throw new RulesStoreError(
        'rollback',
        `the server offered rule set version ${record.version}, older than version ${minVersion} already accepted; refusing it`,
      );
    }
  }

  if (!decrypted) {
    if (!askPassphrase) {
      throw new RulesStoreError(
        stored ? 'needs-passphrase' : 'no-key',
        stored
          ? 'the stored key no longer opens your rule set (it was altered, or re-created with a new passphrase); rerun with your sync passphrase'
          : 'this device has no rules key yet; run `tnp rules pull` with your sync passphrase',
      );
    }
    let unlocked: Uint8Array;
    try {
      unlocked = unlockRulesKey({
        passphrase: await askPassphrase(),
        userId: record.userId,
        envelope: record as RulesEnvelope,
      });
    } catch (err) {
      translate(err);
    }
    reset = stored !== null && !sameRulesKey(unlocked, stored.rulesKey);
    if (stored && !reset && !options.forcePassphrase) {
      // The passphrase gives the same key that just failed: the set was altered.
      throw new RulesStoreError(
        'tampered',
        'the rule set on the server does not decrypt: it was altered',
      );
    }
    try {
      decrypted = decryptRules(unlocked, record, reset ? 0 : minVersion, isNative);
    } catch (err) {
      translate(err);
    }
    rulesKey = unlocked;
  }

  const digest = rulesCiphertextDigest(record as RulesEnvelope);
  if (
    !reset &&
    state &&
    state.userId === record.userId &&
    record.version === state.highestVersion
  ) {
    if (digest !== state.ciphertextDigest) {
      throw new RulesStoreError(
        'fork',
        `the server offered a different rule set under version ${record.version}, which this device already accepted; refusing it`,
      );
    }
  }

  // Approvals survive only for redirects that still exist with the same target.
  const previous = reset || !state ? {} : state.approvals;
  const approvals: Record<string, string> = {};
  const droppedApprovals: string[] = [];
  const current = new Map(
    decrypted.rules.filter((r): r is Redirect => r.type === 'redirect').map((r) => [r.name, r]),
  );
  for (const [name, target] of Object.entries(previous)) {
    const rule = current.get(name);
    if (rule && describeDnsRuleTarget(rule.target) === target) approvals[name] = target;
    else droppedApprovals.push(name);
  }

  const view = viewOf(record, decrypted, approvals);
  if (!rulesKey) throw new RulesStoreError('no-key', 'no rules key');
  writeSecret(paths, KEY_FILE, {
    v: 1,
    userId: record.userId,
    rulesKey: encodeBase64(rulesKey),
  } satisfies StoredKey);
  writeSecret(paths, ENVELOPE_FILE, record);
  writeSecret(paths, STATE_FILE, {
    v: 1,
    userId: record.userId,
    highestVersion: record.version,
    ciphertextDigest: digest,
    approvals,
  } satisfies StoredState);
  writeActiveFile(
    paths,
    formatActiveRulesFile({
      version: view.version,
      pending: view.pending.length,
      rules: view.active,
    }),
  );
  return { view, reset, droppedApprovals };
}

/** The last accepted rule set as it applies on this device, decrypted with the stored key. */
export function currentRulesView(paths: RulesPaths, isNative: IsNativeName): RulesView | null {
  const stored = loadKey(paths);
  const record = loadEnvelope(paths);
  const state = loadState(paths);
  if (!stored || !record || !state) return null;
  try {
    return viewOf(record, decryptRules(stored.rulesKey, record, 0, isNative), state.approvals);
  } catch (err) {
    translate(err);
  }
}

/**
 * Record approval of pending redirects on this device and rewrite the active
 * file. Only redirects that are pending right now can be approved; the
 * approval pins the exact target, so a later change needs approving again.
 */
export function approveRedirects(
  paths: RulesPaths,
  names: readonly string[],
  isNative: IsNativeName,
): RulesView {
  const view = currentRulesView(paths, isNative);
  const state = loadState(paths);
  if (!view || !state)
    throw new RulesStoreError('nothing-pulled', 'no rule set pulled yet; run `tnp rules pull`');
  const pending = new Map(view.pending.map((r) => [r.name, r]));
  for (const name of names) {
    const rule = pending.get(name);
    if (!rule) throw new RulesStoreError('malformed', `${name} is not a pending redirect`);
    state.approvals[name] = describeDnsRuleTarget(rule.target);
  }
  writeSecret(paths, STATE_FILE, state);
  return rewriteActive(paths, isNative);
}

/** Withdraw this device's approval of a redirect; it stops applying at once. */
export function revokeRedirect(paths: RulesPaths, name: string, isNative: IsNativeName): RulesView {
  const state = loadState(paths);
  if (!state)
    throw new RulesStoreError('nothing-pulled', 'no rule set pulled yet; run `tnp rules pull`');
  if (!(name in state.approvals))
    throw new RulesStoreError('malformed', `${name} is not an approved redirect`);
  delete state.approvals[name];
  writeSecret(paths, STATE_FILE, state);
  return rewriteActive(paths, isNative);
}

function rewriteActive(paths: RulesPaths, isNative: IsNativeName): RulesView {
  const view = currentRulesView(paths, isNative);
  if (!view)
    throw new RulesStoreError('nothing-pulled', 'no rule set pulled yet; run `tnp rules pull`');
  writeActiveFile(
    paths,
    formatActiveRulesFile({
      version: view.version,
      pending: view.pending.length,
      rules: view.active,
    }),
  );
  return view;
}

/** Remove the key, the state and the active file: no rule applies on this device afterwards. */
export function forgetRules(paths: RulesPaths): string[] {
  const removed: string[] = [];
  for (const path of [paths.activeFile, paths.secretDir]) {
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
      removed.push(path);
    }
  }
  return removed;
}
