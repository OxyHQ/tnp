/**
 * `tnp rules` — pull, inspect and approve synced personal DNS rules on this
 * device. Policy: docs/architecture/naming.md §3; user guide: docs/dns-rules.mdx.
 *
 * Secrets never go on the command line: the Oxy token comes from `TNP_TOKEN`
 * or `--token-stdin`, the sync passphrase from the terminal (no echo) or
 * `--passphrase-stdin`. Only one of the two can use stdin.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_NATIVE_TLDS, classifyName, validateNativeTld } from '@tnp/namespace';
import { describeDnsRuleTarget, type DnsRule } from '@tnp/shared-types';
import { TnpApiClient } from './api';
import { dataDir, loadConfig, RESOLVER_TLD_CACHE } from './config';
import {
  acceptPulledRules,
  approveRedirects,
  currentRulesView,
  defaultRulesPaths,
  forgetRules,
  revokeRedirect,
  RulesStoreError,
  type RulesPaths,
  type RulesView,
} from './dns-rules-store';
import { resolveToken } from './token';

const USAGE = `
Usage:
  tnp rules pull [--passphrase] [--passphrase-stdin]
      Fetch your encrypted rules, decrypt them on this device and apply them.
      Needs TNP_TOKEN (or --token-stdin). The first pull asks for your sync
      passphrase; the rules key is then kept (root only) so later pulls do not.
      Block rules apply at once. Redirects wait for \`tnp rules approve\`.
  tnp rules status        Active, pending and refused rules on this device
  tnp rules approve [<name>... | --all] [--yes]
      Approve pending redirects. Each is shown and confirmed; --yes skips the
      prompt only for names given explicitly.
  tnp rules revoke <name> Stop applying an approved redirect on this device
  tnp rules forget        Delete the rules key, state and active rules file

Rules apply to lookups answered by this device's TNP resolver. With
\`tnp install\`, the system sends it only .ox names; point a device or router at
it (or use "Export for router" in the dashboard) for public names.
`;

function isNativeWith(tlds: Iterable<string>) {
  const table = [...tlds];
  return (name: string) => classifyName(name, table) === 'tnp-native';
}

/** Built-in native TLDs plus whatever the resolver last synced from the registry. */
export function loadNativeTlds(
  files: readonly string[] = [join(dataDir(), 'tlds.json'), RESOLVER_TLD_CACHE],
): string[] {
  const tlds = new Set<string>(BUILTIN_NATIVE_TLDS);
  for (const file of files) {
    try {
      const saved = JSON.parse(readFileSync(file, 'utf-8'));
      if (!Array.isArray(saved)) continue;
      for (const entry of saved) {
        if (typeof entry !== 'string') continue;
        const valid = validateNativeTld(entry);
        if (valid.ok) tlds.add(valid.tld);
      }
    } catch {
      // Absent or unreadable: built-ins only.
    }
  }
  return [...tlds];
}

/** Read a line from the terminal without echoing it. */
export async function readHiddenLine(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    throw new Error('no terminal to ask for the passphrase on; use --passphrase-stdin');
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const onData = (chunk: Buffer) => {
        for (const char of chunk.toString('utf-8')) {
          if (char === '\r' || char === '\n') {
            stdin.off('data', onData);
            process.stderr.write('\n');
            resolve(value);
            return;
          }
          if (char === '\u0003') {
            stdin.off('data', onData);
            process.stderr.write('\n');
            reject(new Error('cancelled'));
            return;
          }
          if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
          else value += char;
        }
      };
      stdin.on('data', onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

async function readVisibleLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  process.stderr.write(prompt);
  process.stdin.resume();
  try {
    return await new Promise<string>((resolve) => {
      process.stdin.once('data', (chunk: Buffer) => resolve(chunk.toString('utf-8').trim()));
    });
  } finally {
    process.stdin.pause();
  }
}

/** The words of a redirect's consent prompt (naming.md §3.4: names the exact name and what changes). */
export function approvalPrompt(rule: Extract<DnsRule, { type: 'redirect' }>): string {
  const what =
    rule.target.kind === 'name'
      ? `answer as an alias (CNAME) of ${rule.target.value}`
      : `answer ${rule.target.value}`;
  return [
    `Redirect ${rule.name} -> ${describeDnsRuleTarget(rule.target)}`,
    `  ${rule.name} is a public DNS name. Approving replaces its public meaning on this device:`,
    `  lookups answered by this device's TNP resolver will ${what} instead of what public DNS says.`,
  ].join('\n');
}

function formatRule(rule: DnsRule): string {
  return rule.type === 'block'
    ? `block     ${rule.name}${rule.subdomains ? ' (and subdomains)' : ''}`
    : `redirect  ${rule.name} -> ${describeDnsRuleTarget(rule.target)}`;
}

function printView(view: RulesView, paths: RulesPaths): void {
  console.log(`[tnp] personal DNS rules, version ${view.version}`);
  console.log(`[tnp] active (${view.active.length}):`);
  for (const rule of view.active) console.log(`        ${formatRule(rule)}`);
  if (view.pending.length > 0) {
    console.log(`[tnp] awaiting approval on this device (${view.pending.length}):`);
    for (const rule of view.pending) console.log(`        ${formatRule(rule)}`);
    console.log('[tnp] run `sudo tnp rules approve` to review them');
  }
  if (view.rejected.length > 0) {
    console.log(`[tnp] refused (${view.rejected.length}), never applied:`);
    for (const r of view.rejected) console.log(`        rule #${r.index + 1}: ${r.error}`);
  }
  console.log(`[tnp] active rules file: ${paths.activeFile}`);
}

function explain(err: unknown): string {
  if (err instanceof RulesStoreError) return err.message;
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'EACCES' || code === 'EPERM') {
    return 'permission denied: the rules key and active rules file are root-only; rerun with sudo (as Administrator on Windows)';
  }
  return err instanceof Error ? err.message : String(err);
}

async function cmdPull(argv: readonly string[], paths: RulesPaths): Promise<void> {
  const passphraseStdin = argv.includes('--passphrase-stdin');
  if (passphraseStdin && argv.includes('--token-stdin')) {
    throw new Error(
      '--token-stdin and --passphrase-stdin cannot both read stdin; pass the token in TNP_TOKEN',
    );
  }
  const token = await resolveToken({ argv, env: process.env, readStdin: () => Bun.stdin.text() });
  delete process.env.TNP_TOKEN;
  if (!token.ok) throw new Error(token.error);
  if (token.token === null) {
    throw new Error('an Oxy auth token is required: set TNP_TOKEN or pipe it to --token-stdin');
  }
  if (token.warning) console.warn(`[tnp] warning: ${token.warning}`);

  const api = new TnpApiClient(loadConfig().apiBaseUrl);
  const record = await api.getDnsRules(token.token);
  if (!record) {
    console.log(
      '[tnp] no personal DNS rules are stored for this account. Create them at https://tnp.network/dashboard/dns-rules',
    );
    return;
  }

  const askPassphrase = async () =>
    passphraseStdin
      ? (await Bun.stdin.text()).replace(/\r?\n$/, '')
      : readHiddenLine('Sync passphrase: ');

  const isNative = isNativeWith(loadNativeTlds());
  const result = await acceptPulledRules({
    paths,
    record,
    isNative,
    askPassphrase,
    forcePassphrase: argv.includes('--passphrase') || passphraseStdin,
  });

  if (result.reset) {
    console.log(
      '[tnp] your rule set was re-created with a new passphrase: approvals on this device were cleared',
    );
  }
  for (const name of result.droppedApprovals) {
    console.log(
      `[tnp] approval of ${name} withdrawn: the redirect was removed or now points elsewhere`,
    );
  }
  const blocks = result.view.active.filter((r) => r.type === 'block').length;
  console.log(
    `[tnp] pulled rule set version ${result.view.version}: ${blocks} block rule(s) active`,
  );
  if (result.view.pending.length > 0) {
    console.log(
      `[tnp] ${result.view.pending.length} redirect(s) awaiting approval: they do not apply until you run \`sudo tnp rules approve\``,
    );
  }
  if (result.view.rejected.length > 0) {
    console.log(`[tnp] ${result.view.rejected.length} rule(s) refused; see \`tnp rules status\``);
  }
  console.log(`[tnp] active rules file: ${paths.activeFile}`);
}

async function cmdApprove(argv: readonly string[], paths: RulesPaths): Promise<void> {
  const isNative = isNativeWith(loadNativeTlds());
  const view = currentRulesView(paths, isNative);
  if (!view)
    throw new RulesStoreError('nothing-pulled', 'no rule set pulled yet; run `tnp rules pull`');
  const named = argv.filter((a) => !a.startsWith('--'));
  // With no names (or --all) every pending redirect is shown and confirmed in turn.
  const yes = argv.includes('--yes');
  if (yes && named.length === 0) {
    throw new Error(
      '--yes needs the redirects named explicitly: tnp rules approve <name>... --yes',
    );
  }
  const candidates =
    named.length > 0 ? view.pending.filter((r) => named.includes(r.name)) : view.pending;
  const unknown = named.filter((n) => !view.pending.some((r) => r.name === n));
  for (const name of unknown) console.warn(`[tnp] ${name} is not a pending redirect`);
  if (candidates.length === 0) {
    console.log('[tnp] no redirects are awaiting approval');
    return;
  }

  const approved: string[] = [];
  for (const rule of candidates) {
    console.log(approvalPrompt(rule));
    if (yes) {
      approved.push(rule.name);
      continue;
    }
    if (!process.stdin.isTTY) {
      throw new Error('approval needs a terminal; or name the redirect and pass --yes');
    }
    const answer = (await readVisibleLine('Approve? [y/N] ')).toLowerCase();
    if (answer === 'y' || answer === 'yes') approved.push(rule.name);
    else console.log(`[tnp] ${rule.name} left pending`);
  }
  if (approved.length === 0) return;
  const after = approveRedirects(paths, approved, isNative);
  console.log(
    `[tnp] approved ${approved.length} redirect(s); ${after.pending.length} still pending`,
  );
  console.log(`[tnp] active rules file: ${paths.activeFile}`);
}

/** Entry point for `tnp rules <subcommand>`. Returns the process exit code. */
export async function runRulesCommand(
  argv: readonly string[],
  paths: RulesPaths = defaultRulesPaths(),
): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    switch (sub) {
      case 'pull':
        await cmdPull(rest, paths);
        return 0;
      case 'status':
      case 'list': {
        const view = currentRulesView(paths, isNativeWith(loadNativeTlds()));
        if (!view) {
          console.log('[tnp] no personal DNS rules on this device. Run `tnp rules pull`.');
          return 0;
        }
        printView(view, paths);
        return 0;
      }
      case 'approve':
      case 'pending':
        if (sub === 'pending') {
          const view = currentRulesView(paths, isNativeWith(loadNativeTlds()));
          for (const rule of view?.pending ?? []) console.log(formatRule(rule));
          if (!view?.pending.length) console.log('[tnp] no redirects are awaiting approval');
          return 0;
        }
        await cmdApprove(rest, paths);
        return 0;
      case 'revoke': {
        const name = rest.find((a) => !a.startsWith('--'));
        if (!name) throw new Error('usage: tnp rules revoke <name>');
        revokeRedirect(paths, name, isNativeWith(loadNativeTlds()));
        console.log(`[tnp] ${name} no longer redirects on this device`);
        return 0;
      }
      case 'forget': {
        const removed = forgetRules(paths);
        if (removed.length === 0) console.log('[tnp] nothing to forget');
        for (const path of removed) console.log(`[tnp] removed ${path}`);
        console.log(
          '[tnp] your rules stay encrypted on the server; delete them from the dashboard if you want them gone',
        );
        return 0;
      }
      default:
        console.log(USAGE);
        return sub === undefined || sub === 'help' || sub === '--help' ? 0 : 1;
    }
  } catch (err) {
    console.error(`[tnp] ${explain(err)}`);
    return 1;
  }
}
