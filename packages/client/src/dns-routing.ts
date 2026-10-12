/**
 * Operating-system DNS routing: send TNP-native names — and ONLY those — to
 * the local TNP resolver.
 *
 * What this replaces captured all of the machine's DNS. On Linux it put
 * `DNS=127.0.0.1` in the global systemd-resolved section and replaced the
 * default interface's servers with `resolvectl dns <iface> 127.0.0.1`; on
 * Windows it put 127.0.0.1 first on every adapter, and `tnp connect` replaced
 * every adapter's servers with the TNP public resolver plus 1.1.1.1. Every
 * public name the user looked up went through TNP, and uninstalling ran
 * `Set-DnsClientServerAddress -ResetServerAddresses`, which silently threw
 * away a user's own privacy resolver and reverted them to the ISP's.
 *
 * Every mechanism here is additive and self-contained: TNP adds its own
 * routing object, scoped to the native TLDs, and teardown removes exactly that
 * object. The user's global, per-link and per-adapter DNS settings are never
 * written, so there is nothing of theirs to restore — they are never touched.
 *
 * ## systemd-resolved: why a delegate or a dedicated link, never the global section
 *
 * resolved routes a query to the scopes whose routing domains match it best
 * (most labels). A query that matches NO routing domain goes to every link
 * that is a default route AND to the global DNS servers
 * (systemd-resolved.service(8), "Protocols and Routing"). So `DNS=127.0.0.1`
 * in `[Resolve]` with `Domains=~ox` does route `.ox` to TNP — and ALSO sends
 * every public name that matches nothing (all of them) to TNP in parallel with
 * the user's own servers. A global entry cannot be scoped. The two scoped
 * mechanisms resolved has are:
 *
 * 1. **DNS delegate** (systemd ≥ 258): `/etc/systemd/dns-delegate.d/*.dns-delegate`
 *    with `DNS=`, `Domains=~ox` and `DefaultRoute=no` (also the default). It
 *    synthesizes a scope independent of any interface that only ever receives
 *    `.ox` lookups. Preferred.
 * 2. **A dedicated dummy link** (older systemd): interface `tnp0` with the TNP
 *    server, routing domain `~ox` and default-route off, configured through
 *    `resolvectl`. resolved only creates a unicast scope for a link that is
 *    up, has carrier and has a routable address (`link_relevant()` in
 *    resolved-link.c), so the link gets `192.0.2.53/32` from TEST-NET-1
 *    (RFC 5737), which is never routed and cannot collide with a real
 *    network. Order matters: default-route is switched off and the routing
 *    domain set BEFORE the server is added, because a link with servers and
 *    no route-only domain is implicitly a default route, and for that instant
 *    it would receive public lookups.
 *
 * In both, `~ox` is route-only, never a search domain: a search domain would
 * turn a single-label lookup like `printer` into `printer.ox` and send it to
 * TNP.
 *
 * Without systemd-resolved there is no per-domain routing in the glibc stub
 * resolver, so nothing is changed and the user is told how to forward `.ox`
 * in their own resolver. Prepending a nameserver to /etc/resolv.conf — what
 * the old fallback did — is a capture of all DNS.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, win32 } from 'node:path';
import { BUILTIN_NATIVE_TLDS, isReservedTld } from '@tnp/namespace';
import { childEnv, windowsSystem32 } from './system-cmd';

/** The TLDs the OS routes to TNP. One source of truth: `@tnp/namespace`. */
export const ROUTED_TLDS: readonly string[] = BUILTIN_NATIVE_TLDS;

/** Where native-name queries are sent. */
export interface RoutingTarget {
  address: string;
  port: number;
}

/**
 * Who set the routing up. `tnp install` (the system service) and `tnp connect`
 * (a foreground session) each get their own delegate file, link and NRPT
 * comment, so disconnecting a session never removes the installed routing.
 */
export type RoutingOwner = 'install' | 'connect' | 'rules';

export interface OwnerNames {
  /** systemd-resolved DNS delegate file. */
  delegate: string;
  /** Dedicated resolved link, for systemd older than 258. */
  link: string;
  /** Address that makes the link "relevant" to resolved (TEST-NET-1, RFC 5737). */
  linkAddress: string;
  /** Comment identifying this owner's NRPT rules, so removal never touches others. */
  nrptComment: string;
}

export function ownerNames(owner: RoutingOwner): OwnerNames {
  switch (owner) {
    case 'install':
      return {
        delegate: '/etc/systemd/dns-delegate.d/tnp.dns-delegate',
        link: 'tnp0',
        linkAddress: '192.0.2.53/32',
        nrptComment: 'Managed by TNP',
      };
    case 'connect':
      return {
        delegate: '/etc/systemd/dns-delegate.d/tnp-connect.dns-delegate',
        link: 'tnp1',
        linkAddress: '192.0.2.54/32',
        nrptComment: 'Managed by TNP (connect)',
      };
    case 'rules':
      // Personal DNS rules (naming.md §3): the public names the user's active
      // rules cover, each by name — never a TLD — in its own routing object, so
      // syncing rules never touches the native-TLD routing above.
      return {
        delegate: '/etc/systemd/dns-delegate.d/tnp-rules.dns-delegate',
        link: 'tnp2',
        linkAddress: '192.0.2.55/32',
        nrptComment: 'Managed by TNP (personal rules)',
      };
  }
}

/** The global drop-in earlier versions wrote. Removed on sight. */
export const LEGACY_RESOLVED_DROPIN = '/etc/systemd/resolved.conf.d/tnp.conf';
/** First systemd release with `*.dns-delegate` support. */
export const DNS_DELEGATE_MIN_SYSTEMD = 258;
/**
 * TLDs that TNP versions before the namespace policy routed to the local
 * resolver on macOS. Only these are cleaned up, and only when the file points
 * at TNP's loopback resolver — `/etc/resolver/test` pointing at 127.0.0.1 is
 * what Laravel Valet and dnsmasq setups write, and is not ours to delete.
 */
export const LEGACY_MAC_RESOLVER_TLDS: readonly string[] = ['com', 'app'];

// ---------------------------------------------------------------------------
// Pure builders (unit-tested)
// ---------------------------------------------------------------------------

/** Parse `systemctl --version` output ("systemd 257 (257.13-1)") to 257. */
export function parseSystemdVersion(output: string): number | null {
  const match = /^systemd\s+(\d+)/m.exec(output);
  return match ? Number(match[1]) : null;
}

/** A DNS server in resolved's syntax: `127.0.0.1`, `127.0.0.1:5354`, `[::1]:5354`. */
export function resolvedServerSpec(target: RoutingTarget): string {
  if (target.port === 53) return target.address;
  const host = net.isIPv6(target.address) ? `[${target.address}]` : target.address;
  return `${host}:${target.port}`;
}

function routingDomains(tlds: readonly string[]): string {
  return tlds.map((tld) => `~${tld}`).join(' ');
}

function assertRoutable(tlds: readonly string[]): void {
  for (const tld of tlds) {
    if (!/^[a-z0-9-]+$/.test(tld) || isReservedTld(tld)) {
      throw new Error(`refusing to route .${tld} to TNP: not a TNP-native TLD`);
    }
  }
}

/** The systemd-resolved DNS delegate file (systemd ≥ 258). */
export function dnsDelegateFile(target: RoutingTarget, tlds: readonly string[] = ROUTED_TLDS) {
  assertRoutable(tlds);
  return [
    '# Written by TNP (tnp install / tnp connect). Routes TNP-native names, and',
    '# nothing else, to the local TNP resolver. Removed by tnp uninstall.',
    '[Delegate]',
    `DNS=${resolvedServerSpec(target)}`,
    `Domains=${routingDomains(tlds)}`,
    'DefaultRoute=no',
    '',
  ].join('\n');
}

/**
 * Shell commands that set up / tear down the dedicated `tnp0` link for
 * systemd-resolved older than 258. See the module comment for the ordering.
 */
export function resolvedLinkCommands(
  target: RoutingTarget,
  tlds: readonly string[] = ROUTED_TLDS,
  owner: RoutingOwner = 'install',
): { up: string[]; down: string[] } {
  assertRoutable(tlds);
  const { link, linkAddress } = ownerNames(owner);
  const domains = tlds.map((tld) => `"~${tld}"`).join(' ');
  return {
    up: [
      `ip link show ${link} >/dev/null 2>&1 || ip link add ${link} type dummy`,
      `ip link set ${link} up`,
      `resolvectl default-route ${link} false`,
      `resolvectl domain ${link} ${domains}`,
      `ip address replace ${linkAddress} dev ${link}`,
      `resolvectl dns ${link} ${resolvedServerSpec(target)}`,
    ],
    down: [`resolvectl revert ${link}`, `ip link delete ${link}`],
  };
}

/** `/etc/resolver/<tld>` contents on macOS (resolver(5)). */
export function macResolverFile(target: RoutingTarget): string {
  return `nameserver ${target.address}\nport ${target.port}\n`;
}

/** PowerShell that removes TNP's NRPT rules (and only those). */
export function windowsNrptRemoveScript(owner: RoutingOwner = 'install'): string {
  const { nrptComment } = ownerNames(owner);
  return [
    `Get-DnsClientNrptRule | Where-Object { $_.Comment -eq '${nrptComment}' } | Remove-DnsClientNrptRule -Force`,
    'Clear-DnsClientCache',
  ].join('; ');
}

/**
 * PowerShell that routes each native TLD to `server` with a Name Resolution
 * Policy Table rule. NRPT matches by namespace suffix (`.ox`) and leaves every
 * other name on the adapters' own servers. NRPT carries no port, so the
 * resolver must listen on 53 (`tnp install` sets that).
 */
export function windowsNrptAddScript(
  server: string,
  tlds: readonly string[] = ROUTED_TLDS,
  owner: RoutingOwner = 'install',
): string {
  assertRoutable(tlds);
  const { nrptComment } = ownerNames(owner);
  if (!net.isIP(server)) throw new Error(`NRPT name server must be an IP address: ${server}`);
  const add = tlds.map(
    (tld) =>
      `Add-DnsClientNrptRule -Namespace '.${tld}' -NameServers '${server}' -Comment '${nrptComment}'`,
  );
  return [
    `Get-DnsClientNrptRule | Where-Object { $_.Comment -eq '${nrptComment}' } | Remove-DnsClientNrptRule -Force`,
    ...add,
    'Clear-DnsClientCache',
  ].join('; ');
}

/** PowerShell printing every adapter's IPv4 DNS servers as JSON. */
export function windowsAdapterSnapshotScript(): string {
  return 'Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceIndex,InterfaceAlias,ServerAddresses | ConvertTo-Json -Compress';
}

/**
 * PowerShell undoing what an EARLIER TNP install did to adapters: it put
 * `address` first in every adapter's server list. Only that entry is removed;
 * the user's own servers stay exactly as they were. An adapter left with no
 * servers was on DHCP-assigned DNS before, and is reset to it.
 */
export function windowsLegacyAdapterRepairScript(address: string): string {
  if (!net.isIP(address)) throw new Error(`not an IP address: ${address}`);
  return [
    'Get-DnsClientServerAddress -AddressFamily IPv4 | ForEach-Object {',
    `  if ($_.ServerAddresses -contains '${address}') {`,
    `    $rest = @($_.ServerAddresses | Where-Object { $_ -ne '${address}' })`,
    '    if ($rest.Count -gt 0) { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ServerAddresses $rest }',
    '    else { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses }',
    '  }',
    '}',
  ].join('\n');
}

/**
 * `powershell -EncodedCommand`: no cmd.exe quoting of `$`, `'` or `"` to get
 * wrong. Windows PowerShell by its System32 path, never whatever `powershell`
 * the elevated caller's PATH finds first (system-cmd.ts).
 */
export function powershellCommand(
  script: string,
  powershell: string = win32.join(windowsSystem32(), 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return `"${powershell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

// ---------------------------------------------------------------------------
// State: what TNP added, so teardown removes exactly that
// ---------------------------------------------------------------------------

export type RoutingMechanism =
  | 'dns-delegate'
  | 'resolved-link'
  | 'macos-resolver'
  | 'windows-nrpt'
  | 'none';

export interface RoutingState {
  version: 1;
  owner: RoutingOwner;
  mechanism: RoutingMechanism;
  target: RoutingTarget | null;
  tlds: string[];
  /** Files TNP wrote. */
  files: string[];
  /** Pre-existing content of a file TNP overwrote, restored on teardown. */
  backups: Record<string, string>;
  /**
   * What TNP wrote to each file. Teardown leaves a file alone if it no longer
   * holds this — another owner (an install vs a connect session sharing
   * `/etc/resolver/ox` on macOS) or another tool has replaced it since.
   */
  written?: Record<string, string>;
  /** Commands that undo `resolved-link`, when TNP ran them itself. */
  down: string[];
  /** Adapter DNS before a legacy repair, kept for the record (Windows). */
  adapterSnapshot?: string;
  /** Owner `rules` only: the public names routed, and whether each covers its subdomains. */
  routes?: RuleRoute[];
}

export interface RoutingDeps {
  platform: NodeJS.Platform;
  run(cmd: string): string;
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, content: string): void;
  remove(path: string): void;
  log(message: string): void;
  warn(message: string): void;
}

export const systemDeps: RoutingDeps = {
  platform: process.platform,
  run: (cmd) => execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', env: childEnv() }),
  exists: (path) => existsSync(path),
  read: (path) => readFileSync(path, 'utf-8'),
  write: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { mode: 0o644 });
  },
  remove: (path) => {
    try {
      unlinkSync(path);
    } catch {
      /* already gone */
    }
  },
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
};

export function routingStatePath(dataDirectory: string, owner: RoutingOwner): string {
  return join(dataDirectory, `dns-routing-${owner}.json`);
}

export function readRoutingState(
  path: string,
  deps: RoutingDeps = systemDeps,
): RoutingState | null {
  try {
    if (!deps.exists(path)) return null;
    const parsed = JSON.parse(deps.read(path)) as RoutingState;
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

function tryRun(deps: RoutingDeps, cmd: string): boolean {
  try {
    deps.run(cmd);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Apply / remove
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  target: RoutingTarget;
  owner: RoutingOwner;
  /**
   * `true` when a systemd unit will run the `tnp0` link commands itself
   * (ExecStartPost), so they survive reboots; the plan is returned for the
   * unit and nothing is run here.
   */
  linkCommandsInUnit?: boolean;
  tlds?: readonly string[];
}

export interface ApplyResult {
  state: RoutingState;
  /** For `resolved-link` with `linkCommandsInUnit`: the commands for the unit. */
  unitLink?: { up: string[]; down: string[] };
}

/** Route the native TLDs to `target`. Never touches the user's own DNS settings. */
export function applyNativeRouting(
  options: ApplyOptions,
  deps: RoutingDeps = systemDeps,
): ApplyResult {
  const tlds = [...(options.tlds ?? ROUTED_TLDS)];
  const { target, owner } = options;
  const names = ownerNames(owner);
  assertRoutable(tlds);
  const state: RoutingState = {
    version: 1,
    owner,
    mechanism: 'none',
    target,
    tlds,
    files: [],
    backups: {},
    written: {},
    down: [],
  };
  const where = tlds.map((t) => `.${t}`).join(' ');

  switch (deps.platform) {
    case 'darwin': {
      removeLegacyMacResolverFiles(deps);
      const content = macResolverFile(target);
      for (const tld of tlds) {
        const path = `/etc/resolver/${tld}`;
        if (deps.exists(path)) {
          const existing = deps.read(path);
          if (existing !== content) state.backups[path] = existing;
        }
        deps.write(path, content);
        state.files.push(path);
        if (state.written) state.written[path] = content;
      }
      state.mechanism = 'macos-resolver';
      deps.log(
        `[tnp] DNS: ${where} -> ${target.address}:${target.port} via /etc/resolver; nothing else changed`,
      );
      return { state };
    }

    case 'win32': {
      if (target.port !== 53) {
        deps.warn(
          `[tnp] Windows NRPT cannot use port ${target.port}; .${tlds[0]} will not resolve until the resolver listens on 53`,
        );
      }
      deps.run(powershellCommand(windowsNrptAddScript(target.address, tlds, owner)));
      state.mechanism = 'windows-nrpt';
      deps.log(`[tnp] DNS: NRPT rule ${where} -> ${target.address}; adapter DNS servers unchanged`);
      return { state };
    }

    default: {
      removeLegacyResolvedDropin(deps);
      warnLegacyLinkCapture(deps);
      if (!deps.exists('/run/systemd/resolve')) {
        deps.warn(
          `[tnp] systemd-resolved is not running, and plain /etc/resolv.conf cannot route by domain. ` +
            `TNP did not change your DNS (prepending a nameserver would send ALL lookups to TNP). ` +
            `To resolve ${where}, forward it in your own resolver, e.g. dnsmasq: ` +
            `server=/${tlds[0]}/${target.address}#${target.port}`,
        );
        return { state };
      }

      let version: number | null = null;
      try {
        version = parseSystemdVersion(deps.run('systemctl --version'));
      } catch {
        version = null;
      }

      if (version !== null && version >= DNS_DELEGATE_MIN_SYSTEMD) {
        if (deps.exists(names.delegate)) {
          const existing = deps.read(names.delegate);
          if (!existing.startsWith('# Written by TNP')) state.backups[names.delegate] = existing;
        }
        const delegate = dnsDelegateFile(target, tlds);
        deps.write(names.delegate, delegate);
        state.files.push(names.delegate);
        if (state.written) state.written[names.delegate] = delegate;
        tryRun(deps, 'systemctl try-reload-or-restart systemd-resolved');
        state.mechanism = 'dns-delegate';
        deps.log(
          `[tnp] DNS: systemd-resolved delegate ${where} -> ${resolvedServerSpec(target)}; nothing else changed`,
        );
        return { state };
      }

      const link = resolvedLinkCommands(target, tlds, owner);
      state.mechanism = 'resolved-link';
      if (options.linkCommandsInUnit) {
        deps.log(
          `[tnp] DNS: link ${names.link} routes ${where} -> ${resolvedServerSpec(target)} (set up by the service)`,
        );
        return { state, unitLink: link };
      }
      for (const cmd of link.up) deps.run(`sh -c '${cmd}'`);
      state.down = link.down;
      deps.log(
        `[tnp] DNS: link ${names.link} routes ${where} -> ${resolvedServerSpec(target)}; nothing else changed`,
      );
      return { state };
    }
  }
}

/**
 * Undo what an EARLIER TNP install did to Windows adapters (127.0.0.1
 * prepended to each), after recording every adapter's servers. Returns the
 * snapshot, for the state file.
 *
 * Only call this with evidence of such an install (its scheduled task exists
 * and no state file from this version does): 127.0.0.1 on an adapter is also
 * how dnscrypt-proxy, Acrylic and similar local privacy resolvers are set up,
 * and removing it from their users would send them back to the ISP.
 */
export function repairLegacyWindowsAdapters(deps: RoutingDeps = systemDeps): string | undefined {
  let snapshot: string | undefined;
  try {
    snapshot = deps.run(powershellCommand(windowsAdapterSnapshotScript())).trim();
  } catch {
    snapshot = undefined;
  }
  if (tryRun(deps, powershellCommand(windowsLegacyAdapterRepairScript('127.0.0.1')))) {
    deps.log('[tnp] removed the 127.0.0.1 entry an older TNP install added to network adapters');
  }
  return snapshot;
}

/** Undo exactly what `applyNativeRouting` recorded. */
export function removeNativeRouting(
  state: RoutingState | null,
  deps: RoutingDeps = systemDeps,
): void {
  if (state) {
    for (const path of state.files) {
      const ours = state.written?.[path];
      if (ours !== undefined && deps.exists(path)) {
        let current: string | null = null;
        try {
          current = deps.read(path);
        } catch {
          current = null;
        }
        if (current !== ours) {
          deps.log(`[tnp] left ${path} alone: it was changed after TNP wrote it`);
          continue;
        }
      }
      const backup = state.backups[path];
      if (backup !== undefined) deps.write(path, backup);
      else deps.remove(path);
    }
    for (const cmd of state.down) tryRun(deps, cmd);
    if (state.mechanism === 'windows-nrpt') {
      tryRun(deps, powershellCommand(windowsNrptRemoveScript(state.owner ?? 'install')));
    }
    if (state.mechanism === 'dns-delegate') {
      tryRun(deps, 'systemctl try-reload-or-restart systemd-resolved');
    }
  }

  // Leftovers from earlier versions, which recorded nothing.
  if (deps.platform === 'darwin') removeLegacyMacResolverFiles(deps);
  if (deps.platform === 'linux') removeLegacyResolvedDropin(deps);
}

/**
 * Interfaces whose resolved DNS servers include 127.0.0.1, from
 * `resolvectl dns` output — the mark an earlier TNP release left when it ran
 * `resolvectl dns <iface> 127.0.0.1`. TNP's own `tnp0`/`tnp1` are excluded.
 */
export function legacyCapturedLinks(resolvectlDnsOutput: string): string[] {
  const links: string[] = [];
  for (const line of resolvectlDnsOutput.split('\n')) {
    const match = /^Link \d+ \(([^)]+)\):\s*(.*)$/.exec(line.trim());
    if (!match || /^tnp\d$/.test(match[1])) continue;
    if (match[2].split(/\s+/).some((server) => /^127\.0\.0\.1(:53)?(#.*)?$/.test(server))) {
      links.push(match[1]);
    }
  }
  return links;
}

/**
 * Tell the user about a link an earlier release captured. Not repaired
 * automatically: the servers it replaced were never recorded, and
 * `resolvectl revert` also drops what NetworkManager pushed until the
 * connection is re-established — the user has to choose when to do that.
 */
function warnLegacyLinkCapture(deps: RoutingDeps): void {
  let output: string;
  try {
    output = deps.run('resolvectl dns');
  } catch {
    return;
  }
  for (const link of legacyCapturedLinks(output)) {
    deps.warn(
      `[tnp] interface ${link} sends all DNS to 127.0.0.1. If an older TNP release set that (it ran "resolvectl dns <iface> 127.0.0.1"), ` +
        `restore your network's own DNS with: sudo resolvectl revert ${link}, then reconnect ${link}`,
    );
  }
}

function removeLegacyResolvedDropin(deps: RoutingDeps): void {
  if (!deps.exists(LEGACY_RESOLVED_DROPIN)) return;
  deps.remove(LEGACY_RESOLVED_DROPIN);
  tryRun(deps, 'systemctl try-reload-or-restart systemd-resolved');
  deps.log(
    `[tnp] removed ${LEGACY_RESOLVED_DROPIN}: it put TNP in resolved's global section, which sends every public lookup to TNP`,
  );
}

/**
 * Delete `/etc/resolver` entries an earlier version wrote for public TLDs.
 *
 * Upgrades must repair the machine, not merely stop making it worse: a user who
 * installed before the namespace policy has `/etc/resolver/com` on disk, and
 * until it is removed every `.com` lookup on that Mac still goes to TNP.
 */
export function removeLegacyMacResolverFiles(deps: RoutingDeps = systemDeps): void {
  for (const tld of LEGACY_MAC_RESOLVER_TLDS) {
    const path = `/etc/resolver/${tld}`;
    if (!deps.exists(path)) continue;
    let content: string;
    try {
      content = deps.read(path);
    } catch {
      continue;
    }
    // Only a file pointing at TNP's loopback resolver is ours.
    if (!/^nameserver 127\.0\.0\.1$/m.test(content)) continue;
    deps.remove(path);
    deps.log(`[tnp] removed ${path}: .${tld} is public DNS, not TNP's`);
  }
}

// ---------------------------------------------------------------------------
// Per-name routing for personal DNS rules (owner `rules`)
// ---------------------------------------------------------------------------

/**
 * One public name a device's active personal rules cover: an approved
 * redirect, or a block. `subtree` is set for a block that covers subdomains.
 */
export interface RuleRoute {
  name: string;
  subtree: boolean;
}

const RULE_NAME_RE =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Throw unless every route is a multi-label LDH name that is not under a
 * native TLD. These names reach config files and shell commands, so the check
 * is here, at the last step, whatever the caller validated before.
 */
function assertRuleRoutes(routes: readonly RuleRoute[]): void {
  for (const { name } of routes) {
    if (!RULE_NAME_RE.test(name) || /^[0-9.]+$/.test(name)) {
      throw new Error('refusing to route a personal rule: not a multi-label domain name');
    }
    const tld = name.slice(name.lastIndexOf('.') + 1);
    if (ROUTED_TLDS.includes(tld)) {
      throw new Error(
        'refusing to route a TNP-native name as a personal rule: it is already routed',
      );
    }
  }
}

/** The routes in a stable order, one per name (a subtree route wins). */
export function normalizeRuleRoutes(routes: readonly RuleRoute[]): RuleRoute[] {
  const byName = new Map<string, boolean>();
  for (const r of routes) byName.set(r.name, (byName.get(r.name) ?? false) || r.subtree);
  return [...byName]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, subtree]) => ({ name, subtree }));
}

/**
 * The resolved delegate for personal rules. A routing domain `~name` covers
 * the name and everything under it; for an exact-name rule the extra names
 * reach the TNP resolver, which forwards them upstream unchanged.
 */
export function rulesDelegateFile(target: RoutingTarget, routes: readonly RuleRoute[]): string {
  assertRuleRoutes(routes);
  return [
    '# Written by TNP (tnp rules). Routes the public names your personal DNS',
    '# rules cover on this device, and nothing else, to the local TNP resolver.',
    '# Removed by tnp rules revoke/forget and tnp uninstall.',
    '[Delegate]',
    `DNS=${resolvedServerSpec(target)}`,
    `Domains=${routes.map((r) => `~${r.name}`).join(' ')}`,
    'DefaultRoute=no',
    '',
  ].join('\n');
}

/** The dedicated `tnp2` link for personal rules (systemd older than 258). */
export function rulesLinkCommands(
  target: RoutingTarget,
  routes: readonly RuleRoute[],
): { up: string[]; down: string[] } {
  assertRuleRoutes(routes);
  const { link, linkAddress } = ownerNames('rules');
  return {
    up: [
      `ip link show ${link} >/dev/null 2>&1 || ip link add ${link} type dummy`,
      `ip link set ${link} up`,
      `resolvectl default-route ${link} false`,
      `resolvectl domain ${link} ${routes.map((r) => `"~${r.name}"`).join(' ')}`,
      `ip address replace ${linkAddress} dev ${link}`,
      `resolvectl dns ${link} ${resolvedServerSpec(target)}`,
    ],
    down: [`resolvectl revert ${link}`, `ip link delete ${link}`],
  };
}

/**
 * NRPT rules for personal rules. A namespace without a leading dot is one
 * exact name; with one it is a suffix. A subtree rule gets both.
 */
export function windowsNrptRulesAddScript(server: string, routes: readonly RuleRoute[]): string {
  assertRuleRoutes(routes);
  if (!net.isIP(server)) throw new Error(`NRPT name server must be an IP address: ${server}`);
  const { nrptComment } = ownerNames('rules');
  const namespaces = routes.flatMap((r) => (r.subtree ? [r.name, `.${r.name}`] : [r.name]));
  return [
    `Get-DnsClientNrptRule | Where-Object { $_.Comment -eq '${nrptComment}' } | Remove-DnsClientNrptRule -Force`,
    ...namespaces.map(
      (ns) =>
        `Add-DnsClientNrptRule -Namespace '${ns}' -NameServers '${server}' -Comment '${nrptComment}'`,
    ),
    'Clear-DnsClientCache',
  ].join('; ');
}

/**
 * Route exactly `routes` to `target` (the installed resolver), as owner
 * `rules`, and return what was written. Teardown is `removeNativeRouting` on
 * the returned state. The caller removes any previous rules routing first.
 *
 * macOS: `/etc/resolver/<name>` per name. A file that already exists there
 * belongs to someone else (another tool or the user) and is never
 * overwritten: that name is skipped and reported.
 */
export function applyRuleRouting(
  options: { target: RoutingTarget; routes: readonly RuleRoute[] },
  deps: RoutingDeps = systemDeps,
): RoutingState {
  const routes = normalizeRuleRoutes(options.routes);
  const { target } = options;
  assertRuleRoutes(routes);
  const names = ownerNames('rules');
  const written: Record<string, string> = {};
  const routed: RuleRoute[] = [];
  const state: RoutingState = {
    version: 1,
    owner: 'rules',
    mechanism: 'none',
    target,
    tlds: [],
    files: [],
    backups: {},
    written,
    down: [],
    routes: routed,
  };
  if (routes.length === 0) return state;

  switch (deps.platform) {
    case 'darwin': {
      const content = macResolverFile(target);
      for (const route of routes) {
        const path = `/etc/resolver/${route.name}`;
        if (deps.exists(path)) {
          deps.warn(
            `[tnp] ${path} already exists and is not TNP's; left alone, so that rule does not reach the TNP resolver on this Mac`,
          );
          continue;
        }
        deps.write(path, content);
        state.files.push(path);
        written[path] = content;
        routed.push(route);
      }
      state.mechanism = 'macos-resolver';
      return state;
    }

    case 'win32': {
      if (target.port !== 53) {
        deps.warn(
          `[tnp] Windows NRPT cannot use port ${target.port}; personal rules are not routed`,
        );
        return state;
      }
      deps.run(powershellCommand(windowsNrptRulesAddScript(target.address, routes)));
      routed.push(...routes);
      state.mechanism = 'windows-nrpt';
      return state;
    }

    default: {
      if (!deps.exists('/run/systemd/resolve')) {
        deps.warn(
          '[tnp] systemd-resolved is not running, so personal rules for public names cannot be routed by name; ' +
            'point your DNS at the TNP resolver to use them',
        );
        return state;
      }
      let version: number | null = null;
      try {
        version = parseSystemdVersion(deps.run('systemctl --version'));
      } catch {
        version = null;
      }
      if (version !== null && version >= DNS_DELEGATE_MIN_SYSTEMD) {
        if (
          deps.exists(names.delegate) &&
          !deps.read(names.delegate).startsWith('# Written by TNP')
        ) {
          deps.warn(
            `[tnp] ${names.delegate} exists and is not TNP's; personal rules are not routed`,
          );
          return state;
        }
        const delegate = rulesDelegateFile(target, routes);
        deps.write(names.delegate, delegate);
        state.files.push(names.delegate);
        written[names.delegate] = delegate;
        tryRun(deps, 'systemctl try-reload-or-restart systemd-resolved');
        routed.push(...routes);
        state.mechanism = 'dns-delegate';
        return state;
      }
      const link = rulesLinkCommands(target, routes);
      for (const cmd of link.up) deps.run(`sh -c '${cmd}'`);
      state.down = link.down;
      routed.push(...routes);
      state.mechanism = 'resolved-link';
      deps.warn(
        `[tnp] this systemd (older than ${DNS_DELEGATE_MIN_SYSTEMD}) routes personal rules through link ${names.link}, which does not survive a reboot; run \`sudo tnp rules route\` after one`,
      );
      return state;
    }
  }
}
