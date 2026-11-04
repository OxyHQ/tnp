import { describe, expect, test } from 'bun:test';
import type { Request } from 'express';
import { addressIn, addressKey, buildAddressSet, clientAddress, unmapIpv4 } from './clientIp.js';

/** A request as the task sees it: the socket peer and the forwarded chain. */
function request(socketPeer: string, forwardedFor?: string): Request {
  return {
    socket: { remoteAddress: socketPeer },
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  } as unknown as Request;
}

const ALB = '10.0.3.17';
const CLOUDFLARE_EDGE = '162.158.1.1';

describe('clientAddress', () => {
  test('through Cloudflare and the ALB, the client Cloudflare saw', () => {
    expect(clientAddress(request(ALB, `198.51.100.7, ${CLOUDFLARE_EDGE}`))).toBe('198.51.100.7');
  });

  test('straight to the ALB, the address the ALB saw', () => {
    expect(clientAddress(request(ALB, '203.0.113.50'))).toBe('203.0.113.50');
  });

  test('a forged entry left of a non-Cloudflare hop is never read', () => {
    // A client that bypasses Cloudflare writes its own X-Forwarded-For; the
    // ALB appends the real peer after it, and only that is believed.
    expect(clientAddress(request(ALB, '198.51.100.7, 203.0.113.50'))).toBe('203.0.113.50');
  });

  test("a forged entry left of Cloudflare's append is never read", () => {
    expect(clientAddress(request(ALB, `1.1.1.1, 198.51.100.7, ${CLOUDFLARE_EDGE}`))).toBe(
      '198.51.100.7',
    );
  });

  test('a public socket peer has no proxy in front: the header is ignored', () => {
    expect(clientAddress(request('203.0.113.50', '198.51.100.7'))).toBe('203.0.113.50');
  });

  test('an IPv4-mapped socket peer is unmapped', () => {
    expect(clientAddress(request('::ffff:203.0.113.50'))).toBe('203.0.113.50');
  });

  test('a closed socket has no address', () => {
    expect(clientAddress({ socket: {}, headers: {} } as unknown as Request)).toBe('');
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
