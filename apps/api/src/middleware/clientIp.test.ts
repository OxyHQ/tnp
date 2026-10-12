import { describe, expect, test } from 'bun:test';
import type { Request } from 'express';
import {
  addressIn,
  addressKey,
  buildAddressSet,
  clientAddress,
  CLOUDFLARE_IP_RANGES,
  peerAddress,
  unmapIpv4,
} from './clientIp.js';

const cloudflare = buildAddressSet(CLOUDFLARE_IP_RANGES).set;

function request(ip: string, cfConnectingIp?: string, forwardedFor?: string): Request {
  return {
    socket: { remoteAddress: ip },
    get: (name: string) => {
      const header = name.toLowerCase();
      if (header === 'cf-connecting-ip') return cfConnectingIp;
      if (header === 'x-forwarded-for') return forwardedFor;
      return undefined;
    },
  } as unknown as Request;
}

const settings = (trustCloudflareHeader: boolean) => ({
  trustProxyHops: 0,
  trustCloudflareHeader,
  cloudflare,
});

describe('peerAddress', () => {
  test('with no trusted hop, X-Forwarded-For is ignored entirely', () => {
    expect(peerAddress(request('10.0.0.9', undefined, '198.51.100.7'), 0)).toBe('10.0.0.9');
  });

  test('one trusted hop (the ALB) reads only the entry the ALB appended', () => {
    // The client wrote `1.1.1.1`; Cloudflare appended the client's real
    // address; the ALB appended the Cloudflare edge it saw.
    const req = request('10.0.0.9', undefined, '1.1.1.1, 198.51.100.7, 162.158.1.1');
    expect(peerAddress(req, 1)).toBe('162.158.1.1');
  });

  test('a client reaching the ALB directly cannot forge its peer', () => {
    const req = request('10.0.0.9', undefined, '162.158.1.1, 203.0.113.50');
    expect(peerAddress(req, 1)).toBe('203.0.113.50');
  });

  test('more hops than entries falls back to the leftmost, never past it', () => {
    expect(peerAddress(request('10.0.0.9', undefined, '203.0.113.50'), 5)).toBe('203.0.113.50');
    expect(peerAddress(request('10.0.0.9'), 1)).toBe('10.0.0.9');
  });

  test('a malformed trusted entry falls back to the socket peer', () => {
    expect(peerAddress(request('10.0.0.9', undefined, 'garbage'), 1)).toBe('10.0.0.9');
  });
});

describe('clientAddress', () => {
  test('uses the peer address when the Cloudflare header is not trusted', () => {
    const req = request('162.158.1.1', '198.51.100.7');
    expect(clientAddress(req, settings(false))).toBe('162.158.1.1');
  });

  test('a Cloudflare peer behind the ALB, end to end', () => {
    const req = request('10.0.0.9', '198.51.100.7', '6.6.6.6, 198.51.100.7, 162.158.1.1');
    expect(clientAddress(req, { ...settings(true), trustProxyHops: 1 })).toBe('198.51.100.7');
  });

  test('takes CF-Connecting-IP from a Cloudflare peer when trusted', () => {
    const req = request('162.158.1.1', '198.51.100.7');
    expect(clientAddress(req, settings(true))).toBe('198.51.100.7');
  });

  test('ignores CF-Connecting-IP from a peer outside Cloudflare: it would be forged', () => {
    // A client that reaches the ALB directly can send any header it likes.
    const req = request('203.0.113.50', '198.51.100.7');
    expect(clientAddress(req, settings(true))).toBe('203.0.113.50');
  });

  test('ignores a CF-Connecting-IP that is not an address', () => {
    const req = request('162.158.1.1', 'not-an-ip');
    expect(clientAddress(req, settings(true))).toBe('162.158.1.1');
  });

  test('recognises an IPv4-mapped Cloudflare peer', () => {
    const req = request('::ffff:162.158.1.1', '198.51.100.7');
    expect(clientAddress(req, settings(true))).toBe('198.51.100.7');
  });
});

describe('addressKey', () => {
  test('an IPv4 address is its own key', () => {
    expect(addressKey('198.51.100.7')).toBe('198.51.100.7');
    expect(addressKey('::ffff:198.51.100.7')).toBe('198.51.100.7');
  });

  test('IPv6 addresses in one /64 share a key, whatever their spelling', () => {
    const key = addressKey('2001:db8:aa:bb::1');
    expect(addressKey('2001:db8:aa:bb:ffff:ffff:ffff:ffff')).toBe(key);
    expect(addressKey('2001:0db8:00aa:00bb:0000:0000:0000:0002')).toBe(key);
    expect(addressKey('2001:db8:aa:bc::1')).not.toBe(key);
  });
});

describe('buildAddressSet', () => {
  test('matches addresses and subnets, and reports what it could not parse', () => {
    const { set, invalid } = buildAddressSet([
      '198.51.100.7',
      '10.0.0.0/8',
      'nonsense',
      '1.2.3.4/40',
    ]);
    expect(addressIn(set, '198.51.100.7')).toBe(true);
    expect(addressIn(set, '10.200.0.1')).toBe(true);
    expect(addressIn(set, '198.51.100.8')).toBe(false);
    expect(invalid).toEqual(['nonsense', '1.2.3.4/40']);
  });

  test('unmapIpv4 leaves real IPv6 alone', () => {
    expect(unmapIpv4('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(unmapIpv4('2001:db8::1')).toBe('2001:db8::1');
  });
});
