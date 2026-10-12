/**
 * The dashboard's half of the `/me/vpn` contract, and its config generators.
 *
 * `addDevice` runs against an in-memory API that parses what it receives with
 * the registry's own parser (`parseCreateVpnDeviceRequest`), after a JSON
 * round trip — so the test fails if the page ever sends a body the route
 * refuses, or anything besides `{ name, publicKey }`. The route's half is
 * `apps/api/src/routes/vpn.contract.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { decodeBase64Strict } from '@tnp/crypto';
import { wireGuardPublicKey } from '@tnp/crypto/wireguard';
import {
  parseCreateVpnDeviceRequest,
  parseRenameVpnDeviceRequest,
  type VpnDevice,
  type VpnNetwork,
  vpnIpv6ForIpv4,
} from '@tnp/shared-types';
import { QR_MARGIN, qrMatrix, qrPath } from '../src/lib/qr';
import {
  addDevice,
  classifyLoadFailure,
  configDns,
  httpVpnApi,
  CLIPBOARD_CLEAR_MS,
  copyText,
  OPENWRT_ALLOW_FALLBACK,
  OPENWRT_REMOVE,
  openWrtCommands,
  routerWireGuardConfig,
  suggestVpnExit,
  tunnelFileName,
  type VpnApi,
  wireGuardConfig,
} from '../src/lib/vpn';

const EXIT_KEY = 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=';
const NETWORK: VpnNetwork = {
  exits: [
    {
      id: 'usw2-1',
      region: 'us-west-2',
      endpoint: 'usw2-1.exit.example:51820',
      endpointIp: '203.0.113.10',
      publicKey: EXIT_KEY,
    },
  ],
  dns: ['198.51.100.53'],
  allowedIPs: ['0.0.0.0/0', '::/0'],
  maxDevices: 10,
};

function memoryApi() {
  const bodies: unknown[] = [];
  const devices: VpnDevice[] = [];
  const api: VpnApi = {
    async list() {
      return { devices, network: NETWORK };
    },
    async create(body) {
      const wire = JSON.parse(JSON.stringify(body));
      bodies.push(wire);
      const parsed = parseCreateVpnDeviceRequest(wire);
      if (!parsed.ok) throw new Error(`the API would reject this body: ${parsed.error}`);
      const ipv4 = `10.77.0.${devices.length + 2}`;
      const device: VpnDevice = {
        id: crypto.randomUUID(),
        name: parsed.value.name,
        publicKey: parsed.value.publicKey,
        ipv4,
        ipv6: vpnIpv6ForIpv4(ipv4),
        createdAt: new Date().toISOString(),
      };
      devices.push(device);
      return { device, network: NETWORK };
    },
    async rename(id, body) {
      const parsed = parseRenameVpnDeviceRequest(JSON.parse(JSON.stringify(body)));
      if (!parsed.ok) throw new Error(parsed.error);
      const device = devices.find((d) => d.id === id);
      if (!device) throw new Error('404');
      device.name = parsed.value.name;
      return { device, network: NETWORK };
    },
    async remove() {},
  };
  return { api, bodies };
}

describe('adding a device', () => {
  test('sends exactly { name, publicKey }: the private key never leaves the page', async () => {
    const { api, bodies } = memoryApi();
    const created = await addDevice(api, '  Home router ');
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0] as object).sort()).toEqual(['name', 'publicKey']);
    expect(bodies[0]).toEqual({ name: 'Home router', publicKey: created.keys.publicKey });
    expect(JSON.stringify(bodies)).not.toContain(created.keys.privateKey);
    expect(created.response.device.publicKey).toBe(created.keys.publicKey);
  });

  test('the generated keys are valid 32-byte WireGuard keys that belong together', async () => {
    const { api } = memoryApi();
    for (let i = 0; i < 8; i++) {
      const { keys } = await addDevice(api, `device ${i}`);
      expect(decodeBase64Strict(keys.privateKey, 32)).toHaveLength(32);
      expect(decodeBase64Strict(keys.publicKey, 32)).toHaveLength(32);
      expect(wireGuardPublicKey(keys.privateKey)).toBe(keys.publicKey);
    }
  });

  test('an API answer for another key is refused', async () => {
    const { api } = memoryApi();
    const lying: VpnApi = {
      ...api,
      async create(body) {
        const r = await api.create(body);
        return { ...r, device: { ...r.device, publicKey: EXIT_KEY } };
      },
    };
    await expect(addDevice(lying, 'phone')).rejects.toThrow();
  });

  test('httpVpnApi calls the four routes', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const api = httpVpnApi(async (method, path, options) => {
      calls.push([method, path, options?.body]);
      return { device: {}, network: NETWORK } as never;
    });
    await api.list();
    await api.create({ name: 'a', publicKey: EXIT_KEY });
    await api.rename('id/1', { name: 'b' });
    await api.remove('id/1');
    expect(calls).toEqual([
      ['GET', '/me/vpn/devices', undefined],
      ['POST', '/me/vpn/devices', { name: 'a', publicKey: EXIT_KEY }],
      ['PATCH', '/me/vpn/devices/id%2F1', { name: 'b' }],
      ['DELETE', '/me/vpn/devices/id%2F1', undefined],
    ]);
  });
});

const PRIVATE = 'YNqHbfBQKaGvzefSSL+PvUrXIOwa4ubJ7tFYu4aiTHs=';
const INPUT = {
  privateKey: PRIVATE,
  device: { ipv4: '10.77.3.4', ipv6: vpnIpv6ForIpv4('10.77.3.4') },
  exit: NETWORK.exits[0],
  dns: NETWORK.dns,
  allowedIPs: NETWORK.allowedIPs,
};

describe('wireGuardConfig', () => {
  test('is the full-tunnel config with the TNP resolver', () => {
    const text = wireGuardConfig(INPUT);
    expect(text).toContain(`PrivateKey = ${PRIVATE}\n`);
    expect(text).toContain('Address = 10.77.3.4/32, fd85:d596:af02::a4d:304/128\n');
    expect(text).toContain('DNS = 198.51.100.53\n');
    expect(text).toContain(`PublicKey = ${EXIT_KEY}\n`);
    expect(text).toContain('Endpoint = usw2-1.exit.example:51820\n');
    expect(text).toContain('AllowedIPs = 0.0.0.0/0, ::/0\n');
    expect(text).toContain('PersistentKeepalive = 25\n');
  });
});

describe("a config per exit, with that exit's resolver", () => {
  const EU = {
    id: 'euc1-1',
    region: 'eu-central-1',
    endpoint: 'euc1-1.exit.example:51820',
    endpointIp: '203.0.113.20',
    publicKey: 'Hq4JkVtCzIhSOrYnh2Gu9zHwwA2tbXdn/VvjBGPcRk4=',
    dns: ['10.77.0.1'],
  };
  const EU_INPUT = { ...INPUT, exit: EU };

  test('wg-quick (file and QR code), router and uci all name the exit resolver', () => {
    expect(configDns(EU_INPUT)).toEqual(['10.77.0.1']);
    expect(configDns(INPUT)).toEqual(['198.51.100.53']);
    for (const text of [wireGuardConfig(EU_INPUT), routerWireGuardConfig(EU_INPUT)]) {
      expect(text).toContain('DNS = 10.77.0.1\n');
      expect(text).not.toContain('198.51.100.53');
      expect(text).toContain(`PublicKey = ${EU.publicKey}\n`);
    }
    expect(routerWireGuardConfig(EU_INPUT)).toContain('Endpoint = 203.0.113.20:51820\n');
    const uci = openWrtCommands(EU_INPUT);
    expect(uci).toContain("uci add_list network.wg0.dns='10.77.0.1'\n");
    expect(uci).not.toContain('198.51.100.53');
    expect(uci).toContain("uci set network.wg0_tnp.endpoint_host='203.0.113.20'\n");
  });

  test('a 403 vpn_not_available is "not for your account", a 503 is "not yet", the rest errors', () => {
    expect(classifyLoadFailure(403, 'vpn_not_available')).toBe('notAllowed');
    expect(classifyLoadFailure(503, 'vpn_not_configured')).toBe('unavailable');
    expect(classifyLoadFailure(403, undefined)).toBe('error');
    expect(classifyLoadFailure(503, 'vpn_not_available')).toBe('error');
    expect(classifyLoadFailure(undefined, undefined)).toBe('error');
  });

  test('the page offers the exit nearest the time zone first', () => {
    const exits = [NETWORK.exits[0], EU];
    expect(suggestVpnExit(exits, 'Europe/Paris')?.id).toBe('euc1-1');
    expect(suggestVpnExit(exits, 'America/Los_Angeles')?.id).toBe('usw2-1');
  });
});

describe('openWrtCommands', () => {
  const KILL_SWITCH = [
    "for s in $(uci -X show firewall | sed -n 's/^firewall\\.\\([^.=]*\\)=forwarding$/\\1/p'); do",
    '  [ "$(uci -q get firewall.$s.src)" = lan ] && [ "$(uci -q get firewall.$s.dest)" = wan ] && uci delete firewall.$s',
    'done',
  ];
  const reviewed = (killSwitch: boolean) =>
    [
      'uci -q delete network.wg0',
      'uci set network.wg0=interface',
      "uci set network.wg0.proto='wireguard'",
      `uci set network.wg0.private_key='${PRIVATE}'`,
      "uci add_list network.wg0.addresses='10.77.3.4/32'",
      "uci add_list network.wg0.addresses='fd85:d596:af02::a4d:304/128'",
      "uci add_list network.wg0.dns='198.51.100.53'",
      'uci -q delete network.wg0_tnp',
      'uci set network.wg0_tnp=wireguard_wg0',
      "uci set network.wg0_tnp.description='TNP exit usw2-1'",
      `uci set network.wg0_tnp.public_key='${EXIT_KEY}'`,
      "uci set network.wg0_tnp.endpoint_host='203.0.113.10'",
      "uci set network.wg0_tnp.endpoint_port='51820'",
      "uci add_list network.wg0_tnp.allowed_ips='0.0.0.0/0'",
      "uci add_list network.wg0_tnp.allowed_ips='::/0'",
      "uci set network.wg0_tnp.route_allowed_ips='1'",
      "uci set network.wg0_tnp.persistent_keepalive='25'",
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
      'uci -q delete firewall.tnp_no_v6_wan',
      'uci set firewall.tnp_no_v6_wan=rule',
      "uci set firewall.tnp_no_v6_wan.name='TNP: no LAN IPv6 to the provider'",
      "uci set firewall.tnp_no_v6_wan.family='ipv6'",
      "uci set firewall.tnp_no_v6_wan.src='lan'",
      "uci set firewall.tnp_no_v6_wan.dest='wan'",
      "uci set firewall.tnp_no_v6_wan.proto='all'",
      "uci set firewall.tnp_no_v6_wan.target='REJECT'",
      'uci -q delete firewall.tnp_no_v6_tnp',
      'uci set firewall.tnp_no_v6_tnp=rule',
      "uci set firewall.tnp_no_v6_tnp.name='TNP: IPv6 is not carried'",
      "uci set firewall.tnp_no_v6_tnp.family='ipv6'",
      "uci set firewall.tnp_no_v6_tnp.src='lan'",
      "uci set firewall.tnp_no_v6_tnp.dest='tnp'",
      "uci set firewall.tnp_no_v6_tnp.proto='all'",
      "uci set firewall.tnp_no_v6_tnp.target='REJECT'",
      ...(killSwitch ? KILL_SWITCH : []),
      'uci commit network',
      'uci commit firewall',
      'service network restart',
      'service firewall restart',
      '',
    ].join('\n');

  test('matches the reviewed command list, with the kill switch on by default', () => {
    expect(openWrtCommands(INPUT)).toBe(reviewed(true));
    expect(openWrtCommands(INPUT, { killSwitch: true })).toBe(reviewed(true));
  });

  test('the kill switch is an explicit opt-out', () => {
    expect(openWrtCommands(INPUT, { killSwitch: false })).toBe(reviewed(false));
  });

  test('no IPv6 leak: source routing off, LAN IPv6 refused towards wan and tnp', () => {
    for (const killSwitch of [true, false]) {
      const text = openWrtCommands(INPUT, { killSwitch });
      expect(text).toContain("uci set network.wan6.sourcefilter='0'");
      expect(text).toContain("uci set firewall.tnp_no_v6_wan.dest='wan'");
      expect(text).toContain("uci set firewall.tnp_no_v6_tnp.dest='tnp'");
      expect(text.match(/target='REJECT'/g)).toHaveLength(2);
    }
  });

  test('the router dials the exit by IP literal, never the hostname (it has no DNS before the tunnel)', () => {
    const text = openWrtCommands(INPUT);
    expect(text).not.toContain('usw2-1.exit.example');
    expect(routerWireGuardConfig(INPUT)).toContain('Endpoint = 203.0.113.10:51820\n');
    expect(routerWireGuardConfig(INPUT)).not.toContain('usw2-1.exit.example');
    const v6 = { ...INPUT.exit, endpointIp: '2001:db8::7' };
    expect(openWrtCommands({ ...INPUT, exit: v6 })).toContain(
      "uci set network.wg0_tnp.endpoint_host='2001:db8::7'",
    );
    expect(routerWireGuardConfig({ ...INPUT, exit: v6 })).toContain(
      'Endpoint = [2001:db8::7]:51820\n',
    );
  });

  test('refuses any value that could break out of a quoted word', () => {
    expect(() => openWrtCommands({ ...INPUT, privateKey: "x'; reboot; '" })).toThrow();
    expect(() => openWrtCommands({ ...INPUT, dns: ["1.1.1.1'; reboot"] })).toThrow();
    expect(() =>
      openWrtCommands({ ...INPUT, exit: { ...INPUT.exit, endpointIp: "1.2.3.4'; reboot" } }),
    ).toThrow();
  });

  test('allowing fallback and removing TNP restore lan → wan forwarding and source routing', () => {
    expect(OPENWRT_ALLOW_FALLBACK).toContain("uci set firewall.tnp_fallback.dest='wan'");
    expect(OPENWRT_REMOVE).toContain("uci set firewall.tnp_fallback.dest='wan'");
    expect(OPENWRT_REMOVE).toContain("uci set network.wan6.sourcefilter='1'");
    expect(OPENWRT_REMOVE).toContain("uci set network.wan.peerdns='1'");
    for (const section of ['wg0', 'wg0_tnp'])
      expect(OPENWRT_REMOVE).toContain(`uci -q delete network.${section}`);
    for (const section of ['tnp', 'tnp_lan', 'tnp_no_v6_wan', 'tnp_no_v6_tnp']) {
      expect(OPENWRT_REMOVE).toContain(`uci -q delete firewall.${section}\n`);
    }
  });
});

describe('copying a secret', () => {
  test('the clipboard is overwritten after 60 s if it still holds the secret', async () => {
    let clip = '';
    const timers: Array<[() => void, number]> = [];
    const clipboard = {
      writeText: async (t: string) => {
        clip = t;
      },
      readText: async () => clip,
    };
    await copyText(clipboard, 'PrivateKey = x', true, (fn, ms) => timers.push([fn, ms]));
    expect(clip).toBe('PrivateKey = x');
    expect(timers.map(([, ms]) => ms)).toEqual([CLIPBOARD_CLEAR_MS]);
    expect(CLIPBOARD_CLEAR_MS).toBe(60_000);
    timers[0]?.[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(clip).toBe('');
  });

  test('something else copied since is left alone; public text is not scheduled', async () => {
    let clip = '';
    const timers: Array<() => void> = [];
    const clipboard = {
      writeText: async (t: string) => {
        clip = t;
      },
      readText: async () => clip,
    };
    await copyText(clipboard, 'secret', true, (fn) => timers.push(fn));
    clip = 'the user copied something else';
    timers[0]?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(clip).toBe('the user copied something else');
    const before = timers.length;
    await copyText(clipboard, 'sudo wg-quick up tnp', false, (fn) => timers.push(fn));
    expect(timers.length).toBe(before);
  });
});

describe('tunnelFileName', () => {
  test('is a name wg-quick and the Windows app accept', () => {
    for (const name of [
      'Home router',
      'Téléphone de Léa',
      '电脑',
      '../../etc/passwd',
      'a'.repeat(64),
    ]) {
      const file = tunnelFileName(name);
      expect(file).toMatch(/^[A-Za-z0-9_=+.-]{1,15}$/);
      expect(file.startsWith('tnp')).toBe(true);
    }
    expect(tunnelFileName('Home router')).toBe('tnp-Home-router');
    expect(tunnelFileName('电脑')).toBe('tnp');
    expect(tunnelFileName('Téléphone')).toBe('tnp-Telephone');
  });
});

describe('QR code', () => {
  test('encodes a whole config as a valid symbol with finder patterns in three corners', () => {
    const matrix = qrMatrix(wireGuardConfig(INPUT));
    expect((matrix.size - 17) % 4).toBe(0);
    expect(matrix.size).toBeGreaterThan(21);
    // A finder pattern: a dark 7×7 ring around a light ring around a dark 3×3.
    const finder = (r0: number, c0: number) => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const ring = r === 0 || r === 6 || c === 0 || c === 6;
          const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          expect(matrix.isDark(r0 + r, c0 + c)).toBe(ring || core);
        }
      }
    };
    finder(0, 0);
    finder(0, matrix.size - 7);
    finder(matrix.size - 7, 0);
    const path = qrPath(matrix);
    expect(path.startsWith(`M${QR_MARGIN} ${QR_MARGIN}h7`)).toBe(true);
    expect(path).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
  });
});
