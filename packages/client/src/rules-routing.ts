/**
 * Keep OS routing in step with the personal rules active on this device.
 *
 * Policy: docs/architecture/naming.md §3. With `tnp install` the OS sends the
 * local resolver only native TLDs, so a rule for `google.com` would never be
 * consulted. For every PUBLIC name the active rules cover — redirects the
 * user approved on this device, and blocks they pulled — the OS is told to
 * send that name (a block with subdomains: that name as a routing domain) to
 * the installed TNP resolver, and nothing else. Mechanisms and teardown are
 * `dns-routing.ts` (owner `rules`); what was written is recorded in
 * `<dataDir>/dns-routing-rules.json` so revoke, forget and uninstall remove
 * exactly that.
 *
 * Routing is installed only when `tnp install` set up the system resolver
 * (its routing record exists): pointing a name at a resolver that is not
 * running would make it stop resolving. A `tnp connect` session is never
 * used — it ends, and the names would go dark with it.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DnsRule } from '@tnp/shared-types';
import { dataDir } from './config';
import {
  applyRuleRouting,
  normalizeRuleRoutes,
  type RoutingDeps,
  type RoutingState,
  type RuleRoute,
  readRoutingState,
  removeNativeRouting,
  routingStatePath,
  systemDeps,
} from './dns-routing';
import { writeFileAtomic } from './secure-fs';

/** The routing record names rules, so it is written root-only (0600). */
export function writePrivateState(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileAtomic(path, body, { mode: 0o600 });
}

export interface RulesRoutingPaths {
  /** Where the `rules` routing record lives. */
  state: string;
  /** The `tnp install` routing record: its target is the resolver to use. */
  install: string;
}

export function defaultRulesRoutingPaths(): RulesRoutingPaths {
  return {
    state: routingStatePath(dataDir(), 'rules'),
    install: routingStatePath(dataDir(), 'install'),
  };
}

/** The routes for a set of active rules: public names only, native ones are routed already. */
export function routesForRules(
  active: readonly DnsRule[],
  isNative: (name: string) => boolean,
): RuleRoute[] {
  return normalizeRuleRoutes(
    active
      .filter((rule) => !isNative(rule.name))
      .map((rule) => ({ name: rule.name, subtree: rule.type === 'block' && rule.subdomains })),
  );
}

export type RulesRoutingOutcome =
  | { kind: 'unchanged'; routes: RuleRoute[] }
  | { kind: 'applied'; routes: RuleRoute[]; skipped: string[] }
  | { kind: 'removed' }
  | { kind: 'no-resolver'; pending: number };

function sameRoutes(a: readonly RuleRoute[] | undefined, b: readonly RuleRoute[]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b);
}

/**
 * Make the `rules` routing match `routes` exactly. Idempotent: nothing is
 * rewritten when the recorded routing already matches.
 */
export function syncRulesRouting(
  routes: readonly RuleRoute[],
  paths: RulesRoutingPaths = defaultRulesRoutingPaths(),
  deps: RoutingDeps = systemDeps,
  writeState: (path: string, body: string) => void = writePrivateState,
): RulesRoutingOutcome {
  const wanted = normalizeRuleRoutes(routes);
  const previous = readRoutingState(paths.state, deps);
  const install = readRoutingState(paths.install, deps);
  const target = install && install.mechanism !== 'none' ? install.target : null;

  if (
    previous &&
    target &&
    previous.target?.address === target.address &&
    previous.target?.port === target.port &&
    sameRoutes(previous.routes, wanted) &&
    wanted.length > 0
  ) {
    return { kind: 'unchanged', routes: wanted };
  }

  if (previous) removeRulesState(previous, paths, deps);
  if (wanted.length === 0) return { kind: 'removed' };
  if (!target) return { kind: 'no-resolver', pending: wanted.length };

  const state = applyRuleRouting({ target, routes: wanted }, deps);
  if (state.mechanism !== 'none') {
    writeState(paths.state, `${JSON.stringify(state, null, 2)}\n`);
  }
  const routed = new Set((state.routes ?? []).map((r) => r.name));
  return {
    kind: 'applied',
    routes: state.routes ?? [],
    skipped: wanted.filter((r) => !routed.has(r.name)).map((r) => r.name),
  };
}

function removeRulesState(state: RoutingState, paths: RulesRoutingPaths, deps: RoutingDeps): void {
  removeNativeRouting(state, deps);
  deps.remove(paths.state);
}

/** Remove whatever `rules` routing is recorded. Returns whether there was any. */
export function removeRulesRouting(
  paths: RulesRoutingPaths = defaultRulesRoutingPaths(),
  deps: RoutingDeps = systemDeps,
): boolean {
  const previous = readRoutingState(paths.state, deps);
  if (!previous) return false;
  removeRulesState(previous, paths, deps);
  return true;
}
