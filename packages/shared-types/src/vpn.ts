/**
 * Wire contracts for the standard-tier VPN: WireGuard devices (`/me/vpn`) and
 * the exit agents' peer list (`/exit/peers`).
 *
 * Design and honesty rules: docs/architecture/vpn.md §10 and
 * exit-nodes.md §9. In one line: the user's device or router runs the
 * official WireGuard client against a TNP-operated exit; the registry holds
 * only `{ name, publicKey, address }` per device and never a private key, a
 * handshake time or a connection record.
 *
 * Addressing is a property of the contract, not of one side, so it lives
 * here: every device gets one IPv4 address in `10.77.0.0/16` and the IPv6
 * address derived from it inside a fixed ULA /64. The exit is `.0.1` / `::1`.
 * IPv6 is captured by the tunnel (`::/0`) and refused at the exit, so it
 * cannot leak around it; it is not carried to the internet yet.
 */

import { isValidWireGuardPublicKey } from '@tnp/crypto/wireguard';
import { isValidIpv4, isValidIpv6 } from './dns-records.js';
import { asRecord, type ParseResult } from './parse.js';

/** Tunnel address pool. The exit is `.0.1`; devices get `.0.2` – `.255.254`. */
export const VPN_TUNNEL_IPV4_CIDR = '10.77.0.0/16';
export const VPN_EXIT_TUNNEL_IPV4 = '10.77.0.1';
/** ULA /64 (RFC 4193, random global ID `85d596af02`) the IPv6 addresses come from. */
export const VPN_TUNNEL_IPV6_CIDR = 'fd85:d596:af02::/64';
export const VPN_EXIT_TUNNEL_IPV6 = 'fd85:d596:af02::1';
/** First and last host index a device may be given (`10.77.0.2` – `10.77.255.254`). */
export const VPN_MIN_HOST_INDEX = 2;
export const VPN_MAX_HOST_INDEX = 65_534;

export const VPN_WIREGUARD_PORT = 51820;
export const VPN_PERSISTENT_KEEPALIVE_SECONDS = 25;
/** Full tunnel, both families: IPv6 is captured so it cannot bypass the tunnel. */
export const VPN_ALLOWED_IPS: readonly string[] = ['0.0.0.0/0', '::/0'];
export const VPN_MAX_DEVICES_PER_USER = 10;
export const VPN_DEVICE_NAME_MAX_LENGTH = 64;

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** The IPv4 tunnel address for host index `index` (no range check). */
export function vpnIpv4ForIndex(index: number): string {
  return `10.77.${(index >> 8) & 0xff}.${index & 0xff}`;
}

/**
 * The host index of a device address, or null unless `ipv4` is a canonical
 * dotted quad inside the device range of the pool.
 */
export function vpnIndexOfIpv4(ipv4: unknown): number | null {
  if (typeof ipv4 !== 'string' || !isValidIpv4(ipv4)) return null;
  const [a, b, c, d] = ipv4.split('.').map(Number);
  if (a !== 10 || b !== 77) return null;
  const index = (c << 8) | d;
  return index >= VPN_MIN_HOST_INDEX && index <= VPN_MAX_HOST_INDEX ? index : null;
}

/** The IPv6 address a device's IPv4 address maps to, in RFC 5952 form. */
export function vpnIpv6ForIpv4(ipv4: string): string {
  const index = vpnIndexOfIpv4(ipv4);
  if (index === null) throw new RangeError('not a VPN device address');
  return `fd85:d596:af02::a4d:${index.toString(16)}`;
}

export function isVpnDeviceIpv4(value: unknown): value is string {
  return vpnIndexOfIpv4(value) !== null;
}

/** Exactly the address `vpnIpv6ForIpv4` gives for a device address, spelled the same way. */
export function isVpnDeviceIpv6(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^fd85:d596:af02::a4d:([0-9a-f]{1,4})$/.exec(value);
  if (!match || (match[1].length > 1 && match[1].startsWith('0'))) return false;
  const index = Number.parseInt(match[1], 16);
  return index >= VPN_MIN_HOST_INDEX && index <= VPN_MAX_HOST_INDEX;
}

// ---------------------------------------------------------------------------
// Exits
// ---------------------------------------------------------------------------

/** A TNP-operated WireGuard exit, as the API is configured with it (`TNP_VPN_EXITS`). */
export interface VpnExit {
  /** Short stable id, e.g. `usw2-1`. */
  id: string;
  /** Approximate location label shown to the user, e.g. `us-west-2`. */
  region: string;
  /** `host:port` the WireGuard apps dial. Hostname, IPv4 or `[IPv6]`. */
  endpoint: string;
  /**
   * The exit's address as an IP literal (its Elastic IP). Router configs dial
   * this instead of `endpoint`'s hostname: a router that sends its DNS through
   * the tunnel cannot resolve the tunnel's own endpoint at boot.
   */
  endpointIp: string;
  /** The exit's WireGuard public key. */
  publicKey: string;
  /**
   * Resolvers for the `DNS =` line of a config for THIS exit, when it has its
   * own. Every TNP exit runs TNP's resolver on its tunnel gateway address
   * (`VPN_EXIT_TUNNEL_IPV4`, `10.77.0.1`), so lookups are answered — and CDNs
   * pick edges — near the exit (exit-nodes.md §9.7). Absent: the network-wide
   * `VpnNetwork.dns`. Configuration may spell it as a comma list
   * (`"10.77.0.1"`); the API always serves an array.
   */
  dns?: string[];
}

/** Most resolvers a config's `DNS =` line may name. */
export const VPN_MAX_DNS_SERVERS = 4;

const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** `host` and `port` of a valid endpoint, or null. */
export function splitVpnEndpoint(endpoint: unknown): { host: string; port: number } | null {
  if (typeof endpoint !== 'string' || endpoint.length > 300) return null;
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+):([1-9][0-9]{0,4})$/.exec(endpoint);
  if (!match) return null;
  const port = Number(match[2]);
  if (port > 65_535) return null;
  const rawHost = match[1];
  if (rawHost.startsWith('[')) {
    const host = rawHost.slice(1, -1);
    return isValidIpv6(host) ? { host, port } : null;
  }
  if (isValidIpv4(rawHost) || (HOSTNAME_RE.test(rawHost) && !/^[0-9.]+$/.test(rawHost))) {
    return { host: rawHost, port };
  }
  return null;
}

const EXIT_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REGION_RE = /^[A-Za-z0-9][A-Za-z0-9 ,.()-]{0,63}$/;

/** One exit entry from configuration, validated field by field. */
export function parseVpnExit(value: unknown, label = 'exit'): ParseResult<VpnExit> {
  const r = asRecord(value);
  if (!r) return { ok: false, error: `${label} must be an object` };
  if (typeof r.id !== 'string' || !EXIT_ID_RE.test(r.id)) {
    return { ok: false, error: `${label}.id must be 1-32 lowercase letters, digits or dashes` };
  }
  if (typeof r.region !== 'string' || !REGION_RE.test(r.region)) {
    return { ok: false, error: `${label}.region must be a short label` };
  }
  if (!splitVpnEndpoint(r.endpoint)) {
    return { ok: false, error: `${label}.endpoint must be host:port` };
  }
  if (
    typeof r.endpointIp !== 'string' ||
    !(isValidIpv4(r.endpointIp) || isValidIpv6(r.endpointIp))
  ) {
    return { ok: false, error: `${label}.endpointIp must be an IP address` };
  }
  if (!isValidWireGuardPublicKey(r.publicKey)) {
    return { ok: false, error: `${label}.publicKey must be a WireGuard public key` };
  }
  const exit: VpnExit = {
    id: r.id,
    region: r.region,
    endpoint: r.endpoint as string,
    endpointIp: r.endpointIp,
    publicKey: r.publicKey,
  };
  if (r.dns !== undefined) {
    const dns = parseVpnDnsList(r.dns);
    if (!dns) {
      return {
        ok: false,
        error: `${label}.dns must be 1-${VPN_MAX_DNS_SERVERS} IP addresses (a comma list or an array)`,
      };
    }
    exit.dns = dns;
  }
  return { ok: true, value: exit };
}

/**
 * A resolver list from configuration or the wire: a comma (or whitespace)
 * separated string, or an array of strings. Null unless it names 1 to
 * `VPN_MAX_DNS_SERVERS` IP literals and nothing else.
 */
export function parseVpnDnsList(value: unknown): string[] | null {
  let items: unknown[];
  if (typeof value === 'string') items = value.split(/[\s,]+/).filter((item) => item !== '');
  else if (Array.isArray(value)) items = value;
  else return null;
  if (items.length === 0 || items.length > VPN_MAX_DNS_SERVERS) return null;
  const ips: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string' || !(isValidIpv4(item) || isValidIpv6(item))) return null;
    if (!ips.includes(item)) ips.push(item);
  }
  return ips;
}

/**
 * The resolvers a config for `exit` names: the exit's own when it has them,
 * else the network-wide list (`VpnNetwork.dns`, from `TNP_VPN_DNS`).
 */
export function vpnExitDns(
  exit: Pick<VpnExit, 'dns'>,
  networkDns: readonly string[],
): readonly string[] {
  return exit.dns && exit.dns.length > 0 ? exit.dns : networkDns;
}

/**
 * The exit to offer first: the one nearest the user, guessed from the IANA
 * time zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) against the
 * cloud region's continent prefix. A guess, never a measurement — the user
 * can always pick another; with no match, the first exit listed.
 */
export function suggestVpnExit<T extends Pick<VpnExit, 'region'>>(
  exits: readonly T[],
  timeZone: string | undefined,
): T | undefined {
  const zone = (timeZone ?? '').split('/')[0];
  const prefixes: Record<string, readonly string[]> = {
    America: ['us-', 'ca-', 'mx-', 'sa-'],
    Europe: ['eu-', 'il-', 'me-'],
    Africa: ['af-', 'eu-'],
    Asia: ['ap-', 'me-', 'il-'],
    Australia: ['ap-southeast-2', 'ap-southeast-4', 'ap-'],
    Pacific: ['ap-southeast-2', 'ap-', 'us-'],
  };
  for (const prefix of prefixes[zone] ?? []) {
    const match = exits.find((exit) => exit.region.startsWith(prefix));
    if (match) return match;
  }
  return exits[0];
}

/** `endpointIp:port`, with the brackets an IPv6 literal needs. */
export function vpnExitIpEndpoint(exit: Pick<VpnExit, 'endpoint' | 'endpointIp'>): string {
  const port = splitVpnEndpoint(exit.endpoint)?.port ?? VPN_WIREGUARD_PORT;
  return exit.endpointIp.includes(':')
    ? `[${exit.endpointIp}]:${port}`
    : `${exit.endpointIp}:${port}`;
}

/**
 * An exit agent's bearer secret: at least 43 base64url characters (256 bits
 * when random), and not visibly low-entropy. Production tokens are 64
 * characters from `openssl rand -base64 48 | tr '+/' '-_' | tr -d '='`.
 */
export const MIN_EXIT_TOKEN_LENGTH = 43;

export function isStrongExitToken(token: unknown): token is string {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43,512}$/.test(token)) return false;
  // A random 43-character base64url string has ~30 distinct characters; fewer
  // than 16 means a pattern, a repeated character or a word, not a secret.
  return new Set(token).size >= 16;
}

// ---------------------------------------------------------------------------
// /me/vpn contracts
// ---------------------------------------------------------------------------

/** `POST /me/vpn/devices`. The private key never leaves the device; only this is sent. */
export interface CreateVpnDeviceRequest {
  /** What the user calls the device, e.g. "Home router". */
  name: string;
  /** The device's WireGuard public key (canonical base64 of 32 bytes). */
  publicKey: string;
}

/** `PATCH /me/vpn/devices/:id`. */
export interface RenameVpnDeviceRequest {
  name: string;
}

/** A device as the registry stores and returns it — all of what it stores. */
export interface VpnDevice {
  id: string;
  name: string;
  publicKey: string;
  ipv4: string;
  ipv6: string;
  /** ISO 8601. */
  createdAt: string;
}

/** Everything a device needs besides its own key to write a WireGuard config. */
export interface VpnNetwork {
  exits: VpnExit[];
  /**
   * Resolver addresses for the `DNS =` line of an exit WITHOUT its own `dns`:
   * TNP's public resolver, reached through the tunnel. An exit's own list
   * takes precedence (`vpnExitDns`); this one is also what clients that
   * predate per-exit DNS use for every exit.
   */
  dns: string[];
  allowedIPs: string[];
  maxDevices: number;
}

/** `GET /me/vpn/devices`. */
export interface VpnDeviceList {
  devices: VpnDevice[];
  network: VpnNetwork;
}

/** `POST /me/vpn/devices` (201) and `PATCH /me/vpn/devices/:id` (200). */
export interface VpnDeviceResponse {
  device: VpnDevice;
  network: VpnNetwork;
}

export type VpnErrorCode =
  | 'vpn_not_configured'
  /** The VPN runs, but not for this account (`TNP_VPN_ALLOWED_USERS`). */
  | 'vpn_not_available'
  | 'device_limit'
  | 'public_key_in_use'
  | 'address_pool_exhausted';

export interface VpnErrorBody {
  error: string;
  code?: VpnErrorCode;
}

/**
 * A device name: trimmed, 1-64 characters, no control characters. It is shown
 * back to its owner only; it never reaches an exit or a config file.
 */
export function parseVpnDeviceName(value: unknown): ParseResult<string> {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: 'name is required' };
  }
  const name = value.trim();
  if ([...name].length > VPN_DEVICE_NAME_MAX_LENGTH) {
    return { ok: false, error: `name must be at most ${VPN_DEVICE_NAME_MAX_LENGTH} characters` };
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(name)) {
    return { ok: false, error: 'name must not contain control characters' };
  }
  return { ok: true, value: name };
}

const FORBIDDEN_DEVICE_FIELDS = ['privateKey', 'private_key', 'presharedKey'];

export function parseCreateVpnDeviceRequest(body: unknown): ParseResult<CreateVpnDeviceRequest> {
  const r = asRecord(body);
  if (!r) return { ok: false, error: 'body must be a JSON object' };
  // Refused loudly rather than ignored: a client that sends a private key has a
  // bug worth surfacing, and the key must not be accepted even transiently.
  if (FORBIDDEN_DEVICE_FIELDS.some((field) => field in r)) {
    return { ok: false, error: 'never send a private key; send only publicKey' };
  }
  const name = parseVpnDeviceName(r.name);
  if (!name.ok) return name;
  if (!isValidWireGuardPublicKey(r.publicKey)) {
    return {
      ok: false,
      error: 'publicKey must be a WireGuard public key: canonical base64 of 32 bytes',
    };
  }
  return { ok: true, value: { name: name.value, publicKey: r.publicKey } };
}

export function parseRenameVpnDeviceRequest(body: unknown): ParseResult<RenameVpnDeviceRequest> {
  const r = asRecord(body);
  if (!r) return { ok: false, error: 'body must be a JSON object' };
  const name = parseVpnDeviceName(r.name);
  return name.ok ? { ok: true, value: { name: name.value } } : name;
}

// ---------------------------------------------------------------------------
// /exit/peers contract
// ---------------------------------------------------------------------------

/** One peer an exit must accept. Nothing that identifies an account. */
export interface ExitPeer {
  publicKey: string;
  ipv4: string;
  ipv6: string;
}

/** `GET /exit/peers`. */
export interface ExitPeersResponse {
  peers: ExitPeer[];
}

/** Hard cap on peers an exit accepts in one listing: the whole address pool. */
export const MAX_EXIT_PEERS = VPN_MAX_HOST_INDEX - VPN_MIN_HOST_INDEX + 1;

export interface ParsedExitPeers {
  peers: ExitPeer[];
  /** Entries dropped: malformed, outside the pool, or a key or address already taken. */
  rejected: number;
}

/**
 * The exit agent's reading of `GET /exit/peers`.
 *
 * A malformed envelope is refused whole, so the agent keeps the peers it has.
 * A malformed or duplicate ENTRY is dropped on its own and counted: one bad row
 * must not freeze every other device's access, and a second peer claiming a
 * key or an address already listed must not take it over (in WireGuard the
 * last `allowed-ips` set wins).
 */
export function parseExitPeersResponse(body: unknown): ParseResult<ParsedExitPeers> {
  const r = asRecord(body);
  if (!r || !Array.isArray(r.peers)) return { ok: false, error: 'peers must be an array' };
  if (r.peers.length > MAX_EXIT_PEERS) return { ok: false, error: 'too many peers' };
  const peers: ExitPeer[] = [];
  const keys = new Set<string>();
  const addresses = new Set<string>();
  let rejected = 0;
  for (const entry of r.peers) {
    const e = asRecord(entry);
    if (
      !e ||
      !isValidWireGuardPublicKey(e.publicKey) ||
      !isVpnDeviceIpv4(e.ipv4) ||
      !isVpnDeviceIpv6(e.ipv6) ||
      e.ipv6 !== vpnIpv6ForIpv4(e.ipv4) ||
      keys.has(e.publicKey) ||
      addresses.has(e.ipv4)
    ) {
      rejected++;
      continue;
    }
    keys.add(e.publicKey);
    addresses.add(e.ipv4);
    peers.push({ publicKey: e.publicKey, ipv4: e.ipv4, ipv6: e.ipv6 });
  }
  return { ok: true, value: { peers, rejected } };
}

// ---------------------------------------------------------------------------
// The WireGuard config a device runs
// ---------------------------------------------------------------------------

export interface WireGuardConfigInput {
  /** Held by the device only. */
  privateKey: string;
  /** Dial the exit's IP literal instead of its hostname (routers). */
  useEndpointIp?: boolean;
  device: Pick<VpnDevice, 'ipv4' | 'ipv6'>;
  exit: VpnExit;
  /** The network-wide resolvers (`VpnNetwork.dns`); the exit's own `dns` takes precedence. */
  dns: readonly string[];
  allowedIPs: readonly string[];
}

/**
 * The `wg-quick` / WireGuard-app config for one device and one exit — the
 * text the official apps import from a file or a QR code. A config is per
 * exit: the device is a peer on every exit, and switching exits means a
 * different endpoint, public key and (`vpnExitDns`) resolver.
 *
 * Every value is validated before it is written: this text is a config file,
 * and a newline smuggled into any field would add a directive.
 */
export function renderWireGuardConfig(input: WireGuardConfigInput): string {
  const { privateKey, device, exit, allowedIPs } = input;
  const dns = vpnExitDns(exit, input.dns);
  if (!/^[A-Za-z0-9+/]{43}=$/.test(privateKey)) throw new RangeError('invalid private key');
  if (!isVpnDeviceIpv4(device.ipv4) || device.ipv6 !== vpnIpv6ForIpv4(device.ipv4)) {
    throw new RangeError('invalid device address');
  }
  if (!parseVpnExit(exit).ok) throw new RangeError('invalid exit');
  if (dns.length === 0 || !dns.every((ip) => isValidIpv4(ip) || isValidIpv6(ip))) {
    throw new RangeError('invalid DNS servers');
  }
  if (allowedIPs.length === 0 || !allowedIPs.every(isCidr)) {
    throw new RangeError('invalid allowed IPs');
  }
  return [
    '[Interface]',
    `PrivateKey = ${privateKey}`,
    `Address = ${device.ipv4}/32, ${device.ipv6}/128`,
    `DNS = ${dns.join(', ')}`,
    '',
    '[Peer]',
    `# TNP exit ${exit.id} (${exit.region})`,
    `PublicKey = ${exit.publicKey}`,
    `Endpoint = ${input.useEndpointIp ? vpnExitIpEndpoint(exit) : exit.endpoint}`,
    `AllowedIPs = ${allowedIPs.join(', ')}`,
    `PersistentKeepalive = ${VPN_PERSISTENT_KEEPALIVE_SECONDS}`,
    '',
  ].join('\n');
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

/** An IPv4 or IPv6 prefix in `address/length` form. */
export function isCidr(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const slash = value.indexOf('/');
  if (slash === -1) return false;
  const address = value.slice(0, slash);
  const length = value.slice(slash + 1);
  if (!/^(0|[1-9][0-9]{0,2})$/.test(length)) return false;
  if (isValidIpv4(address)) return Number(length) <= 32;
  if (isValidIpv6(address)) return Number(length) <= 128;
  return false;
}
