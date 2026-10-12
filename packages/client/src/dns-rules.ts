/**
 * Personal DNS rules, as the local resolver applies them.
 *
 * Normative policy: docs/architecture/naming.md §3. This module is the
 * resolver half and holds no key and no crypto: it reads ONE human-readable
 * file — the decrypted, locally approved rule set that `tnp rules` writes —
 * and answers from it. The sandboxed daemon can read that file and nothing
 * else about the rules; the rules key stays in root's state directory
 * (`dns-rules-store.ts`).
 *
 * What a rule can do, checked again here whatever the file says:
 * - `block` answers NXDOMAIN for the name (and with `subdomains`, every name
 *   under it). NXDOMAIN rather than 0.0.0.0: it is the honest "this name does
 *   not exist here", it needs no address family, and with no SOA attached a
 *   downstream cache does not keep it, so removing the rule takes effect at
 *   once (RFC 2308 §5).
 * - `redirect` answers exactly one name with an address, or with a CNAME to
 *   another name resolved through the normal path. Never for a TNP-native
 *   name: the namespace is authoritative, so such a line is ignored at
 *   answer time even if it reached the file.
 *
 * The public resolver (`apps/dns-server`) never configures a rules file, so it
 * never applies personal rules.
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import dnsPacket from 'dns-packet';
import {
  type DnsRule,
  type DnsRuleTarget,
  normalizeRuleName,
  parseDnsRuleTargetInput,
} from '@tnp/shared-types';
import {
  type Answer,
  buildResponse,
  type DecodedPacket,
  decodeQuery,
  encode,
  type Packet,
  RCODE,
  type RcodeName,
  rcodeOf,
} from './dns/wire';

/** TTL on every rule answer: short, so a pulled or revoked rule takes effect quickly downstream. */
export const RULE_ANSWER_TTL = 30;

/** How often the rules file is re-checked for changes. */
const DEFAULT_CHECK_INTERVAL_MS = 2000;

/** Largest rules file read. Far above any real rule set (2000 rules × ~80 bytes). */
const MAX_RULES_FILE_BYTES = 1024 * 1024;

export interface PersonalRuleSnapshot {
  /** The rule-set version the file was written from. */
  version: number;
  /** Redirects pulled but not approved on this device (not in the file). */
  pending: number;
  /** Blocked name → whether its subdomains are blocked too. */
  blocks: Map<string, boolean>;
  /** Approved redirects, by exact name. */
  redirects: Map<string, DnsRuleTarget>;
}

export type PersonalRuleMatch = { kind: 'block' } | { kind: 'redirect'; target: DnsRuleTarget };

// ---------------------------------------------------------------------------
// The rules file
// ---------------------------------------------------------------------------

/**
 * The active rules file. One rule per line, in words, so `cat` is an audit:
 *
 *     version 7
 *     pending 1
 *     block tracker.example.net
 *     block-subdomains ads.example.com
 *     redirect google.com ipv4 192.168.1.10
 *     redirect media.example.org name nas.home.arpa
 */
export function formatActiveRulesFile(input: {
  version: number;
  pending: number;
  rules: readonly DnsRule[];
}): string {
  const sorted = [...input.rules].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const lines = [
    '# TNP personal DNS rules active on this device (docs/architecture/naming.md §3).',
    '# Written by `tnp rules pull` / `tnp rules approve`; edits are overwritten.',
    "# Applied only to lookups answered by this device's TNP resolver.",
    '# block: NXDOMAIN for the name. block-subdomains: also every name under it.',
    '# redirect: this exact name answers with the target, replacing its public meaning.',
    `version ${input.version}`,
    `pending ${input.pending}`,
  ];
  for (const rule of sorted.filter((r) => r.type === 'block')) {
    lines.push(`${rule.subdomains ? 'block-subdomains' : 'block'} ${rule.name}`);
  }
  for (const rule of sorted) {
    if (rule.type === 'redirect') {
      lines.push(`redirect ${rule.name} ${rule.target.kind} ${rule.target.value}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Parse the active rules file. Strict: one malformed line refuses the whole
 * file, because a line this code did not write means the file is not what
 * `tnp rules` left, and answering from part of it would be a guess.
 */
export function parseActiveRulesFile(
  text: string,
): { ok: true; snapshot: PersonalRuleSnapshot } | { ok: false; error: string } {
  const snapshot: PersonalRuleSnapshot = {
    version: 0,
    pending: 0,
    blocks: new Map(),
    redirects: new Map(),
  };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '' || line.startsWith('#')) continue;
    const words = line.split(/\s+/);
    const bad = { ok: false as const, error: `line ${i + 1} is not a rule this client wrote` };
    const nameOf = (raw: string | undefined) => {
      const parsed = normalizeRuleName(raw ?? '');
      return parsed.ok && parsed.name === raw ? parsed.name : null;
    };
    switch (words[0]) {
      case 'version':
      case 'pending': {
        if (words.length !== 2 || !/^\d{1,15}$/.test(words[1])) return bad;
        if (words[0] === 'version') snapshot.version = Number(words[1]);
        else snapshot.pending = Number(words[1]);
        break;
      }
      case 'block':
      case 'block-subdomains': {
        const name = nameOf(words[1]);
        if (
          words.length !== 2 ||
          !name ||
          snapshot.blocks.has(name) ||
          snapshot.redirects.has(name)
        ) {
          return bad;
        }
        snapshot.blocks.set(name, words[0] === 'block-subdomains');
        break;
      }
      case 'redirect': {
        const name = nameOf(words[1]);
        const target = words.length === 4 ? parseDnsRuleTargetInput(words[3]) : null;
        if (
          !name ||
          !target ||
          target.kind !== words[2] ||
          target.value !== words[3] ||
          (target.kind === 'name' && target.value === name) ||
          snapshot.blocks.has(name) ||
          snapshot.redirects.has(name)
        ) {
          return bad;
        }
        snapshot.redirects.set(name, target);
        break;
      }
      default:
        return bad;
    }
  }
  return { ok: true, snapshot };
}

/**
 * The rule that decides `name`, if any.
 *
 * An exact-name rule wins over a block inherited from a parent. A redirect
 * for a TNP-native name is ignored (the namespace is authoritative), which
 * leaves any block that covers it in force.
 */
export function matchPersonalRule(
  snapshot: PersonalRuleSnapshot,
  name: string,
  isNative: (name: string) => boolean,
): PersonalRuleMatch | null {
  const target = snapshot.redirects.get(name);
  if (target && !isNative(name)) return { kind: 'redirect', target };
  if (snapshot.blocks.has(name)) return { kind: 'block' };
  const labels = name.split('.');
  // Rules never cover a single label (a TLD), so stop before it.
  for (let i = 1; i < labels.length - 1; i++) {
    if (snapshot.blocks.get(labels.slice(i).join('.')) === true) return { kind: 'block' };
  }
  return null;
}

/** One line for `tnp status`, read from the active file alone (no key needed). */
export function describeActiveRules(path: string): string | null {
  if (!existsSync(path)) return null;
  let snapshot: PersonalRuleSnapshot;
  try {
    const parsed = parseActiveRulesFile(readFileSync(path, 'utf-8'));
    if (!parsed.ok)
      return `personal DNS rules: ${path} is malformed (${parsed.error}); none applied`;
    snapshot = parsed.snapshot;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EACCES' || code === 'EPERM'
      ? `personal DNS rules: ${path} (rerun with sudo to read it)`
      : `personal DNS rules: ${path} is unreadable`;
  }
  const blocks = snapshot.blocks.size;
  const redirects = snapshot.redirects.size;
  const pending = snapshot.pending > 0 ? `, ${snapshot.pending} redirect(s) awaiting approval` : '';
  return `personal DNS rules: ${blocks} block, ${redirects} redirect active${pending} (version ${snapshot.version}) -- ${path}`;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface FileStat {
  uid: number;
  mode: number;
  size: number;
  mtimeMs: number;
  ino: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface PersonalRulesFileOptions {
  checkIntervalMs?: number;
  now?: () => number;
  lstat?: (path: string) => FileStat;
  readFile?: (path: string) => string;
  /** Effective uid; the file must be owned by root or by this uid. */
  euid?: number | undefined;
  platform?: NodeJS.Platform;
  warn?: (message: string) => void;
}

/**
 * The active rules file, re-read when it changes.
 *
 * Checked at most every `checkIntervalMs`. A file that is missing applies no
 * rules. A file that is a symlink, owned by another user, writable by group
 * or others, or malformed also applies no rules, and says why once: any of
 * those means someone other than `tnp rules` could have written it, and a
 * planted redirect is exactly what naming.md §3 forbids.
 */
export class PersonalRulesFile {
  private snapshot: PersonalRuleSnapshot | null = null;
  private lastCheck = Number.NEGATIVE_INFINITY;
  private signature = '';
  private readonly checkIntervalMs: number;
  private readonly now: () => number;
  private readonly lstat: (path: string) => FileStat;
  private readonly readFile: (path: string) => string;
  private readonly euid: number | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly warn: (message: string) => void;

  constructor(
    readonly path: string,
    options: PersonalRulesFileOptions = {},
  ) {
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.lstat = options.lstat ?? lstatSync;
    this.readFile = options.readFile ?? ((p) => readFileSync(p, 'utf-8'));
    this.euid = 'euid' in options ? options.euid : process.geteuid?.();
    this.platform = options.platform ?? process.platform;
    this.warn = options.warn ?? ((m) => console.warn(`[tnp] personal DNS rules: ${m}`));
  }

  /** The rules in force now, or null for none. */
  current(): PersonalRuleSnapshot | null {
    const now = this.now();
    if (now - this.lastCheck < this.checkIntervalMs) return this.snapshot;
    this.lastCheck = now;

    let st: FileStat;
    try {
      st = this.lstat(this.path);
    } catch {
      this.signature = '';
      this.snapshot = null;
      return null;
    }
    const signature = `${st.ino}:${st.size}:${st.mtimeMs}:${st.uid}:${st.mode}`;
    if (signature === this.signature) return this.snapshot;
    this.signature = signature;
    this.snapshot = this.load(st);
    return this.snapshot;
  }

  private load(st: FileStat): PersonalRuleSnapshot | null {
    // The file is read by path, never through a link someone else placed.
    if (st.isSymbolicLink() || !st.isFile()) {
      this.warn(`${this.path} is not a regular file; applying no rules`);
      return null;
    }
    if (this.platform !== 'win32') {
      if (st.uid !== 0 && st.uid !== this.euid) {
        this.warn(`${this.path} is owned by uid ${st.uid}, not root; applying no rules`);
        return null;
      }
      if ((st.mode & 0o022) !== 0) {
        this.warn(`${this.path} is writable by group or others; applying no rules`);
        return null;
      }
    }
    if (st.size > MAX_RULES_FILE_BYTES) {
      this.warn(`${this.path} is larger than ${MAX_RULES_FILE_BYTES} bytes; applying no rules`);
      return null;
    }
    let text: string;
    try {
      text = this.readFile(this.path);
    } catch (err) {
      this.warn(
        `could not read ${this.path} (${(err as NodeJS.ErrnoException).code ?? 'error'}); applying no rules`,
      );
      return null;
    }
    const parsed = parseActiveRulesFile(text);
    if (!parsed.ok) {
      // Never echo the line: it would put a rule (a name) in the log.
      this.warn(`${this.path}: ${parsed.error}; applying no rules`);
      return null;
    }
    return parsed.snapshot;
  }
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

export interface PersonalRuleDeps {
  /** Whether a name is TNP-native, from the resolver's TLD table. */
  isNative: (name: string) => boolean;
  /**
   * Resolve a query through the resolver's normal path (namespace split,
   * registry or upstream) and return the encoded response. Used for the
   * target of a CNAME-like redirect. Personal rules are not applied again,
   * so a redirect never chains into another rule and cannot loop.
   */
  resolve: (query: DecodedPacket) => Promise<Buffer>;
}

function rcodeName(code: number): RcodeName {
  const found = (Object.keys(RCODE) as RcodeName[]).find((key) => RCODE[key] === code);
  return found ?? 'SERVFAIL';
}

/**
 * Answer `query` from the personal rules, or return null when no rule
 * applies and the resolver should carry on as if they did not exist.
 */
export async function answerFromPersonalRules(
  rules: PersonalRulesFile | null,
  query: DecodedPacket,
  deps: PersonalRuleDeps,
): Promise<Packet | null> {
  const snapshot = rules?.current();
  const question = query.questions?.[0];
  if (!snapshot || !question) return null;
  if (snapshot.blocks.size === 0 && snapshot.redirects.size === 0) return null;

  const name = question.name.toLowerCase().replace(/\.$/, '');
  const match = matchPersonalRule(snapshot, name, deps.isNative);
  if (!match) return null;

  if (match.kind === 'block') return buildResponse(query, { rcode: 'NXDOMAIN' });

  const { target } = match;
  const type = question.type;
  if (target.kind === 'ipv4' || target.kind === 'ipv6') {
    const recordType = target.kind === 'ipv4' ? 'A' : 'AAAA';
    // Every other type is NODATA, so neither the other address family nor an
    // HTTPS/SVCB record with address hints can lead back to the public host.
    const answers: Answer[] =
      type === recordType || (type as string) === 'ANY'
        ? [{ type: recordType, name: question.name, ttl: RULE_ANSWER_TTL, data: target.value }]
        : [];
    return buildResponse(query, { rcode: 'NOERROR', answers });
  }

  const cname: Answer = {
    type: 'CNAME',
    name: question.name,
    ttl: RULE_ANSWER_TTL,
    data: target.value,
  };
  if (type === 'CNAME') return buildResponse(query, { rcode: 'NOERROR', answers: [cname] });

  const followUp = decodeQuery(
    encode({
      type: 'query',
      id: query.id ?? 0,
      flags: dnsPacket.RECURSION_DESIRED,
      questions: [{ name: target.value, type, class: 'IN' }],
    }),
  );
  let resolved: DecodedPacket;
  try {
    resolved = decodeQuery(await deps.resolve(followUp));
  } catch {
    return buildResponse(query, { rcode: 'SERVFAIL' });
  }
  return buildResponse(query, {
    rcode: rcodeName(rcodeOf(resolved)),
    answers: [cname, ...(resolved.answers ?? [])],
  });
}
