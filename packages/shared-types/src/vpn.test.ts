import { describe, expect, test } from 'bun:test';
import { generateWireGuardKeyPair } from '@tnp/crypto/wireguard';
import {
  isCidr,
  isVpnDeviceIpv4,
  isVpnDeviceIpv6,
  parseCreateVpnDeviceRequest,
  parseExitPeersResponse,
  parseRenameVpnDeviceRequest,
  parseVpnExit,
  renderWireGuardConfig,
  splitVpnEndpoint,
  VPN_ALLOWED_IPS,
  vpnIndexOfIpv4,
  vpnIpv4ForIndex,
  vpnIpv6ForIpv4,
} from './vpn';

const key = () => generateWireGuardKeyPair().publicKey;
const EXIT = {
  id: 'usw2-1',
  region: 'us-west-2',
  endpoint: 'usw2-1.exit.example:51820',
  publicKey: key(),
};

describe('tunnel addresses', () => {
  test('the device range is 10.77.0.2 – 10.77.255.254, never the exit or the edges', () => {
    expect(vpnIpv4ForIndex(2)).toBe('10.77.0.2');
    expect(vpnIpv4ForIndex(65_534)).toBe('10.77.255.254');
    expect(vpnIpv4ForIndex(0x0304)).toBe('10.77.3.4');
    expect(vpnIndexOfIpv4('10.77.3.4')).toBe(0x0304);
    for (const bad of [
      '10.77.0.0',
      '10.77.0.1',
      '10.77.255.255',
      '10.78.0.2',
      '10.77.03.4',
      '10.77.3',
      7,
    ]) {
      expect(isVpnDeviceIpv4(bad)).toBe(false);
    }
  });

  test('IPv6 is derived from IPv4 in one spelling only', () => {
    expect(vpnIpv6ForIpv4('10.77.3.4')).toBe('fd85:d596:af02::a4d:304');
    expect(vpnIpv6ForIpv4('10.77.0.2')).toBe('fd85:d596:af02::a4d:2');
    expect(isVpnDeviceIpv6('fd85:d596:af02::a4d:304')).toBe(true);
    for (const bad of [
      'fd85:d596:af02::a4d:0304',
      'FD85:d596:af02::a4d:304',
      'fd85:d596:af02:0:0:0:a4d:304',
      'fd85:d596:af02::a4d:1',
      'fd85:d596:af02::a4d:ffff',
      'fd85:d596:af02::1',
    ]) {
      expect(isVpnDeviceIpv6(bad)).toBe(false);
    }
    expect(() => vpnIpv6ForIpv4('10.77.0.1')).toThrow();
  });
});

describe('endpoints and exits', () => {
  test('host:port with a hostname, IPv4 or bracketed IPv6', () => {
    expect(splitVpnEndpoint('exit.tnp.network:51820')).toEqual({
      host: 'exit.tnp.network',
      port: 51820,
    });
    expect(splitVpnEndpoint('203.0.113.7:51820')).toEqual({ host: '203.0.113.7', port: 51820 });
    expect(splitVpnEndpoint('[2001:db8::1]:51820')).toEqual({ host: '2001:db8::1', port: 51820 });
    for (const bad of [
      'exit.tnp.network',
      'exit.tnp.network:0',
      'exit.tnp.network:65536',
      'Exit.tnp.network:51820',
      'localhost:51820',
      '2001:db8::1:51820',
      '999.1.1.1:51820',
      'exit.tnp.network:51820\nPostUp = x',
      'exit tnp:51820',
    ]) {
      expect(splitVpnEndpoint(bad)).toBeNull();
    }
  });

  test('an exit needs every field valid', () => {
    expect(parseVpnExit(EXIT)).toEqual({ ok: true, value: EXIT });
    expect(parseVpnExit({ ...EXIT, publicKey: 'AAAA' }).ok).toBe(false);
    expect(parseVpnExit({ ...EXIT, id: 'Bad Id' }).ok).toBe(false);
    expect(parseVpnExit({ ...EXIT, region: 'line\nbreak' }).ok).toBe(false);
    expect(parseVpnExit({ ...EXIT, endpoint: 'nope' }).ok).toBe(false);
  });
});

describe('POST /me/vpn/devices body', () => {
  test('accepts a name and a WireGuard public key, trimmed', () => {
    const publicKey = key();
    expect(parseCreateVpnDeviceRequest({ name: '  Home router ', publicKey })).toEqual({
      ok: true,
      value: { name: 'Home router', publicKey },
    });
  });

  test('refuses a bad key, a bad name, and any private key', () => {
    const pair = generateWireGuardKeyPair();
    const cases: Array<[unknown, string]> = [
      [null, 'body must be a JSON object'],
      [[], 'body must be a JSON object'],
      [{ publicKey: pair.publicKey }, 'name is required'],
      [{ name: 'x'.repeat(65), publicKey: pair.publicKey }, 'name must be at most 64 characters'],
      [{ name: 'a\nb', publicKey: pair.publicKey }, 'name must not contain control characters'],
      [{ name: 'phone' }, 'publicKey must be a WireGuard public key: canonical base64 of 32 bytes'],
      [
        { name: 'phone', publicKey: `${'A'.repeat(43)}=` },
        'publicKey must be a WireGuard public key: canonical base64 of 32 bytes',
      ],
      [
        { name: 'phone', publicKey: pair.publicKey, privateKey: pair.privateKey },
        'never send a private key; send only publicKey',
      ],
    ];
    for (const [body, error] of cases) {
      expect(parseCreateVpnDeviceRequest(body)).toEqual({ ok: false, error });
    }
    expect(
      parseCreateVpnDeviceRequest({ name: 'x'.repeat(64), publicKey: pair.publicKey }).ok,
    ).toBe(true);
    // Characters, not UTF-16 units: 64 emoji is a valid name.
    expect(
      parseCreateVpnDeviceRequest({ name: '🛰'.repeat(64), publicKey: pair.publicKey }).ok,
    ).toBe(true);
  });

  test('rename takes a name only', () => {
    expect(parseRenameVpnDeviceRequest({ name: ' Laptop ' })).toEqual({
      ok: true,
      value: { name: 'Laptop' },
    });
    expect(parseRenameVpnDeviceRequest({ name: '' }).ok).toBe(false);
  });
});

describe('GET /exit/peers response', () => {
  const peer = (n: number, publicKey = key()) => ({
    publicKey,
    ipv4: vpnIpv4ForIndex(n),
    ipv6: vpnIpv6ForIpv4(vpnIpv4ForIndex(n)),
  });

  test('keeps valid peers and counts the dropped ones', () => {
    const a = peer(2);
    const b = peer(3);
    const parsed = parseExitPeersResponse({
      peers: [
        a,
        b,
        { ...peer(4), publicKey: 'nope' },
        { ...peer(5), ipv4: '10.77.0.1' },
        { ...peer(6), ipv6: vpnIpv6ForIpv4('10.77.0.7') },
        peer(7, a.publicKey), // key taken
        { ...peer(8), ipv4: a.ipv4, ipv6: a.ipv6 }, // address taken
        'string',
      ],
    });
    expect(parsed).toEqual({ ok: true, value: { peers: [a, b], rejected: 6 } });
  });

  test('strips fields outside the contract', () => {
    const a = peer(9);
    const parsed = parseExitPeersResponse({ peers: [{ ...a, userId: 'u1' }] });
    expect(parsed.ok && parsed.value.peers).toEqual([a]);
  });

  test('refuses a malformed envelope whole', () => {
    expect(parseExitPeersResponse([]).ok).toBe(false);
    expect(parseExitPeersResponse({ peers: {} }).ok).toBe(false);
    expect(parseExitPeersResponse(null).ok).toBe(false);
  });
});

describe('renderWireGuardConfig', () => {
  const pair = generateWireGuardKeyPair();
  const input = {
    privateKey: pair.privateKey,
    device: { ipv4: '10.77.3.4', ipv6: vpnIpv6ForIpv4('10.77.3.4') },
    exit: EXIT,
    dns: ['198.51.100.53'],
    allowedIPs: VPN_ALLOWED_IPS,
  };

  test('writes the full-tunnel config the WireGuard apps import', () => {
    expect(renderWireGuardConfig(input)).toBe(
      [
        '[Interface]',
        `PrivateKey = ${pair.privateKey}`,
        'Address = 10.77.3.4/32, fd85:d596:af02::a4d:304/128',
        'DNS = 198.51.100.53',
        '',
        '[Peer]',
        '# TNP exit usw2-1 (us-west-2)',
        `PublicKey = ${EXIT.publicKey}`,
        'Endpoint = usw2-1.exit.example:51820',
        'AllowedIPs = 0.0.0.0/0, ::/0',
        'PersistentKeepalive = 25',
        '',
      ].join('\n'),
    );
  });

  test('refuses any value that could add a directive', () => {
    expect(() =>
      renderWireGuardConfig({ ...input, privateKey: `${pair.privateKey}\nPostUp=x` }),
    ).toThrow();
    expect(() => renderWireGuardConfig({ ...input, dns: ['1.1.1.1\nPostUp = x'] })).toThrow();
    expect(() => renderWireGuardConfig({ ...input, dns: [] })).toThrow();
    expect(() => renderWireGuardConfig({ ...input, allowedIPs: ['0.0.0.0/0\n'] })).toThrow();
    expect(() =>
      renderWireGuardConfig({ ...input, exit: { ...EXIT, endpoint: 'a.example:1\nPostUp = x' } }),
    ).toThrow();
    expect(() =>
      renderWireGuardConfig({ ...input, device: { ipv4: '10.77.3.4', ipv6: '::1' } }),
    ).toThrow();
  });

  test('isCidr', () => {
    for (const ok of ['0.0.0.0/0', '::/0', '10.0.0.0/8', 'fd00::/7']) expect(isCidr(ok)).toBe(true);
    for (const bad of ['10.0.0.0', '10.0.0.0/33', '::/129', 'x/1', '10.0.0.0/08'])
      expect(isCidr(bad)).toBe(false);
  });
});
