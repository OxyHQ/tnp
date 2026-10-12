import { describe, expect, test } from 'bun:test';
import dnsPacket from 'dns-packet';
import { encodeTruncated, inspectQuery, MAX_UDP_PAYLOAD } from './guard';
import { isLoopback, rateLimitKey, SourceRateLimiter } from './rate-limit';

const q = (name = 'example.com', extra: Partial<dnsPacket.Packet> = {}) =>
  dnsPacket.encode({
    type: 'query',
    id: 0xbeef,
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ type: 'A', name }],
    ...extra,
  });

describe('inspectQuery', () => {
  test('accepts a plain query and one with EDNS(0)', () => {
    expect(inspectQuery(q(), 'udp').kind).toBe('ok');
    const withOpt = q('example.com', {
      additionals: [
        {
          type: 'OPT',
          name: '.',
          udpPayloadSize: 1232,
          extendedRcode: 0,
          ednsVersion: 0,
          flags: 0,
          flag_do: false,
          options: [],
        },
      ],
    });
    const verdict = inspectQuery(withOpt, 'udp');
    expect(verdict).toMatchObject({ kind: 'ok', ednsSize: 1232 });
  });

  test('drops what is not worth a reply', () => {
    expect(inspectQuery(Buffer.alloc(5), 'udp').kind).toBe('drop');
    expect(inspectQuery(Buffer.alloc(MAX_UDP_PAYLOAD + 1), 'tcp').kind).toBe('drop');
    const response = Buffer.from(q());
    response.writeUInt16BE(response.readUInt16BE(2) | 0x8000, 2);
    expect(inspectQuery(response, 'udp').kind).toBe('drop');
  });

  test('rejects an over-long name', () => {
    // 5 labels of 63 octets: 320 bytes of name, over the 255-octet limit.
    const label = 'a'.repeat(63);
    const header = Buffer.from([0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    const name = Buffer.concat([
      ...Array.from({ length: 5 }, () => Buffer.concat([Buffer.from([63]), Buffer.from(label)])),
      Buffer.from([0]),
    ]);
    const packet = Buffer.concat([header, name, Buffer.from([0, 1, 0, 1])]);
    expect(inspectQuery(packet, 'tcp')).toMatchObject({ kind: 'error', rcode: 'FORMERR' });
  });

  test('encodeTruncated echoes the question with TC and is no larger than the query', () => {
    const query = q('busy.example');
    const verdict = inspectQuery(query, 'udp');
    if (verdict.kind !== 'ok') throw new Error('expected ok');
    const reply = encodeTruncated(query, verdict.questionEnd);
    expect(reply.byteLength).toBeLessThanOrEqual(query.byteLength);
    const decoded = dnsPacket.decode(reply);
    expect(decoded.type).toBe('response');
    expect(decoded.flag_tc).toBe(true);
    expect(decoded.id).toBe(0xbeef);
    expect(decoded.questions?.[0]?.name).toBe('busy.example');
  });
});

describe('SourceRateLimiter', () => {
  test('allows a burst, then refills at the sustained rate', () => {
    let now = 0;
    const limiter = new SourceRateLimiter({ perSecond: 2, burst: 3, now: () => now });
    expect([1, 2, 3, 4].map(() => limiter.allow('198.51.100.7'))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    now += 500; // one token back
    expect(limiter.allow('198.51.100.7')).toBe(true);
    expect(limiter.allow('198.51.100.7')).toBe(false);
    // Another source is unaffected.
    expect(limiter.allow('198.51.100.8')).toBe(true);
  });

  test('the table is bounded however many sources appear', () => {
    const limiter = new SourceRateLimiter({ perSecond: 1, burst: 1, maxEntries: 100 });
    for (let i = 0; i < 10_000; i++)
      limiter.allow(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  test('an IPv6 /64 is one source, and IPv4-mapped addresses fold to IPv4', () => {
    expect(rateLimitKey('2001:db8:1:2::1')).toBe(rateLimitKey('2001:db8:1:2:ffff::9'));
    expect(rateLimitKey('2001:db8:1:2::1')).not.toBe(rateLimitKey('2001:db8:1:3::1'));
    expect(rateLimitKey('::ffff:203.0.113.9')).toBe('203.0.113.9');

    const limiter = new SourceRateLimiter({ perSecond: 1, burst: 1, now: () => 0 });
    expect(limiter.allow('2001:db8:1:2::1')).toBe(true);
    expect(limiter.allow('2001:db8:1:2::abcd')).toBe(false);
  });

  test('loopback detection', () => {
    for (const a of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) {
      expect(isLoopback(a)).toBe(true);
    }
    for (const a of ['10.0.0.1', '128.0.0.1', '::2', '2001:db8::1']) {
      expect(isLoopback(a)).toBe(false);
    }
  });
});
