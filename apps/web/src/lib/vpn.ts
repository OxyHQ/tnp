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
  VPN_PERSISTENT_KEEPALIVE_SECONDS,
  type VpnDevice,
  type VpnDeviceList,
  type VpnDeviceResponse,
  type VpnExit,
  vpnIpv6ForIpv4,
} from '@tnp/shared-types';

export type { WireGuardKeyPair };

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
  dns: readonly string[];
  allowedIPs: readonly string[];
}

/** The `.conf` text the WireGuard apps import (and the QR code encodes). */
export function wireGuardConfig(input: DeviceConfigInput): string {
  return renderWireGuardConfig(input);
}

/**
 * A file name WireGuard accepts as a tunnel name (`wg-quick` and the Windows
 * app use the file name: 1-15 of `[A-Za-z0-9_=+.-]`).
 */
export function tunnelFileName(deviceName: string): string {
  const slug = deviceName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_=+.-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 11)
    .replace(/[-.]+$/, '');
  return `tnp${slug ? `-${slug}` : ''}`.slice(0, 15);
}

/** A single-quoted shell word. Every value is validated first; this refuses rather than escapes. */
function q(value: string): string {
  if (!/^[A-Za-z0-9+/=.:\-_ ()[\]]*$/.test(value))
    throw new RangeError('unsafe value for a uci command');
  return `'${value}'`;
}

/**
 * OpenWrt `uci` commands for the router: a `wg0` WireGuard interface with this
 * device's key and addresses, one peer for the exit with the full tunnel
 * routed, the TNP resolver instead of the provider's, and a `tnp` firewall
 * zone with masquerading that the LAN forwards into.
 */
export function openWrtCommands(input: DeviceConfigInput): string {
  // Validate everything the same way the .conf renderer does (it throws).
  renderWireGuardConfig(input);
  const { privateKey, device, exit, dns, allowedIPs } = input;
  const endpoint = splitVpnEndpoint(exit.endpoint);
  if (!endpoint) throw new RangeError('invalid exit endpoint');
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
    `uci set network.wg0_tnp.endpoint_host=${q(endpoint.host)}`,
    `uci set network.wg0_tnp.endpoint_port=${q(String(endpoint.port))}`,
    ...allowedIPs.map((cidr) => `uci add_list network.wg0_tnp.allowed_ips=${q(cidr)}`),
    "uci set network.wg0_tnp.route_allowed_ips='1'",
    `uci set network.wg0_tnp.persistent_keepalive=${q(String(VPN_PERSISTENT_KEEPALIVE_SECONDS))}`,
    "uci set network.wan.peerdns='0'",
    "uci -q get network.wan6 >/dev/null && uci set network.wan6.peerdns='0'",
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
    'uci commit network',
    'uci commit firewall',
    'service network restart',
    'service firewall restart',
    '',
  ].join('\n');
}

/**
 * Optional: remove the LAN's forwarding to `wan`, so LAN devices lose the
 * internet rather than falling back to the provider if `wg0` goes down. The
 * router itself still uses `wan` — it has to, to reach the exit.
 */
export const OPENWRT_KILL_SWITCH = [
  "for s in $(uci -X show firewall | sed -n 's/^firewall\\.\\([^.=]*\\)=forwarding$/\\1/p'); do",
  '  [ "$(uci -q get firewall.$s.src)" = lan ] && [ "$(uci -q get firewall.$s.dest)" = wan ] && uci delete firewall.$s',
  'done',
  'uci commit firewall',
  'service firewall restart',
  '',
].join('\n');
