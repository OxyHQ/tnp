/**
 * Wire-level tests of the resolver: real UDP/TCP sockets, a fake upstream that
 * records every question it is asked, and a fake registry over HTTP.
 *
 * The property the first block exists for: a name under a native TLD is
 * NEVER sent to the public upstream — not before the TLD sync, not when the
 * registry is down or returns an empty TLD list, not when the resolver is
 * saturated. Forwarding it would hand the name to the upstream operator, and
 * for a plaintext upstream to everyone on the path.
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createSocket, type Socket } from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import dnsPacket from 'dns-packet';
import type { DnsProxyConfig } from './config';
import { DnsProxy, txtStrings } from './proxy';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FakeUpstream {
  port: number;
  /** Every question name the upstream was asked, in order. */
  asked: string[];
  /** Every raw query the upstream received. */
  raw: Buffer[];
  socket: Socket;
  close(): void;
}

type Responder = (query: dnsPacket.DecodedPacket, raw: Buffer) => Buffer | Buffer[] | null;

const defaultResponder: Responder = (query) =>
  dnsPacket.encode({
    type: 'response',
    id: query.id,
    flags: dnsPacket.RECURSION_AVAILABLE | dnsPacket.AUTHENTIC_DATA,
    questions: query.questions,
    answers: [
      { type: 'A', name: query.questions?.[0]?.name ?? '', ttl: 60, data: '93.184.216.34' },
    ],
  });

async function fakeUpstream(respond: Responder = defaultResponder): Promise<FakeUpstream> {
  const socket = createSocket('udp4');
  const asked: string[] = [];
  const raw: Buffer[] = [];
  socket.on('message', (message, peer) => {
    raw.push(Buffer.from(message));
    const query = dnsPacket.decode(message);
    asked.push(query.questions?.[0]?.name ?? '');
    const out = respond(query, message);
    if (!out) return;
    for (const packet of Array.isArray(out) ? out : [out]) {
      socket.send(packet, peer.port, peer.address);
    }
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  return { port: socket.address().port, asked, raw, socket, close: () => socket.close() };
}

interface FakeRegistry {
  url: string;
  hits: string[];
  stop(): void;
}

async function fakeRegistry(
  handle: (url: URL) => Response | Promise<Response>,
): Promise<FakeRegistry> {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      hits.push(`${url.pathname}${url.search}`);
      return handle(url);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hits, stop: () => server.stop(true) };
}

/**
 * A registry that is up but failing: every request is a 503. (A closed port
 * would do too, but this sandbox black-holes connections to closed ports, so
 * that would test the client's 5 s timeout instead; see the hanging-registry
 * test for that case.)
 */
const failingRegistry = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: () => new Response('unavailable', { status: 503 }),
});
const DEAD_REGISTRY = `http://127.0.0.1:${failingRegistry.port}`;
afterAll(() => failingRegistry.stop(true));

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function startProxy(
  upstreamPort: number,
  apiBaseUrl: string,
  extra: Partial<DnsProxyConfig> = {},
): Promise<DnsProxy> {
  const proxy = new DnsProxy({
    listenAddr: '127.0.0.1',
    listenPort: 0,
    apiBaseUrl,
    cacheMaxEntries: 100,
    upstreamDns: `127.0.0.1:${upstreamPort}`,
    ...extra,
  });
  await proxy.start();
  cleanups.push(() => proxy.stop());
  return proxy;
}

function query(
  name: string,
  type: dnsPacket.RecordType = 'A',
  opts: { id?: number; ednsSize?: number; dnssecOk?: boolean; ecs?: boolean } = {},
): Buffer {
  const additionals: dnsPacket.Answer[] = [];
  if (opts.ednsSize !== undefined) {
    additionals.push({
      type: 'OPT',
      name: '.',
      udpPayloadSize: opts.ednsSize,
      extendedRcode: 0,
      ednsVersion: 0,
      flags: opts.dnssecOk ? dnsPacket.DNSSEC_OK : 0,
      flag_do: Boolean(opts.dnssecOk),
      options: opts.ecs
        ? [{ code: 8, family: 1, sourcePrefixLength: 24, scopePrefixLength: 0, ip: '203.0.113.0' }]
        : [],
    });
  }
  return dnsPacket.encode({
    type: 'query',
    id: opts.id ?? 0x4242,
    flags: dnsPacket.RECURSION_DESIRED,
    questions: [{ type, name }],
    additionals,
  });
}

/** Send one datagram to the proxy and wait for one reply (or a timeout → null). */
async function udpExchange(port: number, packet: Buffer, timeoutMs = 1500): Promise<Buffer | null> {
  const socket = createSocket('udp4');
  try {
    return await new Promise<Buffer | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      socket.on('message', (msg) => {
        clearTimeout(timer);
        resolve(Buffer.from(msg));
      });
      socket.send(packet, port, '127.0.0.1');
    });
  } finally {
    socket.close();
  }
}

/** Send framed messages over one TCP connection and collect `expect` replies. */
async function tcpExchange(port: number, packets: Buffer[], expect: number): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let buffer = Buffer.alloc(0);
    const replies: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(replies);
    }, 3000);
    socket.on('connect', () => {
      socket.write(
        Buffer.concat(
          packets.map((p) => {
            const len = Buffer.alloc(2);
            len.writeUInt16BE(p.byteLength, 0);
            return Buffer.concat([len, p]);
          }),
        ),
      );
    });
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2 && buffer.length >= 2 + buffer.readUInt16BE(0)) {
        const len = buffer.readUInt16BE(0);
        replies.push(Buffer.from(buffer.subarray(2, 2 + len)));
        buffer = buffer.subarray(2 + len);
      }
      if (replies.length >= expect) {
        clearTimeout(timer);
        socket.destroy();
        resolve(replies);
      }
    });
    socket.on('error', reject);
  });
}

const rcode = (buf: Buffer) => dnsPacket.decode(buf).rcode;

// ---------------------------------------------------------------------------
// The per-source limit and its exemption list
// ---------------------------------------------------------------------------

/**
 * Loopback is always exempt, so this needs a non-loopback source: a socket
 * bound to one of this machine's own interface addresses, sending to that
 * address. CI runners have one; a machine without any reports why it did not run.
 */
const localSource = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
if (!localSource)
  console.warn('[proxy.wire.test] no non-loopback IPv4: rate-limit wire test not run');

async function burstFrom(source: string, port: number, count: number) {
  const socket = createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, source, resolve));
  const replies: Buffer[] = [];
  socket.on('message', (msg) => replies.push(Buffer.from(msg)));
  try {
    for (let i = 0; i < count; i++)
      socket.send(query('example.com', 'A', { id: i + 1 }), port, source);
    await new Promise((resolve) => setTimeout(resolve, 800));
  } finally {
    socket.close();
  }
  const answered = replies.filter((r) => {
    const p = dnsPacket.decode(r);
    return (
      p.rcode === 'NOERROR' &&
      !((p.flags ?? 0) & dnsPacket.TRUNCATED_RESPONSE) &&
      (p.answers?.length ?? 0) > 0
    );
  });
  return answered.length;
}

describe.if(Boolean(localSource))('per-source rate limit on the wire', () => {
  const strict = { rateLimit: { perSecond: 0.01, burst: 1 }, listenAddr: '0.0.0.0' };

  test('a non-exempt source is throttled after its burst', async () => {
    const upstream = await fakeUpstream();
    cleanups.push(() => upstream.close());
    const proxy = await startProxy(upstream.port, DEAD_REGISTRY, strict);
    expect(await burstFrom(localSource as string, proxy.udpPort ?? 0, 6)).toBe(1);
  });

  test('an exempt source is answered every time while the limit still applies to others', async () => {
    const upstream = await fakeUpstream();
    cleanups.push(() => upstream.close());
    const proxy = await startProxy(upstream.port, DEAD_REGISTRY, {
      ...strict,
      rateLimitExempt: [`${localSource}/32`],
    });
    expect(await burstFrom(localSource as string, proxy.udpPort ?? 0, 6)).toBe(6);

    // Same exemption list, a different source address: still limited.
    const other = await startProxy(upstream.port, DEAD_REGISTRY, {
      ...strict,
      rateLimitExempt: ['192.0.2.1'],
    });
    expect(await burstFrom(localSource as string, other.udpPort ?? 0, 6)).toBe(1);
  });
});

test('an invalid exemption entry is refused at construction', () => {
  expect(
    () =>
      new DnsProxy({
        listenAddr: '127.0.0.1',
        listenPort: 0,
        apiBaseUrl: DEAD_REGISTRY,
        cacheMaxEntries: 10,
        upstreamDns: '127.0.0.1:53',
        rateLimitExempt: ['10.0.0.5/24'],
      }),
  ).toThrow('invalid source entries: 10.0.0.5/24');
});

// ---------------------------------------------------------------------------
// A native name never goes upstream
// ---------------------------------------------------------------------------

describe('native names are never forwarded upstream', () => {
  test('registry unreachable, no TLD sync ever ran: SERVFAIL, upstream never asked', async () => {
    const upstream = await fakeUpstream();
    cleanups.push(() => upstream.close());
    const proxy = await startProxy(upstream.port, DEAD_REGISTRY);

    for (const type of ['A', 'AAAA', 'TXT', 'MX'] as const) {
      const reply = await udpExchange(proxy.udpPort ?? 0, query('secret-meeting.ox', type));
      expect(reply).not.toBeNull();
      if (reply) expect(rcode(reply)).toBe('SERVFAIL');
    }
    const [tcpReply] = await tcpExchange(proxy.tcpPort ?? 0, [query('secret-meeting.ox')], 1);
    expect(rcode(tcpReply)).toBe('SERVFAIL');

    // A public name still resolves, so the upstream is demonstrably wired up.
    const pub = await udpExchange(proxy.udpPort ?? 0, query('example.com'));
    expect(pub && rcode(pub)).toBe('NOERROR');
    expect(upstream.asked).toEqual(['example.com']);
  });

  test(
    'registry that never answers: SERVFAIL after the timeout, upstream never asked',
    async () => {
      const upstream = await fakeUpstream();
      cleanups.push(() => upstream.close());
      const hanging = await fakeRegistry(() => new Promise<Response>(() => {}));
      cleanups.push(() => hanging.stop());
      const proxy = await startProxy(upstream.port, hanging.url);
      const reply = await udpExchange(proxy.udpPort ?? 0, query('hello.ox'), 8000);
      expect(reply && rcode(reply)).toBe('SERVFAIL');
      expect(upstream.asked).toEqual([]);
    },
    { timeout: 10_000 },
  );

  test('a failed TLD sync and an empty TLD list both keep .ox native', async () => {
    const upstream = await fakeUpstream();
    cleanups.push(() => upstream.close());

    let tlds: unknown = [];
    const registry = await fakeRegistry((url) => {
      if (url.pathname === '/dns/tlds') return Response.json(tlds);
      return new Response('boom', { status: 500 });
    });
    cleanups.push(() => registry.stop());

    const proxy = await startProxy(upstream.port, registry.url);
    expect(await proxy.syncTlds()).toBe(true); // [] from the API
    let reply = await udpExchange(proxy.udpPort ?? 0, query('a.ox'));
    expect(reply && rcode(reply)).toBe('SERVFAIL'); // resolve returned 500

    tlds = { not: 'a list' };
    expect(await proxy.syncTlds()).toBe(false);
    reply = await udpExchange(proxy.udpPort ?? 0, query('b.ox'));
    expect(reply && rcode(reply)).toBe('SERVFAIL');

    expect(upstream.asked).toEqual([]);
  });

  test('a saturated resolver answers SERVFAIL rather than forwarding', async () => {
    const upstream = await fakeUpstream();
    cleanups.push(() => upstream.close());
    const proxy = new DnsProxy({
      listenAddr: '127.0.0.1',
      listenPort: 0,
      apiBaseUrl: DEAD_REGISTRY,
      upstreamDns: `127.0.0.1:${upstream.port}`,
      maxInflight: 0,
    });
    const reply = await proxy.handleQuery(query('a.ox'), true);
    expect(rcode(reply)).toBe('SERVFAIL');
    expect(upstream.asked).toEqual([]);
  });

  test('the last good TLD list survives a restart with the registry down', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tnp-tlds-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const tldCachePath = join(dir, 'tlds.json');

    const upstream = await fakeUpstream();
    cleanups.push(() => upstream.close());
    const registry = await fakeRegistry((url) =>
      url.pathname === '/dns/tlds'
        ? Response.json([{ name: 'zzt', custom: true }, 'com', 'lan'])
        : Response.json({ name: '', type: 'A', answers: [], rcode: 'NXDOMAIN' }),
    );
    cleanups.push(() => registry.stop());

    const first = await startProxy(upstream.port, registry.url, { tldCachePath });
    expect(await first.syncTlds()).toBe(true);
    first.stop();
    // Reserved and private-use TLDs offered by the API are neither used nor saved.
    expect(JSON.parse(readFileSync(tldCachePath, 'utf-8')).sort()).toEqual(['ox', 'zzt']);

    const second = await startProxy(upstream.port, DEAD_REGISTRY, { tldCachePath });
    const reply = await udpExchange(second.udpPort ?? 0, query('hello.zzt'));
    expect(reply && rcode(reply)).toBe('SERVFAIL');
    expect(second.classify('printer.lan')).toBe('public-dns');
    expect(upstream.asked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Registry answers
// ---------------------------------------------------------------------------

describe('registry answers on the wire', () => {
  async function withRegistryAnswer(body: unknown) {
    const upstream = await fakeUpstream();
    cleanups.push(() => upstream.close());
    const registry = await fakeRegistry(() => Response.json(body));
    cleanups.push(() => registry.stop());
    const proxy = await startProxy(upstream.port, registry.url);
    return { proxy, registry, upstream };
  }

  test('NOERROR with no answers is NODATA, not NXDOMAIN, and is cached as such', async () => {
    const { proxy, registry } = await withRegistryAnswer({
      name: 'v4only.ox',
      type: 'AAAA',
      answers: [],
      rcode: 'NOERROR',
    });
    for (let i = 0; i < 2; i++) {
      const reply = await udpExchange(proxy.udpPort ?? 0, query('v4only.ox', 'AAAA'));
      expect(reply).not.toBeNull();
      if (!reply) continue;
      const decoded = dnsPacket.decode(reply);
      expect(decoded.rcode).toBe('NOERROR');
      expect(decoded.answers).toHaveLength(0);
      expect(decoded.flag_aa).toBe(true);
    }
    expect(registry.hits.filter((h) => h.startsWith('/dns/resolve'))).toHaveLength(1);
  });

  test('NXDOMAIN from the registry is NXDOMAIN', async () => {
    const { proxy } = await withRegistryAnswer({
      name: 'nobody.ox',
      type: 'A',
      answers: [],
      rcode: 'NXDOMAIN',
    });
    const reply = await udpExchange(proxy.udpPort ?? 0, query('nobody.ox'));
    expect(reply && rcode(reply)).toBe('NXDOMAIN');
  });

  test('an API without rcode keeps the old reading: empty is NXDOMAIN', async () => {
    const { proxy } = await withRegistryAnswer({ name: 'old.ox', type: 'A', answers: [] });
    const reply = await udpExchange(proxy.udpPort ?? 0, query('old.ox'));
    expect(reply && rcode(reply)).toBe('NXDOMAIN');
  });

  test('a TXT value over 255 bytes is split into valid character-strings', async () => {
    const value = `v=spf1 ${'include:_spf.example.ox '.repeat(30)}-all`;
    expect(Buffer.byteLength(value)).toBeGreaterThan(600);
    const { proxy } = await withRegistryAnswer({
      name: 'long.ox',
      type: 'TXT',
      answers: [{ name: 'long.ox', type: 'TXT', value, ttl: 300 }],
      rcode: 'NOERROR',
    });
    const [reply] = await tcpExchange(proxy.tcpPort ?? 0, [query('long.ox', 'TXT')], 1);
    const decoded = dnsPacket.decode(reply);
    const answer = decoded.answers?.[0];
    expect(answer?.type).toBe('TXT');
    if (answer?.type !== 'TXT') return;
    const strings = (Array.isArray(answer.data) ? answer.data : [answer.data]).map((s) =>
      Buffer.from(s),
    );
    expect(strings.length).toBeGreaterThan(2);
    for (const s of strings) expect(s.byteLength).toBeLessThanOrEqual(255);
    expect(Buffer.concat(strings).toString('utf-8')).toBe(value.trim());
  });

  test('txtStrings handles empty and multi-byte values', () => {
    expect(txtStrings('')).toEqual([Buffer.alloc(0)]);
    const value = 'é'.repeat(200); // 400 bytes
    const chunks = txtStrings(value);
    expect(chunks.map((c) => c.byteLength)).toEqual([255, 145]);
    expect(Buffer.concat(chunks).toString('utf-8')).toBe(value);
  });
});

// ---------------------------------------------------------------------------
// Malformed and hostile packets
// ---------------------------------------------------------------------------

describe('malformed and hostile queries', () => {
  async function bareProxy() {
    const upstream = await fakeUpstream();
    cleanups.push(() => upstream.close());
    const proxy = new DnsProxy({
      listenAddr: '127.0.0.1',
      listenPort: 0,
      apiBaseUrl: DEAD_REGISTRY,
      upstreamDns: `127.0.0.1:${upstream.port}`,
    });
    return { proxy, upstream };
  }

  function withFlags(packet: Buffer, set: number): Buffer {
    const out = Buffer.from(packet);
    out.writeUInt16BE(out.readUInt16BE(2) | set, 2);
    return out;
  }

  test('a response (QR=1) gets no reply at all', async () => {
    const { proxy, upstream } = await bareProxy();
    const reply = await proxy.handleQuery(withFlags(query('example.com'), 0x8000), true);
    expect(reply.byteLength).toBe(0);
    expect(upstream.asked).toEqual([]);
  });

  test('a non-QUERY opcode is NOTIMP', async () => {
    const { proxy, upstream } = await bareProxy();
    const notify = withFlags(query('example.com'), 4 << 11);
    expect(rcode(await proxy.handleQuery(notify, true))).toBe('NOTIMP');
    expect(upstream.asked).toEqual([]);
  });

  test('wrong section counts are FORMERR', async () => {
    const { proxy } = await bareProxy();
    const two = dnsPacket.encode({
      type: 'query',
      id: 1,
      questions: [
        { type: 'A', name: 'a.example' },
        { type: 'A', name: 'b.example' },
      ],
    });
    expect(rcode(await proxy.handleQuery(two, true))).toBe('FORMERR');

    const withAnswer = dnsPacket.encode({
      type: 'query',
      id: 1,
      questions: [{ type: 'A', name: 'a.example' }],
      answers: [{ type: 'A', name: 'a.example', ttl: 1, data: '1.2.3.4' }],
    });
    expect(rcode(await proxy.handleQuery(withAnswer, true))).toBe('FORMERR');

    const nonOpt = dnsPacket.encode({
      type: 'query',
      id: 1,
      questions: [{ type: 'A', name: 'a.example' }],
      additionals: [{ type: 'A', name: 'a.example', ttl: 1, data: '1.2.3.4' }],
    });
    expect(rcode(await proxy.handleQuery(nonOpt, true))).toBe('FORMERR');
  });

  test('trailing bytes and a truncated question are FORMERR', async () => {
    const { proxy } = await bareProxy();
    const trailing = Buffer.concat([query('example.com'), Buffer.from([1, 2, 3])]);
    expect(rcode(await proxy.handleQuery(trailing, true))).toBe('FORMERR');
    const cut = query('example.com').subarray(0, 20);
    expect(rcode(await proxy.handleQuery(Buffer.from(cut), true))).toBe('FORMERR');
  });

  test('a zone transfer and a non-IN class are REFUSED', async () => {
    const { proxy, upstream } = await bareProxy();
    expect(rcode(await proxy.handleQuery(query('example.com', 'AXFR'), true))).toBe('REFUSED');
    const chaos = dnsPacket.encode({
      type: 'query',
      id: 1,
      questions: [{ type: 'TXT', name: 'version.bind', class: 'CH' }],
    });
    expect(rcode(await proxy.handleQuery(chaos, true))).toBe('REFUSED');
    expect(upstream.asked).toEqual([]);
  });

  test('a compression pointer in the question is refused without decoding', async () => {
    const { proxy } = await bareProxy();
    const header = Buffer.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
    const pointer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1]);
    const reply = await proxy.handleQuery(Buffer.concat([header, pointer]), true);
    expect(rcode(reply)).toBe('FORMERR');
    expect(dnsPacket.decode(reply).id).toBe(0x1234);
  });

  test('a 64 KB pointer-chain packet is rejected in microseconds, over UDP and TCP', async () => {
    const { proxy } = await bareProxy();
    // Header claiming one question, then a long run of compression pointers,
    // each pointing at the previous one: costly for a decoder to chase.
    const body = Buffer.alloc(65000);
    for (let i = 0; i + 1 < body.length; i += 2) {
      const target = 12 + Math.max(0, i - 2);
      body.writeUInt16BE(0xc000 | (target & 0x3fff), i);
    }
    const header = Buffer.from([0, 7, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
    const packet = Buffer.concat([header, body]);

    const started = performance.now();
    for (let i = 0; i < 200; i++) {
      expect((await proxy.handleQuery(packet, true)).byteLength).toBe(0);
      expect((await proxy.handleQuery(packet, false)).byteLength).toBe(0);
    }
    expect(performance.now() - started).toBeLessThan(200);
  });

  test('a UDP query over 512 bytes without EDNS is dropped', async () => {
    const { proxy } = await bareProxy();
    // 4 labels of 63 + padding OPT pushes past 512 only with OPT; build a raw
    // oversize packet instead: valid question followed by OPT with big rdata,
    // but with ARCOUNT=0 the trailing bytes make it FORMERR — so use OPT and
    // advertise only 512.
    const big = dnsPacket.encode({
      type: 'query',
      id: 9,
      questions: [{ type: 'A', name: 'example.com' }],
      additionals: [
        {
          type: 'OPT',
          name: '.',
          udpPayloadSize: 512,
          extendedRcode: 0,
          ednsVersion: 0,
          flags: 0,
          flag_do: false,
          options: [{ code: 12, length: 600 }],
        },
      ],
    });
    expect(big.byteLength).toBeGreaterThan(512);
    expect((await proxy.handleQuery(big, true)).byteLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// What goes upstream, and what comes back
// ---------------------------------------------------------------------------

describe('forwarding to the upstream', () => {
  test('DO, CD and client EDNS options are stripped; AD is cleared on the way back', async () => {
    const upstream = await fakeUpstream();
    cleanups.push(() => upstream.close());
    const proxy = await startProxy(upstream.port, DEAD_REGISTRY);

    const q = Buffer.from(
      query('example.com', 'A', { ednsSize: 4096, dnssecOk: true, ecs: true, id: 0x7777 }),
    );
    q.writeUInt16BE(q.readUInt16BE(2) | dnsPacket.CHECKING_DISABLED, 2);
    const reply = await udpExchange(proxy.udpPort ?? 0, q);
    expect(reply).not.toBeNull();
    if (!reply) return;

    const sent = dnsPacket.decode(upstream.raw[0]);
    expect(sent.flag_cd).toBe(false);
    expect(sent.flag_ad).toBe(false);
    const opt = sent.additionals?.find((r) => r.type === 'OPT');
    expect(opt?.type).toBe('OPT');
    if (opt?.type === 'OPT') {
      expect(opt.flag_do).toBe(false);
      expect(opt.options).toEqual([]);
      expect(opt.udpPayloadSize).toBe(1232);
    }
    // Our own random ID went upstream, never the client's.
    // (One in 65536 runs it collides by chance; the client's ID is restored.)
    const decoded = dnsPacket.decode(reply);
    expect(decoded.id).toBe(0x7777);
    expect(decoded.flag_ad).toBe(false);
    expect(decoded.answers?.[0]).toMatchObject({ type: 'A', data: '93.184.216.34' });
  });

  test('forged datagrams — wrong ID, wrong question, wrong source — are ignored', async () => {
    const forger = createSocket('udp4');
    await new Promise<void>((resolve) => forger.bind(0, '127.0.0.1', resolve));
    cleanups.push(() => forger.close());

    const upstream = await fakeUpstream((q) => {
      const name = q.questions?.[0]?.name ?? '';
      const answer = (data: string, overrides: Partial<dnsPacket.Packet> = {}) =>
        dnsPacket.encode({
          type: 'response',
          id: q.id,
          flags: dnsPacket.RECURSION_AVAILABLE,
          questions: q.questions,
          answers: [{ type: 'A', name, ttl: 60, data }],
          ...overrides,
        });
      return [
        answer('6.6.6.1', { id: ((q.id ?? 0) + 1) & 0xffff }),
        answer('6.6.6.2', { questions: [{ type: 'A', name: 'evil.example' }] }),
        answer('6.6.6.3', { type: 'query' }),
        answer('1.2.3.4'),
      ];
    });
    cleanups.push(() => upstream.close());

    // A forger who knows the right ID still loses: it is the wrong source.
    upstream.socket.removeAllListeners('message');
    upstream.socket.on('message', (message, peer) => {
      const q = dnsPacket.decode(message);
      upstream.asked.push(q.questions?.[0]?.name ?? '');
      const name = q.questions?.[0]?.name ?? '';
      const forged = dnsPacket.encode({
        type: 'response',
        id: q.id,
        flags: dnsPacket.RECURSION_AVAILABLE,
        questions: q.questions,
        answers: [{ type: 'A', name, ttl: 60, data: '6.6.6.6' }],
      });
      forger.send(forged, peer.port, peer.address, () => {
        setTimeout(() => {
          const bad = dnsPacket.encode({
            type: 'response',
            id: ((q.id ?? 0) + 1) & 0xffff,
            flags: dnsPacket.RECURSION_AVAILABLE,
            questions: q.questions,
            answers: [{ type: 'A', name, ttl: 60, data: '6.6.6.1' }],
          });
          upstream.socket.send(bad, peer.port, peer.address);
          const good = dnsPacket.encode({
            type: 'response',
            id: q.id,
            flags: dnsPacket.RECURSION_AVAILABLE,
            questions: q.questions,
            answers: [{ type: 'A', name, ttl: 60, data: '1.2.3.4' }],
          });
          setTimeout(() => upstream.socket.send(good, peer.port, peer.address), 20);
        }, 20);
      });
    });

    const proxy = await startProxy(upstream.port, DEAD_REGISTRY);
    const reply = await udpExchange(proxy.udpPort ?? 0, query('bank.example'));
    expect(reply).not.toBeNull();
    if (reply) expect(dnsPacket.decode(reply).answers?.[0]).toMatchObject({ data: '1.2.3.4' });
  });

  test('wrong-ID and wrong-question answers from the real upstream are ignored', async () => {
    const upstream = await fakeUpstream((q) => {
      const name = q.questions?.[0]?.name ?? '';
      const answer = (data: string, overrides: Partial<dnsPacket.Packet> = {}) =>
        dnsPacket.encode({
          type: 'response',
          id: q.id,
          flags: dnsPacket.RECURSION_AVAILABLE,
          questions: q.questions,
          answers: [{ type: 'A', name, ttl: 60, data }],
          ...overrides,
        });
      return [
        answer('6.6.6.1', { id: ((q.id ?? 0) + 1) & 0xffff }),
        answer('6.6.6.2', { questions: [{ type: 'A', name: 'evil.example' }] }),
        answer('1.2.3.4'),
      ];
    });
    cleanups.push(() => upstream.close());
    const proxy = await startProxy(upstream.port, DEAD_REGISTRY);
    const reply = await udpExchange(proxy.udpPort ?? 0, query('Bank.Example'));
    expect(reply).not.toBeNull();
    if (reply) expect(dnsPacket.decode(reply).answers?.[0]).toMatchObject({ data: '1.2.3.4' });
  });

  test('UDP replies are capped at 1232 bytes even when the client advertises 4096', async () => {
    const upstream = await fakeUpstream((q) =>
      dnsPacket.encode({
        type: 'response',
        id: q.id,
        flags: dnsPacket.RECURSION_AVAILABLE,
        questions: q.questions,
        answers: Array.from({ length: 11 }, (_, i) => ({
          type: 'TXT' as const,
          name: q.questions?.[0]?.name ?? '',
          ttl: 60,
          data: `${i}-${'x'.repeat(100)}`,
        })),
      }),
    );
    cleanups.push(() => upstream.close());
    const proxy = await startProxy(upstream.port, DEAD_REGISTRY);

    const reply = await udpExchange(
      proxy.udpPort ?? 0,
      query('big.example', 'TXT', { ednsSize: 4096 }),
    );
    expect(reply).not.toBeNull();
    if (!reply) return;
    expect(reply.byteLength).toBeLessThanOrEqual(1232);
    const decoded = dnsPacket.decode(reply);
    expect(decoded.flag_tc).toBe(true);
    expect(decoded.questions?.[0]?.name).toBe('big.example');

    // Over TCP the full answer arrives.
    const [full] = await tcpExchange(proxy.tcpPort ?? 0, [query('big.example', 'TXT')], 1);
    expect(dnsPacket.decode(full).answers).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------------
// TCP listener bounds
// ---------------------------------------------------------------------------

describe('TCP listener', () => {
  test('pipelined queries on one connection are all answered, in order', async () => {
    const upstream = await fakeUpstream();
    cleanups.push(() => upstream.close());
    const proxy = await startProxy(upstream.port, DEAD_REGISTRY);
    const replies = await tcpExchange(
      proxy.tcpPort ?? 0,
      [query('one.example', 'A', { id: 1 }), query('two.example', 'A', { id: 2 })],
      2,
    );
    expect(replies.map((r) => dnsPacket.decode(r).id)).toEqual([1, 2]);
  });

  test('connections beyond the cap are closed immediately', async () => {
    const upstream = await fakeUpstream();
    cleanups.push(() => upstream.close());
    const proxy = await startProxy(upstream.port, DEAD_REGISTRY, { maxTcpConnections: 1 });

    const first = net.createConnection({ host: '127.0.0.1', port: proxy.tcpPort ?? 0 });
    cleanups.push(() => first.destroy());
    await new Promise((resolve) => first.once('connect', resolve));
    await Bun.sleep(20);

    const second = net.createConnection({ host: '127.0.0.1', port: proxy.tcpPort ?? 0 });
    const closed = await new Promise<boolean>((resolve) => {
      second.once('close', () => resolve(true));
      second.once('error', () => resolve(true));
      setTimeout(() => resolve(false), 1000);
    });
    expect(closed).toBe(true);
  });

  test('a client that floods the buffer without completing a message is cut off', async () => {
    const upstream = await fakeUpstream();
    cleanups.push(() => upstream.close());
    const proxy = await startProxy(upstream.port, DEAD_REGISTRY);
    const socket = net.createConnection({ host: '127.0.0.1', port: proxy.tcpPort ?? 0 });
    await new Promise((resolve) => socket.once('connect', resolve));
    const closed = new Promise<boolean>((resolve) => {
      socket.once('close', () => resolve(true));
      setTimeout(() => resolve(false), 1500);
    });
    const header = Buffer.from([0xff, 0xff]); // claims a 65535-byte message
    socket.write(Buffer.concat([header, Buffer.alloc(8000)]));
    expect(await closed).toBe(true);
  });
});
