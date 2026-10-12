/**
 * `tnp vpn` — add, list and revoke WireGuard devices for TNP's standard-tier
 * VPN from a terminal. The tunnel itself is the official WireGuard client
 * (`wg-quick`), not TNP code. Design: docs/architecture/vpn.md §10; user
 * guide: docs/vpn.mdx.
 *
 * The key pair is generated here and the private key goes into one file,
 * created with mode 0600 and never overwritten. It is not printed unless
 * `--print` asks for it, so it does not land in terminal scrollback by default.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateWireGuardKeyPair, type WireGuardKeyPair } from '@tnp/crypto/wireguard';
import {
  type CreateVpnDeviceRequest,
  renderWireGuardConfig,
  tunnelFileName,
  type VpnDeviceList,
  type VpnDeviceResponse,
} from '@tnp/shared-types';
import { TnpApiClient } from './api';
import { loadConfig } from './config';
import { resolveToken } from './token';

const USAGE = `
Usage:
  tnp vpn add <name> [--exit <id>] [--out <file>] [--print]
      Generate a WireGuard key pair on this machine, register its public key,
      and write a wg-quick config (mode 0600) to <file>, default ./tnp-<name>.conf.
      --print also prints the config, private key included.
  tnp vpn list            Your devices
  tnp vpn revoke <id>     Revoke a device; exits stop accepting it within a minute

Needs TNP_TOKEN (or --token-stdin). Then, on Linux:
  sudo install -m 600 tnp-<name>.conf /etc/wireguard/ && sudo wg-quick up tnp-<name>

What this protects and what it does not: TNP operates the exit and can see
which addresses you connect to (not the content of HTTPS). It is not anonymity;
if your safety depends on not being identified, use Tor Browser.
`;

export interface VpnCliApi {
  registerVpnDevice(request: CreateVpnDeviceRequest, token: string): Promise<VpnDeviceResponse>;
  listVpnDevices(token: string): Promise<VpnDeviceList>;
  revokeVpnDevice(id: string, token: string): Promise<void>;
}

export interface VpnCliDeps {
  api: VpnCliApi;
  token: string;
  generate?: () => WireGuardKeyPair;
  writeFile?: (path: string, data: string) => void;
  log?: (line: string) => void;
  cwd?: string;
}

/** Create the file only if it does not exist, readable by its owner only. */
function writePrivate(path: string, data: string): void {
  writeFileSync(path, data, { mode: 0o600, flag: 'wx' });
}

function option(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
  return value;
}

function positional(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exit' || argv[i] === '--out') i++;
    else if (!argv[i].startsWith('--')) out.push(argv[i]);
  }
  return out;
}

export async function vpnAdd(argv: readonly string[], deps: VpnCliDeps): Promise<string> {
  const log = deps.log ?? console.log;
  const name = positional(argv).join(' ').trim();
  if (!name) throw new Error('usage: tnp vpn add <name>');
  const keys = (deps.generate ?? generateWireGuardKeyPair)();
  const request: CreateVpnDeviceRequest = { name, publicKey: keys.publicKey };
  const { device, network } = await deps.api.registerVpnDevice(request, deps.token);
  if (device.publicKey !== keys.publicKey)
    throw new Error('the API returned a device for a different key');

  const exitId = option(argv, '--exit');
  const exit = exitId ? network.exits.find((e) => e.id === exitId) : network.exits[0];
  if (!exit) throw new Error(exitId ? `no exit named ${exitId}` : 'the API listed no exit');

  const config = renderWireGuardConfig({
    privateKey: keys.privateKey,
    device,
    exit,
    dns: network.dns,
    allowedIPs: network.allowedIPs,
  });
  const file = resolve(
    deps.cwd ?? process.cwd(),
    option(argv, '--out') ?? `${tunnelFileName(name)}.conf`,
  );
  (deps.writeFile ?? writePrivate)(file, config);

  log(`[tnp] added ${device.name}: ${device.ipv4}, exit ${exit.id} (${exit.region})`);
  log(`[tnp] wrote ${file} (mode 0600). It holds the private key; TNP never received it.`);
  log(
    '[tnp] the exit operator (TNP) can see which addresses you connect to. This is not anonymity.',
  );
  if (argv.includes('--print')) log(`\n${config}`);
  return file;
}

export async function runVpnCommand(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (!sub || sub === 'help' || sub === '--help') {
    console.log(USAGE);
    return sub ? 0 : 1;
  }
  try {
    const token = await resolveToken({
      argv: rest,
      env: process.env,
      readStdin: () => Bun.stdin.text(),
    });
    delete process.env.TNP_TOKEN;
    if (!token.ok) throw new Error(token.error);
    if (token.token === null) {
      throw new Error('an Oxy auth token is required: set TNP_TOKEN or pipe it to --token-stdin');
    }
    if (token.warning) console.warn(`[tnp] warning: ${token.warning}`);
    const api = new TnpApiClient(loadConfig().apiBaseUrl);
    const deps: VpnCliDeps = { api, token: token.token };

    switch (sub) {
      case 'add':
        await vpnAdd(
          rest.filter((a) => a !== '--token-stdin'),
          deps,
        );
        return 0;
      case 'list': {
        const { devices, network } = await api.listVpnDevices(token.token);
        if (devices.length === 0)
          console.log('[tnp] no VPN devices yet. Add one: tnp vpn add <name>');
        for (const d of devices) console.log(`${d.id}  ${d.ipv4.padEnd(15)}  ${d.name}`);
        console.log(`[tnp] ${devices.length} of ${network.maxDevices} devices`);
        return 0;
      }
      case 'revoke': {
        const id = positional(rest)[0];
        if (!id) throw new Error('usage: tnp vpn revoke <id>   (ids: tnp vpn list)');
        await api.revokeVpnDevice(id, token.token);
        console.log('[tnp] revoked; exits stop accepting it within a minute');
        return 0;
      }
      default:
        console.log(USAGE);
        return 1;
    }
  } catch (err) {
    console.error(`[tnp] ${(err as Error).message}`);
    return 1;
  }
}
