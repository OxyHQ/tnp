#!/usr/bin/env bun
import { mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { installAutoConnect, removeAutoConnect } from './autoconnect';
import {
  dataDir,
  loadConfig,
  loadResolverConfig,
  saveConfig,
  parsePrivacyLevel,
  type TnpConfig,
} from './config';
import {
  applyNativeRouting,
  readRoutingState,
  removeNativeRouting,
  routingStatePath,
  type RoutingState,
  type RoutingTarget,
} from './dns-routing';
import {
  describeKillSwitch,
  disableKillSwitch,
  enableKillSwitch,
  killSwitchAllow,
  killSwitchRecorded,
  upstreamsBlockedByKillSwitch,
} from './killswitch';
import { parseLocalTarget } from './parse-input';
import { DnsProxy } from './proxy';
import { installService, serviceStatus, stopService, startService, NATIVE_TLDS } from './service';
import { resolveToken } from './token';
import { affectedUsers, formatUninstallReport, performUninstall } from './uninstall';
import {
  currentReleasePlatform,
  decideUpdate,
  downloadVerifiedRelease,
  fetchLatestVersion,
  installBinaryAtomically,
  isCompiledBinary,
  ReleaseVerificationError,
} from './update';

const VERSION = '0.2.0';

function usage() {
  console.log(`
tnp v${VERSION} -- The Network Protocol resolver & overlay client

Usage:
  tnp run              Start the DNS resolver in the foreground
  tnp connect          Start overlay client (DNS proxy + SOCKS5 proxy)
  tnp serve            Start service node mode (serve a domain)
  tnp relay            Start a community relay (see apps/relay)
  tnp install          Install as a system service and configure DNS
  tnp uninstall        Remove the service, DNS configuration, kill-switch rules
                       and autoconnect; lists the data left on disk
  tnp uninstall --purge
                       Also delete that data: config, identity key, log, binary
  tnp update           Update to the latest version
  tnp status           Check if the resolver service is running
  tnp test <domain>    Test resolving a TNP domain
  tnp version          Print version
  tnp help             Show this help

Overlay commands:
  tnp connect [--privacy access]
    Starts both the DNS proxy and a SOCKS5 proxy. TNP domains with active
    service nodes are routed through encrypted tunnels via relay nodes.
    Privacy level "access" means one relay hop: the relay cannot read your
    traffic, but it sees your IP and which service you reach.
    Multi-hop "private" routing is not implemented yet and is rejected.

  tnp connect --killswitch
    Also blocks outbound plain DNS (UDP/TCP port 53, IPv4 and IPv6) to every
    address except loopback and the TNP resolver. Nothing else is blocked:
    it is not a full-traffic kill switch. Needs root/Administrator; if the
    rules cannot be fully applied, connect refuses to start.

  TNP_TOKEN=<token> tnp serve --domain <domain> [--target <host:port>] [--relay <wss://url>]
    Registers this machine as a service node for the given domain.
    Incoming connections are forwarded to the local target (default localhost:80).

  TNP_TOKEN=<token> tnp relay --endpoint <wss://url> [--port N] [--host addr]
            [--location label] [--max-connections N] [--bandwidth mbps]
    Runs a community relay and publishes it in the relay directory.
    --endpoint is the public URL other people's clients dial. It is not the
    bind address: --host/--port say where to listen, --endpoint says how the
    rest of the network reaches you through whatever name, port or TLS
    termination sits in front.

  Auth tokens: set TNP_TOKEN, or pipe the token to --token-stdin.
  --token <token> still works but is deprecated: other local users can read it
  from the process list, and it lands in shell history.

Config: /etc/tnp/config.json (or /usr/local/etc/tnp/config.json on macOS)
Docs:   https://tnp.network/install
`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdRun() {
  // The sandboxed service user cannot read config.json (it can hold tokens);
  // it gets the secret-free resolver.json instead.
  const config = loadResolverConfig();
  console.log(`[tnp] v${VERSION} starting...`);
  console.log(`[tnp] API: ${config.apiBaseUrl}`);
  console.log(`[tnp] upstream DNS: ${config.upstreamDns}`);

  const proxy = new DnsProxy(config);

  // Start the DNS proxy FIRST so upstream forwarding works immediately.
  // This is critical when system DNS points to us (127.0.0.1) — we need
  // to be able to forward non-TNP queries before syncing TLDs from the API.
  await proxy.start();

  // Now sync TLDs from the API. Native TLDs are already classified from the
  // built-in list, so a slow or failed sync never sends a native name upstream.
  await proxy.syncTlds().catch((err: unknown) => {
    console.warn(`[tnp] initial TLD sync failed, will retry: ${err}`);
  });

  proxy.startTldSync(5 * 60 * 1000);

  // Handle shutdown
  const shutdown = () => {
    console.log('\n[tnp] shutting down...');
    proxy.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdConnect() {
  const config = loadConfig();

  // Recover from a previous crash: a recorded kill switch may still be blocking DNS.
  if (killSwitchRecorded()) {
    console.log('[tnp] found kill-switch rules from a previous session, removing them...');
    if (!removeKillSwitch(config.publicDnsIp)) {
      // Connecting over stale rules would leave DNS blocked behind a session
      // that looks healthy. Stop and say so instead.
      console.error(
        '[tnp] not connecting while stale kill-switch rules may still block DNS. Rerun with sudo (as Administrator on Windows), or run `sudo tnp uninstall`.',
      );
      process.exit(1);
    }
  }

  // Parse --privacy flag
  const privacyIdx = process.argv.indexOf('--privacy');
  if (privacyIdx !== -1) {
    const result = parsePrivacyLevel(String(process.argv[privacyIdx + 1]));
    if (!result.ok) {
      console.error(`[tnp] ${result.error}`);
      process.exit(1);
    }
    config.privacyLevel = result.level;
  }

  // Parse --autoconnect flag
  if (process.argv.includes('--autoconnect')) {
    try {
      installAutoConnect();
      // Recorded only once it exists, so the flag never claims an autostart
      // that registration failed to create.
      config.autoConnect = true;
      saveConfig(config);
      console.log(`[tnp] autoconnect enabled — TNP will connect on startup`);
    } catch (err) {
      console.error(`[tnp] autoconnect setup failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Parse --killswitch flag
  if (process.argv.includes('--killswitch')) {
    config.killSwitch = true;
  }

  // Parse --no-autoconnect / --no-killswitch
  if (process.argv.includes('--no-autoconnect')) {
    const removal = removeAutoConnect(affectedUsers());
    if (removal.failed.length > 0) {
      console.error(`[tnp] autoconnect could not be removed: ${removal.failed.join('; ')}`);
    } else {
      config.autoConnect = false;
      saveConfig(config);
      console.log(`[tnp] autoconnect disabled`);
    }
  }
  if (process.argv.includes('--no-killswitch')) {
    config.killSwitch = false;
  }

  console.log(`[tnp] v${VERSION} overlay client starting...`);
  console.log(`[tnp] API: ${config.apiBaseUrl}`);

  // The kill switch goes first and is all-or-nothing. Asked for and not fully
  // applied means not connecting: carrying on would give the user exactly the
  // leak they asked to be protected from, behind a line saying it was on.
  let killSwitchOn = false;
  if (config.killSwitch) {
    try {
      const allow = killSwitchAllow(config.publicDnsIp);
      console.log(`[tnp] kill switch: ${describeKillSwitch(allow)}`);
      const record = enableKillSwitch(config.publicDnsIp);
      killSwitchOn = true;
      console.log(`[tnp] kill switch applied (${record.backend}, IPv4 and IPv6)`);
      // A crash keeps the rules — failing closed is the point — but the user
      // must be told DNS stays blocked and how to undo it.
      process.on('exit', (code) => {
        if (code !== 0 && killSwitchOn) {
          console.error(
            '[tnp] the kill switch is still on: plain DNS stays blocked. `sudo tnp connect --no-killswitch` or `sudo tnp uninstall` removes it.',
          );
        }
      });
      const cut = upstreamsBlockedByKillSwitch(config.upstreamDns, allow);
      if (cut.length > 0) {
        console.warn(
          `[tnp] warning: the local resolver forwards public names over plain DNS to ${cut.join(', ')}, which the kill switch blocks; public names will not resolve through it. Set upstreamDns to a DNS-over-HTTPS URL (https://...) to keep them working.`,
        );
      }
    } catch (err) {
      console.error(
        `[tnp] kill switch could not be applied: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(
        '[tnp] no kill-switch rules were left in place. Not connecting, because the kill switch was requested; fix the problem above or connect with --no-killswitch.',
      );
      process.exit(1);
    }
  }

  console.log(
    `[tnp] privacy: ${config.privacyLevel}  kill switch: ${killSwitchOn ? 'on (plain DNS only)' : 'off'}  autoconnect: ${config.autoConnect ? 'on' : 'off'}`,
  );

  // Start DNS proxy with overlay enabled
  const proxy = new DnsProxy(config);
  proxy.enableOverlay();

  proxy.startTldSync(5 * 60 * 1000);
  await proxy.syncTlds();
  await proxy.start();

  // Auto-configure system DNS to use the local proxy
  const dnsConfigured = configureDns(config);

  // Start SOCKS5 proxy
  const { TunnelManager } = await import('./tunnel');
  const { SocksProxy } = await import('./socks');

  const tunnelManager = new TunnelManager();
  const socksProxy = new SocksProxy({
    port: config.socksPort,
    host: config.listenAddr,
    tunnelManager,
    apiClient: proxy.getApiClient(),
    getOverlayInfo: (domain: string) => proxy.getOverlayInfo(domain),
    classify: (domain: string) => proxy.classify(domain),
  });

  console.log(`[tnp] overlay client ready — TNP domains now resolve on this device`);
  console.log(`[tnp] press Ctrl+C to disconnect`);

  const shutdown = () => {
    console.log('\n[tnp] shutting down overlay client...');
    // A kill switch that could not be removed makes the exit non-zero, so
    // nothing reports a clean stop while DNS stays blocked.
    if (killSwitchOn && removeKillSwitch(config.publicDnsIp)) {
      killSwitchOn = false;
    }
    if (dnsConfigured) {
      restoreDns();
    }
    socksProxy.stop();
    tunnelManager.shutdown();
    proxy.stop();
    process.exit(killSwitchOn ? 1 : 0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const connectStatePath = () => routingStatePath(dataDir(), 'connect');

/** What this session added to the OS DNS configuration, for teardown. */
let connectRouting: RoutingState | null = null;

/**
 * Where `tnp connect` sends native-name queries: the local proxy. Windows NRPT
 * rules carry no port, so there the proxy must listen on 53.
 *
 * Earlier releases pointed Windows at the TNP public resolver instead. That
 * is plaintext DNS across the user's network — the ISP reads (and can forge)
 * every TNP name looked up — so it is not done; the user is told how to keep
 * resolution local instead.
 */
function connectRoutingTarget(config: TnpConfig): RoutingTarget | null {
  if (process.platform !== 'win32' || config.listenPort === 53) {
    return { address: config.listenAddr, port: config.listenPort };
  }
  console.warn(
    `[tnp] Windows cannot route DNS to port ${config.listenPort}. DNS left unchanged: ` +
      `${NATIVE_TLDS.map((t) => `.${t}`).join(' ')} will not resolve system-wide in this session. ` +
      `Set "listenPort": 53 in the config and run tnp connect as Administrator to route it to this device.`,
  );
  return null;
}

/**
 * Route TNP-native names — and only those — to the local proxy. Returns true
 * if routing was set up.
 *
 * Public names keep going to whatever resolver the user already has. This
 * used to replace every Windows adapter's servers with the TNP resolver plus
 * 1.1.1.1, and on Linux to prepend the TNP resolver to /etc/resolv.conf:
 * both sent every lookup on the machine to TNP. See dns-routing.ts.
 */
function configureDns(config: TnpConfig): boolean {
  // A previous session that died without restoring left its routing behind.
  restoreDns();

  const target = connectRoutingTarget(config);
  if (!target) return false;

  try {
    const { state } = applyNativeRouting({ owner: 'connect', target });
    if (state.mechanism === 'none') return false;
    connectRouting = state;
    // Also on disk, so the next session can clean up after a crash.
    try {
      const path = connectStatePath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    } catch (err) {
      console.warn(
        `[tnp] could not record DNS routing state: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return true;
  } catch (err) {
    console.log(
      `[tnp] could not configure DNS routing: ${err instanceof Error ? err.message : err}`,
    );
    console.log(
      `[tnp] TNP-native names will not resolve until ${NATIVE_TLDS.map((t) => `.${t}`).join(' ')} is routed to ${target.address}:${target.port}`,
    );
    return false;
  }
}

/** Undo exactly the routing `configureDns` recorded, plus legacy leftovers. */
function restoreDns(): void {
  const path = connectStatePath();
  try {
    removeNativeRouting(connectRouting ?? readRoutingState(path));
    connectRouting = null;
  } catch (err) {
    console.warn(
      `[tnp] could not remove DNS routing automatically: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    unlinkSync(path);
  } catch {
    // No recorded session -- nothing to remove.
  }

  // Earlier releases prepended the TNP public resolver to /etc/resolv.conf.
  // Remove that exact line if it is still there; nothing else in the file is
  // touched.
  if (process.platform === 'linux') {
    const dnsIp = loadConfig().publicDnsIp;
    if (!dnsIp) return;
    try {
      const current = readFileSync('/etc/resolv.conf', 'utf-8');
      const line = `nameserver ${dnsIp}\n`;
      if (current.startsWith(line)) {
        writeFileSync('/etc/resolv.conf', current.slice(line.length));
        console.log('[tnp] removed the TNP resolver an older release added to /etc/resolv.conf');
      }
    } catch {
      // Unreadable or not writable without sudo: nothing we can repair here.
    }
  }
}

/**
 * Remove kill-switch rules and say what happened. Never throws: it runs on
 * shutdown and on crash recovery, where a throw would skip the DNS restore.
 */
function removeKillSwitch(publicDnsIp: string): boolean {
  try {
    const { residual } = disableKillSwitch(publicDnsIp);
    if (residual.length === 0) {
      console.log('[tnp] kill switch off -- plain DNS is no longer blocked');
      return true;
    }
    console.error(
      `[tnp] kill-switch rules are still present: ${residual.join(', ')}. Run \`sudo tnp uninstall\` (as Administrator on Windows) to retry.`,
    );
  } catch (err) {
    console.error(
      `[tnp] could not remove kill-switch rules: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return false;
}

/**
 * The Oxy token for `serve`/`relay`, from `--token-stdin`, `TNP_TOKEN` or the
 * deprecated `--token`. Exits on a malformed source. `TNP_TOKEN` is removed
 * from the environment once read, so no child process inherits it.
 */
async function readTokenOrExit(): Promise<string | null> {
  const result = await resolveToken({
    argv: process.argv,
    env: process.env,
    readStdin: () => Bun.stdin.text(),
  });
  delete process.env.TNP_TOKEN;
  if (!result.ok) {
    console.error(`[tnp] ${result.error}`);
    process.exit(1);
  }
  if (result.token !== null && result.warning) {
    console.warn(`[tnp] warning: ${result.warning}`);
  }
  return result.token;
}

async function cmdServe() {
  const config = loadConfig();

  // Parse flags
  const domain = getFlag('--domain');
  const target = getFlag('--target') || 'localhost:80';
  const relayEndpoint = getFlag('--relay');
  const authToken = await readTokenOrExit();

  if (!domain) {
    console.error('[tnp] --domain is required for serve mode');
    console.error('Example: TNP_TOKEN=<auth-token> tnp serve --domain example.ox');
    process.exit(1);
  }

  if (!authToken) {
    console.error(
      '[tnp] an Oxy auth token is required for serve mode: set TNP_TOKEN or pipe it to --token-stdin',
    );
    process.exit(1);
  }

  try {
    parseLocalTarget(target);
  } catch (err) {
    console.error(`[tnp] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // Without --relay, only an Oxy-operated relay is chosen. A community relay
  // is never picked silently, whatever `relayPreference` says: see
  // relay-select.ts for why that is the operator's decision to make.
  let relay = relayEndpoint;
  if (!relay) {
    console.log('[tnp] looking for an Oxy-operated relay...');
    const { TnpApiClient } = await import('./api');
    const { selectAutomaticRelay } = await import('./relay-select');
    const apiClient = new TnpApiClient(config.apiBaseUrl);

    const selection = selectAutomaticRelay(await apiClient.getRelays('oxy'));
    if (!selection.ok) {
      console.error(`[tnp] ${selection.message}`);
      process.exit(1);
    }

    relay = selection.endpoint;
    console.log(`[tnp] selected Oxy-operated relay: ${relay}`);
  }

  console.log(`[tnp] v${VERSION} service node starting...`);
  console.log(`[tnp] domain: ${domain}`);
  console.log(`[tnp] target: ${target}`);
  console.log(`[tnp] relay: ${relay}`);

  const { startServiceNode } = await import('./service-node');
  const { TnpApiClient } = await import('./api');
  const apiClient = new TnpApiClient(config.apiBaseUrl);

  await startServiceNode(
    {
      domain,
      localTarget: target,
      apiBaseUrl: config.apiBaseUrl,
      relayEndpoint: relay,
      identityKeyPath: config.identityKeyPath,
      authToken,
    },
    apiClient,
  );
}

async function cmdRelay() {
  const config = loadConfig();

  const port = Number(getFlag('--port') ?? config.relayPort);
  const host = getFlag('--host') ?? '0.0.0.0';
  const location = getFlag('--location') ?? config.relayLocation;
  const authToken = (await readTokenOrExit()) ?? config.relayAuthToken;
  const maxConn = Number(getFlag('--max-connections') ?? config.relayMaxConnections);
  const bandwidth = Number(getFlag('--bandwidth') ?? config.relayBandwidth);
  const endpoint = getFlag('--endpoint') ?? config.relayEndpoint;

  if (!authToken) {
    console.error('[tnp] an Oxy auth token is required: set TNP_TOKEN or pipe it to --token-stdin');
    console.error('Example: TNP_TOKEN=<auth-token> tnp relay --endpoint wss://relay.example.com');
    process.exit(1);
  }

  if (!endpoint) {
    console.error('[tnp] --endpoint is required: the public URL clients dial');
    console.error('Example: TNP_TOKEN=<auth-token> tnp relay --endpoint wss://relay.example.com');
    console.error('It is not the bind address -- use --host/--port for that.');
    process.exit(1);
  }

  console.log(`[tnp] v${VERSION} relay node starting...`);
  console.log(`[tnp] listen: ${host}:${port}`);
  console.log(`[tnp] endpoint: ${endpoint}`);
  console.log(`[tnp] location: ${location || '(not set)'}`);
  console.log(`[tnp] max connections: ${maxConn}`);
  console.log(`[tnp] bandwidth: ${bandwidth > 0 ? `${bandwidth} Mbit/s` : '(not stated)'}`);

  const { RelayNode } = await import('./relay-node');
  const { TnpApiClient } = await import('./api');

  const apiClient = new TnpApiClient(config.apiBaseUrl);

  const relay = new RelayNode({
    port,
    host,
    endpoint,
    maxConnections: maxConn,
    bandwidth,
    authToken,
    location,
    apiBaseUrl: config.apiBaseUrl,
    identityKeyPath: config.identityKeyPath,
  });

  await relay.start(apiClient);

  console.log(`[tnp] relay node ready on ${host}:${port}`);

  const shutdown = () => {
    console.log('\n[tnp] shutting down relay node...');
    relay.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function cmdInstall() {
  const config = loadConfig();
  // Force port 53 for system DNS integration
  config.listenPort = 53;
  config.listenAddr = '127.0.0.1';
  saveConfig(config);

  console.log(`[tnp] installing service...`);
  console.log(`[tnp] listen: ${config.listenAddr}:${config.listenPort}`);

  try {
    const binaryPath = installService(config);
    console.log(`[tnp] service binary: ${binaryPath}`);
    console.log('[tnp] service installed and started');
    console.log(
      `[tnp] TNP-native domains (${NATIVE_TLDS.map((t) => `.${t}`).join(', ')}) will now resolve on this device`,
    );
  } catch (err) {
    console.error(`[tnp] install failed: ${err}`);
    console.error('[tnp] you may need to run this command with sudo');
    process.exit(1);
  }
}

async function cmdUpdate() {
  // Every check lives in ./update: the API's answer is only a version hint;
  // the files come from the fixed release URL and must carry the pinned key's
  // signature (docs/architecture/security.md §7).
  const platform = currentReleasePlatform();
  if (!platform) {
    console.error(`[tnp] no release is published for ${process.platform}-${process.arch}`);
    process.exit(1);
  }
  if (!isCompiledBinary()) {
    console.error('[tnp] update replaces the installed tnp binary; run it from an installed tnp');
    process.exit(1);
  }

  console.log('[tnp] checking for updates...');
  try {
    const latest = await fetchLatestVersion(loadConfig().apiBaseUrl);
    const decision = decideUpdate(VERSION, latest);
    if (decision.kind === 'current') {
      console.log(`[tnp] already on latest version (v${VERSION})`);
      return;
    }
    if (decision.kind === 'downgrade') {
      console.error(
        `[tnp] refusing to replace v${decision.from} with older v${decision.offered} offered by the API`,
      );
      process.exit(1);
    }

    console.log(`[tnp] downloading v${decision.to} for ${platform}...`);
    const release = await downloadVerifiedRelease(decision.to, platform);
    console.log(`[tnp] verified ${release.asset}: signed by the pinned release key`);

    const target = realpathSync(process.execPath);

    try {
      stopService();
    } catch (err) {
      console.warn(
        `[tnp] could not stop service before update: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // The service is restarted whether or not the replacement worked, so a
    // failed install does not leave the resolver stopped.
    let installError: unknown = null;
    try {
      installBinaryAtomically(target, release.binary);
      console.log(`[tnp] updated v${VERSION} → v${release.version} at ${target}`);
    } catch (err) {
      installError = err;
    }

    try {
      startService();
      console.log('[tnp] service restarted');
    } catch (err) {
      console.warn(
        `[tnp] could not restart service after update: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (installError) throw installError;
  } catch (err) {
    console.error(`[tnp] update failed: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof ReleaseVerificationError) {
      console.error('[tnp] nothing was installed: the download did not verify');
    } else {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        console.error('[tnp] you may need to run this command with sudo');
      }
    }
    process.exit(1);
  }
}

function cmdUninstall() {
  const purge = process.argv.includes('--purge');
  console.log(purge ? '[tnp] uninstalling and purging TNP data...' : '[tnp] uninstalling...');

  let publicDnsIp = '';
  try {
    publicDnsIp = loadConfig().publicDnsIp;
  } catch {
    // An unreadable config must not block removal; it only names an extra
    // address that 0.2.0's kill switch may have allowed.
  }

  try {
    const report = performUninstall({ purge, publicDnsIp });
    for (const line of formatUninstallReport(report, purge)) {
      console.log(line ? `[tnp] ${line}` : '');
    }
    if (report.failed.length > 0) process.exit(1);
  } catch (err) {
    console.error(`[tnp] uninstall failed: ${err}`);
    console.error('[tnp] you may need to run this command with sudo');
    process.exit(1);
  }
}

function cmdStatus() {
  const running = serviceStatus();
  if (running) {
    console.log('[tnp] resolver is running');
  } else {
    console.log('[tnp] resolver is not running');
  }
  process.exit(running ? 0 : 1);
}

async function cmdTest(domain: string) {
  if (!domain) {
    console.error('Usage: tnp test <domain>');
    console.error('Example: tnp test example.ox');
    process.exit(1);
  }

  const config = loadConfig();
  const { TnpApiClient } = await import('./api');
  const client = new TnpApiClient(config.apiBaseUrl);

  console.log(`[tnp] resolving ${domain} via ${config.apiBaseUrl}...`);

  let foundAny = false;
  for (const type of ['A', 'AAAA', 'CNAME', 'TXT']) {
    const answers = await client.resolve(domain, type);
    for (const ans of answers) {
      console.log(`  ${ans.type}\t${ans.name}\t${ans.value}\t(TTL: ${ans.ttl})`);
      foundAny = true;
    }
  }

  if (!foundAny) {
    console.log(`  (no records found for ${domain})`);
  }

  // Also check overlay status
  const nodeInfo = await client.getServiceNode(domain);
  if (nodeInfo) {
    console.log(`  [overlay] status: ${nodeInfo.status}`);
    console.log(`  [overlay] relay: ${nodeInfo.connectedRelay || '(none)'}`);
    console.log(`  [overlay] pubkey: ${nodeInfo.publicKey}`);
  } else {
    console.log(`  [overlay] no service node registered`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || idx + 1 >= process.argv.length) return undefined;
  return process.argv[idx + 1];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const command = process.argv[2] || 'interactive';
const arg = process.argv[3];

switch (command) {
  case 'interactive': {
    const { startInteractive } = await import('./interactive');
    await startInteractive();
    break;
  }
  case 'run':
    await cmdRun();
    break;
  case 'connect':
    await cmdConnect();
    break;
  case 'serve':
    await cmdServe();
    break;
  case 'relay':
    await cmdRelay();
    break;
  case 'install':
    cmdInstall();
    break;
  case 'uninstall':
    cmdUninstall();
    break;
  case 'update':
    await cmdUpdate();
    break;
  case 'status':
    cmdStatus();
    break;
  case 'test':
    await cmdTest(arg || '');
    break;
  case 'version':
  case '--version':
  case '-v':
    console.log(`tnp v${VERSION}`);
    break;
  case 'help':
  case '--help':
  case '-h':
    usage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    usage();
    process.exit(1);
}
