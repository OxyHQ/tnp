/**
 * The standard-tier VPN in the browser: make a WireGuard key pair, register
 * the public half, and write the configs the official clients import.
 *
 * Design: docs/architecture/vpn.md §10. The private key is generated here and
 * lives only in the page's memory while the config is on screen. It is never
 * sent (the request type has no field for it, and the API refuses one), never
 * written to localStorage or sessionStorage, and gone when the page is left.
 *
 * Network is injected (`VpnApi`) so the tests run the real logic — and capture
 * the real request bodies — without a browser.
 */

import { generateWireGuardKeyPair, type WireGuardKeyPair } from '@tnp/crypto/wireguard';
import {
  type CreateVpnDeviceRequest,
  isCidr,
  isValidIpv4,
  isValidIpv6,
  isVpnDeviceIpv4,
  type RenameVpnDeviceRequest,
  renderWireGuardConfig,
  splitVpnEndpoint,
  suggestVpnExit,
  tunnelFileName,
  VPN_PERSISTENT_KEEPALIVE_SECONDS,
  type VpnDevice,
  type VpnDeviceList,
  type VpnDeviceResponse,
  type VpnErrorCode,
  type VpnExit,
  vpnExitDns,
  vpnIpv6ForIpv4,
} from '@tnp/shared-types';

export type { WireGuardKeyPair };
export { suggestVpnExit, tunnelFileName };

export interface VpnApi {
  list(): Promise<VpnDeviceList>;
  create(body: CreateVpnDeviceRequest): Promise<VpnDeviceResponse>;
  rename(id: string, body: RenameVpnDeviceRequest): Promise<VpnDeviceResponse>;
  remove(id: string): Promise<void>;
}

type Request = <T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  options?: { body?: unknown },
) => Promise<T>;

export function httpVpnApi(request: Request): VpnApi {
  return {
    list: () => request<VpnDeviceList>('GET', '/me/vpn/devices'),
    create: (body) => request<VpnDeviceResponse>('POST', '/me/vpn/devices', { body }),
    rename: (id, body) =>
      request<VpnDeviceResponse>('PATCH', `/me/vpn/devices/${encodeURIComponent(id)}`, { body }),
    remove: async (id) => {
      await request<void>('DELETE', `/me/vpn/devices/${encodeURIComponent(id)}`);
    },
  };
}

/**
 * What the page shows when `GET /me/vpn/devices` fails: the VPN is off
 * (503 `vpn_not_configured`), it is not open to this account (403
 * `vpn_not_available`, `TNP_VPN_ALLOWED_USERS`), or something went wrong.
 */
export function classifyLoadFailure(
  status: number | undefined,
  code: string | undefined,
): 'unavailable' | 'notAllowed' | 'error' {
  const expected: VpnErrorCode | undefined =
    status === 503 ? 'vpn_not_configured' : status === 403 ? 'vpn_not_available' : undefined;
  if (expected === undefined || code !== expected) return 'error';
  return expected === 'vpn_not_configured' ? 'unavailable' : 'notAllowed';
}

export interface NewDevice {
  /** Only ever in memory. */
  keys: WireGuardKeyPair;
  response: VpnDeviceResponse;
}

/**
 * Generate a key pair here and register its public key. The request carries
 * exactly `{ name, publicKey }`; the private key stays in the returned value.
 */
export async function addDevice(
  api: VpnApi,
  name: string,
  generate: () => WireGuardKeyPair = generateWireGuardKeyPair,
): Promise<NewDevice> {
  const keys = generate();
  const body: CreateVpnDeviceRequest = { name: name.trim(), publicKey: keys.publicKey };
  const response = await api.create(body);
  if (response.device.publicKey !== keys.publicKey) {
    throw new Error('The API returned a device for a different key');
  }
  return { keys, response };
}

export interface DeviceConfigInput {
  privateKey: string;
  device: Pick<VpnDevice, 'ipv4' | 'ipv6'>;
  exit: VpnExit;
  /** The network-wide resolvers; the exit's own `dns` takes precedence (`configDns`). */
  dns: readonly string[];
  allowedIPs: readonly string[];
}

/** The resolvers a config for this exit names: the exit's own, else the network's. */
export function configDns(input: Pick<DeviceConfigInput, 'exit' | 'dns'>): readonly string[] {
  return vpnExitDns(input.exit, input.dns);
}

/**
 * AWS region codes whose city the page can name (`vpn:regions.<code>`, in
 * every locale). Any other `region` is shown as it is configured.
 */
export const KNOWN_EXIT_REGIONS: readonly string[] = [
  'us-east-1',
  'us-west-2',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'ap-northeast-1',
  'ap-southeast-1',
  'sa-east-1',
];

/** Whether the page has a city name for this exit's region. */
export function isKnownExitRegion(region: string): boolean {
  return KNOWN_EXIT_REGIONS.includes(region);
}

/** The `.conf` text the WireGuard apps import (and the QR code encodes). */
export function wireGuardConfig(input: DeviceConfigInput): string {
  return renderWireGuardConfig(input);
}

/** A single-quoted shell word. Every value is validated first; this refuses rather than escapes. */
function q(value: string): string {
  if (!/^[A-Za-z0-9+/=.:\-_ ()[\]]*$/.test(value))
    throw new RangeError('unsafe value for a uci command');
  return `'${value}'`;
}

/**
 * The router's WireGuard config: the same as a device's, but dialling the
 * exit by IP literal. The router sends its own DNS through the tunnel
 * (`peerdns` off), so at boot it could not resolve the exit's hostname to
 * bring the tunnel up — a lockout.
 */
export function routerWireGuardConfig(input: DeviceConfigInput): string {
  return renderWireGuardConfig({ ...input, useEndpointIp: true });
}

export interface OpenWrtOptions {
  /**
   * Remove the LAN's forwarding to `wan`, so LAN devices have no internet
   * rather than silently using the provider when the tunnel is down. On by
   * default; turning it off is an explicit choice.
   */
  killSwitch?: boolean;
}

/** Remove the LAN → wan forwarding (the router's kill switch). */
const KILL_SWITCH_LINES = [
  "for s in $(uci -X show firewall | sed -n 's/^firewall\\.\\([^.=]*\\)=forwarding$/\\1/p'); do",
  '  [ "$(uci -q get firewall.$s.src)" = lan ] && [ "$(uci -q get firewall.$s.dest)" = wan ] && uci delete firewall.$s',
  'done',
];

/** A rule refusing forwarded IPv6 from the LAN to `dest`, with an immediate error. */
function rejectLanIpv6(section: string, dest: string, name: string): string[] {
  return [
    `uci -q delete firewall.${section}`,
    `uci set firewall.${section}=rule`,
    `uci set firewall.${section}.name=${q(name)}`,
    `uci set firewall.${section}.family='ipv6'`,
    `uci set firewall.${section}.src='lan'`,
    `uci set firewall.${section}.dest=${q(dest)}`,
    `uci set firewall.${section}.proto='all'`,
    `uci set firewall.${section}.target='REJECT'`,
  ];
}

/**
 * OpenWrt `uci` commands for the router: a `wg0` WireGuard interface with this
 * device's key and addresses, one peer for the exit (by IP literal) with the
 * full tunnel routed, the TNP resolver instead of the provider's, a `tnp`
 * firewall zone with masquerading that the LAN forwards into, and:
 *
 * - **No IPv6 leak.** OpenWrt's provider IPv6 default route is
 *   source-restricted to the delegated prefix (`wan6.sourcefilter`), which
 *   beats `wg0`'s plain `::/0` for LAN devices, so their IPv6 would go straight
 *   to the provider. Source routing is switched off, and forwarded LAN IPv6 is
 *   refused (to `wan`, and to `tnp`, which does not carry it) with an
 *   immediate error.
 * - **Kill switch by default.** The LAN → wan forwarding is removed, so LAN
 *   devices lose the internet instead of falling back to the provider.
 */
export function openWrtCommands(input: DeviceConfigInput, options: OpenWrtOptions = {}): string {
  const killSwitch = options.killSwitch ?? true;
  // Validate everything the same way the .conf renderer does (it throws).
  renderWireGuardConfig({ ...input, useEndpointIp: true });
  const { privateKey, device, exit, allowedIPs } = input;
  const dns = configDns(input);
  const endpoint = splitVpnEndpoint(exit.endpoint);
  if (!endpoint) throw new RangeError('invalid exit endpoint');
  if (!isValidIpv4(exit.endpointIp) && !isValidIpv6(exit.endpointIp)) {
    throw new RangeError('invalid exit IP');
  }
  if (!isVpnDeviceIpv4(device.ipv4) || device.ipv6 !== vpnIpv6ForIpv4(device.ipv4)) {
    throw new RangeError('invalid device address');
  }
  if (!dns.every((ip) => isValidIpv4(ip) || isValidIpv6(ip)) || !allowedIPs.every(isCidr)) {
    throw new RangeError('invalid network settings');
  }
  return [
    'uci -q delete network.wg0',
    'uci set network.wg0=interface',
    "uci set network.wg0.proto='wireguard'",
    `uci set network.wg0.private_key=${q(privateKey)}`,
    `uci add_list network.wg0.addresses=${q(`${device.ipv4}/32`)}`,
    `uci add_list network.wg0.addresses=${q(`${device.ipv6}/128`)}`,
    ...dns.map((ip) => `uci add_list network.wg0.dns=${q(ip)}`),
    'uci -q delete network.wg0_tnp',
    'uci set network.wg0_tnp=wireguard_wg0',
    `uci set network.wg0_tnp.description=${q(`TNP exit ${exit.id}`)}`,
    `uci set network.wg0_tnp.public_key=${q(exit.publicKey)}`,
    `uci set network.wg0_tnp.endpoint_host=${q(exit.endpointIp)}`,
    `uci set network.wg0_tnp.endpoint_port=${q(String(endpoint.port))}`,
    ...allowedIPs.map((cidr) => `uci add_list network.wg0_tnp.allowed_ips=${q(cidr)}`),
    "uci set network.wg0_tnp.route_allowed_ips='1'",
    `uci set network.wg0_tnp.persistent_keepalive=${q(String(VPN_PERSISTENT_KEEPALIVE_SECONDS))}`,
    "uci set network.wan.peerdns='0'",
    "uci -q get network.wan6 >/dev/null && uci set network.wan6.peerdns='0'",
    "uci -q get network.wan6 >/dev/null && uci set network.wan6.sourcefilter='0'",
    'uci -q delete firewall.tnp',
    'uci set firewall.tnp=zone',
    "uci set firewall.tnp.name='tnp'",
    "uci set firewall.tnp.input='REJECT'",
    "uci set firewall.tnp.output='ACCEPT'",
    "uci set firewall.tnp.forward='REJECT'",
    "uci set firewall.tnp.masq='1'",
    "uci set firewall.tnp.mtu_fix='1'",
    "uci add_list firewall.tnp.network='wg0'",
    'uci -q delete firewall.tnp_lan',
    'uci set firewall.tnp_lan=forwarding',
    "uci set firewall.tnp_lan.src='lan'",
    "uci set firewall.tnp_lan.dest='tnp'",
    ...rejectLanIpv6('tnp_no_v6_wan', 'wan', 'TNP: no LAN IPv6 to the provider'),
    ...rejectLanIpv6('tnp_no_v6_tnp', 'tnp', 'TNP: IPv6 is not carried'),
    ...(killSwitch ? KILL_SWITCH_LINES : []),
    'uci commit network',
    'uci commit firewall',
    'service network restart',
    'service firewall restart',
    '',
  ].join('\n');
}

/** Let LAN devices use the provider again when the tunnel is down (undoes the kill switch). */
export const OPENWRT_ALLOW_FALLBACK = [
  'uci -q delete firewall.tnp_fallback',
  'uci set firewall.tnp_fallback=forwarding',
  "uci set firewall.tnp_fallback.src='lan'",
  "uci set firewall.tnp_fallback.dest='wan'",
  'uci commit firewall',
  'service firewall restart',
  '',
].join('\n');

/** Take TNP off the router and restore ordinary internet through the provider. */
export const OPENWRT_REMOVE = [
  'uci -q delete network.wg0',
  'uci -q delete network.wg0_tnp',
  "uci set network.wan.peerdns='1'",
  "uci -q get network.wan6 >/dev/null && uci set network.wan6.peerdns='1'",
  "uci -q get network.wan6 >/dev/null && uci set network.wan6.sourcefilter='1'",
  'uci -q delete firewall.tnp',
  'uci -q delete firewall.tnp_lan',
  'uci -q delete firewall.tnp_no_v6_wan',
  'uci -q delete firewall.tnp_no_v6_tnp',
  'uci -q delete firewall.tnp_fallback',
  'uci set firewall.tnp_fallback=forwarding',
  "uci set firewall.tnp_fallback.src='lan'",
  "uci set firewall.tnp_fallback.dest='wan'",
  'uci commit network',
  'uci commit firewall',
  'service network restart',
  'service firewall restart',
  '',
].join('\n');

/** How long a copied secret may stay on the clipboard before the page overwrites it. */
export const CLIPBOARD_CLEAR_MS = 60_000;

/**
 * Copy `text`, and if it is secret, overwrite the clipboard after
 * `CLIPBOARD_CLEAR_MS` — only if it still holds what was copied, and only
 * where the browser lets the page read it. Clipboard managers and history
 * may already have kept a copy; the page cannot undo that, which is why it
 * recommends the download or the QR code instead.
 */
export async function copyText(
  clipboard: Pick<Clipboard, 'writeText'> & Partial<Pick<Clipboard, 'readText'>>,
  text: string,
  secret: boolean,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
): Promise<void> {
  await clipboard.writeText(text);
  if (!secret) return;
  schedule(() => {
    void (async () => {
      try {
        const current = clipboard.readText ? await clipboard.readText() : text;
        if (current === text) await clipboard.writeText('');
      } catch {
        // Not permitted (no focus, no permission): nothing more the page can do.
      }
    })();
  }, CLIPBOARD_CLEAR_MS);
}
