import { afterEach, describe, expect, test } from 'bun:test';
import dnsPacket from 'dns-packet';
import { DEFAULT_UPSTREAM_DNS } from '../config';
import { parseUpstreams } from '../proxy';
import { isResponseTo, parseUpstream, queryUpstream } from './upstream';
import { upstreamQuery } from './wire';

describe('parseUpstream', () => {
  test('a bare IPv4 address is classic DNS on port 53', () => {
    expect(parseUpstream('1.1.1.1')).toEqual({
      transport: 'classic',
      address: '1.1.1.1',
      port: 53,
    });
  });

  test('an explicit port is honoured', () => {
    expect(parseUpstream('1.1.1.1:5353')).toEqual({
      transport: 'classic',
      address: '1.1.1.1',
      port: 5353,
    });
  });

  test('a bracketed IPv6 address parses, with and without a port', () => {
    expect(parseUpstream('[2606:4700:4700::1111]')).toEqual({
      transport: 'classic',
      address: '2606:4700:4700::1111',
      port: 53,
    });
    expect(parseUpstream('[2606:4700:4700::1111]:5353')).toEqual({
      transport: 'classic',
      address: '2606:4700:4700::1111',
      port: 5353,
    });
  });

  test('a bare IPv6 address is not mistaken for host:port', () => {
    // The colons in an IPv6 literal must not be read as a port separator, or
    // the resolver silently talks to the wrong address on the wrong port.
    expect(parseUpstream('2606:4700:4700::1111')).toEqual({
      transport: 'classic',
      address: '2606:4700:4700::1111',
      port: 53,
    });
  });

  test('an https URL is DoH', () => {
    expect(parseUpstream('https://cloudflare-dns.com/dns-query')).toEqual({
      transport: 'doh',
      address: 'https://cloudflare-dns.com/dns-query',
    });
  });

  test('plain http and other schemes are refused, not read as an address', () => {
    // DoH without TLS is plaintext DNS with extra steps.
    expect(() => parseUpstream('http://dns.example/dns-query')).toThrow(/unsupported upstream/);
    expect(() => parseUpstream('tls://1.1.1.1')).toThrow(/unsupported upstream/);
  });

  test('the default is encrypted: every default upstream is DoH', () => {
    const list = parseUpstreams(DEFAULT_UPSTREAM_DNS);
    expect(list.length).toBeGreaterThanOrEqual(2);
    for (const upstream of list) expect(upstream.transport).toBe('doh');
    // Two different operators, so one being blocked is not an outage.
    expect(new Set(list.map((u) => new URL(u.address).hostname)).size).toBe(list.length);
  });

  test('surrounding whitespace is ignored', () => {
    expect(parseUpstream('  1.1.1.1  ').address).toBe('1.1.1.1');
  });
});

describe('parseUpstreams', () => {
  test('splits a comma-separated list, preserving failover order', () => {
    const list = parseUpstreams('1.1.1.1, 8.8.8.8, https://dns.example/dns-query');
    expect(list).toHaveLength(3);
    expect(list[0].address).toBe('1.1.1.1');
    expect(list[1].address).toBe('8.8.8.8');
    expect(list[2].transport).toBe('doh');
  });

  test('ignores empty entries', () => {
    expect(parseUpstreams('1.1.1.1,,  ,8.8.8.8')).toHaveLength(2);
  });

  test('refuses to start with no upstream rather than picking one silently', () => {
    // A resolver that quietly falls back to a built-in upstream is how every
    // TNP user's public DNS ended up at one hardcoded third party regardless of
    // configuration (audit B4).
    expect(() => parseUpstreams('')).toThrow(/No upstream DNS resolver configured/);
    expect(() => parseUpstreams('   ,  ')).toThrow(/No upstream DNS resolver configured/);
  });
});

// ---------------------------------------------------------------------------
// DNS-over-HTTPS on the wire (RFC 8484), against a local HTTP server. The
// transport code is the same for https://; only the URL scheme differs, and
// parseUpstream is bypassed because it rightly refuses http://.
// ---------------------------------------------------------------------------

function sampleQuery(name = 'example.com', id = 0x5151): dnsPacket.DecodedPacket {
  return dnsPacket.decode(
    dnsPacket.encode({
      type: 'query',
      id,
      flags: dnsPacket.RECURSION_DESIRED,
      questions: [{ type: 'A', name }],
    }),
  );
}

interface Captured {
  method: string;
  contentType: string | null;
  accept: string | null;
  body: Buffer;
  url: string;
}

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  while (servers.length > 0) servers.pop()?.stop(true);
});

function dohServer(respond: (query: Buffer) => Response): { url: string; seen: Captured[] } {
  const seen: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const body = Buffer.from(await req.arrayBuffer());
      seen.push({
        method: req.method,
        contentType: req.headers.get('content-type'),
        accept: req.headers.get('accept'),
        body,
        url: req.url,
      });
      return respond(body);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/dns-query`, seen };
}

function answerFor(queryBuf: Buffer, overrides: Partial<dnsPacket.Packet> = {}): Buffer {
  const q = dnsPacket.decode(queryBuf);
  return dnsPacket.encode({
    type: 'response',
    id: q.id,
    flags: dnsPacket.RECURSION_AVAILABLE,
    questions: q.questions,
    answers: [{ type: 'A', name: q.questions?.[0]?.name ?? '', ttl: 30, data: '192.0.2.7' }],
    ...overrides,
  });
}

const dnsMessage = (body: Buffer, contentType = 'application/dns-message') =>
  new Response(new Uint8Array(body), { headers: { 'content-type': contentType } });

describe('DoH transport', () => {
  test('POSTs the wire format with ID 0, padded to a 128-byte block, and restores the ID', async () => {
    const server = dohServer((body) => dnsMessage(answerFor(body)));
    const outgoing = upstreamQuery(sampleQuery('example.com', 0x5151), { pad: true });

    const response = await queryUpstream({ transport: 'doh', address: server.url }, outgoing);

    const [req] = server.seen;
    expect(req.method).toBe('POST');
    expect(req.contentType).toBe('application/dns-message');
    expect(req.accept).toBe('application/dns-message');
    expect(new URL(req.url).search).toBe(''); // the name never rides in a URL
    expect(req.body.readUInt16BE(0)).toBe(0);
    expect(req.body.byteLength % 128).toBe(0);
    const opt = dnsPacket.decode(req.body).additionals?.find((r) => r.type === 'OPT');
    if (opt?.type === 'OPT') {
      expect(opt.flag_do).toBe(false);
      expect(opt.options.map((o) => o.code)).toEqual([12]);
    } else {
      throw new Error('no OPT record sent');
    }

    const decoded = dnsPacket.decode(response);
    expect(decoded.id).toBe(0x5151);
    expect(decoded.answers?.[0]).toMatchObject({ data: '192.0.2.7' });
  });

  test('padding hides the name length: short and long names send equal sizes', () => {
    const short = upstreamQuery(sampleQuery('a.io'), { pad: true });
    const long = upstreamQuery(sampleQuery('a-much-longer-name.example.org'), { pad: true });
    expect(short.byteLength).toBe(long.byteLength);
  });

  test('refuses an answer to a different question', async () => {
    const server = dohServer((body) =>
      dnsMessage(answerFor(body, { questions: [{ type: 'A', name: 'evil.example' }] })),
    );
    const outgoing = upstreamQuery(sampleQuery(), { pad: true });
    await expect(
      queryUpstream({ transport: 'doh', address: server.url }, outgoing),
    ).rejects.toThrow(/does not match/);
  });

  test('refuses a non-2xx status, the JSON API, and an oversized body', async () => {
    const outgoing = upstreamQuery(sampleQuery(), { pad: true });

    const failing = dohServer(() => new Response('nope', { status: 505 }));
    await expect(
      queryUpstream({ transport: 'doh', address: failing.url }, outgoing),
    ).rejects.toThrow(/HTTP 505/);

    const json = dohServer(() => Response.json({ Status: 0, Answer: [] }));
    await expect(queryUpstream({ transport: 'doh', address: json.url }, outgoing)).rejects.toThrow(
      /content-type/,
    );

    const huge = dohServer(() => dnsMessage(Buffer.alloc(70_000)));
    await expect(queryUpstream({ transport: 'doh', address: huge.url }, outgoing)).rejects.toThrow(
      /maximum DNS message size/,
    );
  });

  test('accepts the media type case-insensitively and with parameters', async () => {
    const server = dohServer((body) =>
      dnsMessage(answerFor(body), 'Application/DNS-Message; charset=binary'),
    );
    const outgoing = upstreamQuery(sampleQuery(), { pad: true });
    const response = await queryUpstream({ transport: 'doh', address: server.url }, outgoing);
    expect(dnsPacket.decode(response).answers).toHaveLength(1);
  });
});

describe('isResponseTo', () => {
  const sent = upstreamQuery(sampleQuery('Example.COM', 0x1111), { pad: false });

  test('matches ID, QR and question, ignoring name case', () => {
    const reply = answerFor(upstreamQuery(sampleQuery('example.com', 0x1111), { pad: false }));
    expect(isResponseTo(reply, 0x1111, sent)).toBe(true);
  });

  test('rejects a wrong ID, a query, a different name or type', () => {
    const base = sampleQuery('example.com', 0x1111);
    expect(isResponseTo(answerFor(upstreamQuery(base, { pad: false })), 0x2222, sent)).toBe(false);
    const asQuery = Buffer.from(sent);
    expect(isResponseTo(asQuery, 0x1111, sent)).toBe(false);
    const other = answerFor(upstreamQuery(sampleQuery('example.net', 0x1111), { pad: false }));
    expect(isResponseTo(other, 0x1111, sent)).toBe(false);
    const aaaa = answerFor(sent, { questions: [{ type: 'AAAA', name: 'example.com' }] });
    expect(isResponseTo(aaaa, 0x1111, sent)).toBe(false);
  });
});
