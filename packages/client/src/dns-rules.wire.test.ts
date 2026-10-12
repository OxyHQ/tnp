/**
 * Personal rules end to end on one device: an envelope made the way the web
 * dashboard makes it, pulled and decrypted by the store, written to the
 * active rules file, and answered by the real resolver — with a fake upstream
 * and a fake registry that record what they are asked.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { createSocket, type Socket } from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dnsPacket from 'dns-packet';
import {
  createRulesEnvelope,
  resealRulesEnvelope,
  type RulesKdfParams,
} from '@tnp/crypto/dns-rules';
import { type DnsRule, type DnsRulesRecord, serializeDnsRuleSet } from '@tnp/shared-types';
import { approveRedirects, acceptPulledRules, type RulesPaths } from './dns-rules-store';
import { DnsProxy } from './proxy';

const FAST: RulesKdfParams = { alg: 'argon2id', m: 19_456, t: 2, p: 1 };
const USER = 'oxy-user-wire';
const PASSPHRASE = 'a long sync passphrase';
const isNative = (name: string) => name.endsWith('.ox');

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

async function fakeUpstream(): Promise<{ port: number; asked: string[]; socket: Socket }> {
  const socket = createSocket('udp4');
  const asked: string[] = [];
  socket.on('message', (message, peer) => {
    const q = dnsPacket.decode(message);
    const question = q.questions?.[0];
    asked.push(`${question?.name} ${question?.type}`);
    const answers: dnsPacket.Answer[] =
      question?.type === 'A'
        ? [{ type: 'A', name: question.name, ttl: 60, data: '93.184.216.34' }]
        : question?.type === 'AAAA'
          ? [{ type: 'AAAA', name: question.name, ttl: 60, data: '2606:2800::1' }]
          : [];
    socket.send(
      dnsPacket.encode({
        type: 'response',
        id: q.id,
        flags: dnsPacket.RECURSION_AVAILABLE,
        questions: q.questions,
        answers,
      }),
      peer.port,
      peer.address,
    );
  });
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  cleanups.push(() => socket.close());
  return { port: socket.address().port, asked, socket };
}

function fakeRegistry(): { url: string; hits: string[] } {
  const hits: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const url = new URL(req.url);
      hits.push(url.searchParams.get('name') ?? url.pathname);
      return Response.json({
        name: url.searchParams.get('name'),
        type: url.searchParams.get('type'),
        answers: [{ name: url.searchParams.get('name'), type: 'A', value: '10.9.9.9', ttl: 60 }],
        rcode: 'NOERROR',
      });
    },
  });
  cleanups.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, hits };
}

function tempPaths(): RulesPaths {
  const dir = mkdtempSync(join(tmpdir(), 'tnp-rules-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return { secretDir: join(dir, 'secret'), activeFile: join(dir, 'dns-rules.conf') };
}

function record(envelope: ReturnType<typeof createRulesEnvelope>['envelope']): DnsRulesRecord {
  return { ...envelope, userId: USER, updatedAt: new Date().toISOString() };
}

const RULES: DnsRule[] = [
  { type: 'block', name: 'ads.example.com', subdomains: true },
  { type: 'block', name: 'tracker.ox', subdomains: false },
  { type: 'redirect', name: 'google.com', target: { kind: 'ipv4', value: '192.168.1.10' } },
  { type: 'redirect', name: 'v6.example.org', target: { kind: 'ipv6', value: '2001:db8::10' } },
  {
    type: 'redirect',
    name: 'media.example.org',
    target: { kind: 'name', value: 'cdn.example.net' },
  },
];

async function pulled(rules: DnsRule[] = RULES) {
  const paths = tempPaths();
  const { envelope } = createRulesEnvelope({
    passphrase: PASSPHRASE,
    userId: USER,
    body: new TextEncoder().encode(serializeDnsRuleSet(rules)),
    kdfParams: FAST,
  });
  const result = await acceptPulledRules({
    paths,
    record: record(envelope),
    isNative,
    askPassphrase: async () => PASSPHRASE,
  });
  return { paths, result };
}

async function resolverFor(paths: RulesPaths) {
  const upstream = await fakeUpstream();
  const registry = fakeRegistry();
  const proxy = new DnsProxy({
    listenAddr: '127.0.0.1',
    listenPort: 0,
    apiBaseUrl: registry.url,
    upstreamDns: `127.0.0.1:${upstream.port}`,
    personalRulesPath: paths.activeFile,
  });
  const ask = async (name: string, type: dnsPacket.RecordType = 'A') =>
    dnsPacket.decode(
      await proxy.handleQuery(
        dnsPacket.encode({
          type: 'query',
          id: 7,
          flags: dnsPacket.RECURSION_DESIRED,
          questions: [{ name, type }],
        }),
        false,
      ),
    );
  return { ask, upstream, registry };
}

describe('after a pull', () => {
  test('blocks apply at once, redirects wait for approval', async () => {
    const { paths, result } = await pulled();
    expect(result.view.pending.map((r) => r.name).sort()).toEqual([
      'google.com',
      'media.example.org',
      'v6.example.org',
    ]);
    const { ask, upstream } = await resolverFor(paths);

    const blocked = await ask('x.ads.example.com');
    expect(blocked.rcode).toBe('NXDOMAIN');
    expect(blocked.answers).toEqual([]);

    // Unapproved: google.com resolves exactly as without TNP.
    const google = await ask('google.com');
    expect(google.rcode).toBe('NOERROR');
    expect(google.answers?.[0]).toMatchObject({ type: 'A', data: '93.184.216.34' });
    expect(upstream.asked).toEqual(['google.com A']);
  });

  test('a block on a native name answers NXDOMAIN without asking the registry', async () => {
    const { paths } = await pulled();
    const { ask, registry } = await resolverFor(paths);
    expect((await ask('tracker.ox')).rcode).toBe('NXDOMAIN');
    expect(registry.hits).toEqual([]);
    expect((await ask('other.ox')).rcode).toBe('NOERROR');
    expect(registry.hits).toEqual(['other.ox']);
  });

  test('the active file is private and lists only what applies', async () => {
    const { paths } = await pulled();
    expect(statSync(paths.activeFile).mode & 0o077).toBe(0);
    const text = readFileSync(paths.activeFile, 'utf-8');
    expect(text).toContain('block-subdomains ads.example.com');
    expect(text).toContain('pending 3');
    expect(text).not.toContain('google.com');
    expect(statSync(join(paths.secretDir, 'key.json')).mode & 0o077).toBe(0);
  });
});

describe('approved redirects', () => {
  test('an IPv4 redirect answers A and is NODATA for AAAA and HTTPS', async () => {
    const { paths } = await pulled();
    approveRedirects(paths, ['google.com'], isNative);
    const { ask, upstream } = await resolverFor(paths);

    const a = await ask('google.com');
    expect(a.rcode).toBe('NOERROR');
    expect(a.answers).toEqual([
      { type: 'A', name: 'google.com', ttl: 30, class: 'IN', flush: false, data: '192.168.1.10' },
    ]);
    const aaaa = await ask('google.com', 'AAAA');
    expect(aaaa.rcode).toBe('NOERROR');
    expect(aaaa.answers).toEqual([]);
    expect((await ask('google.com', 'HTTPS' as dnsPacket.RecordType)).answers).toEqual([]);
    // Exact name only: www is untouched.
    expect((await ask('www.google.com')).answers?.[0]).toMatchObject({ data: '93.184.216.34' });
    expect(upstream.asked).toEqual(['www.google.com A']);
  });

  test('an IPv6 redirect answers AAAA', async () => {
    const { paths } = await pulled();
    approveRedirects(paths, ['v6.example.org'], isNative);
    const { ask } = await resolverFor(paths);
    expect((await ask('v6.example.org', 'AAAA')).answers?.[0]).toMatchObject({
      type: 'AAAA',
      data: '2001:db8::10',
    });
    expect((await ask('v6.example.org', 'A')).answers).toEqual([]);
  });

  test('a name redirect answers a CNAME plus the target resolved the normal way', async () => {
    const { paths } = await pulled();
    approveRedirects(paths, ['media.example.org'], isNative);
    const { ask, upstream } = await resolverFor(paths);
    const reply = await ask('media.example.org');
    expect(reply.rcode).toBe('NOERROR');
    expect(reply.answers?.map((a) => [a.type, a.name, 'data' in a ? a.data : null])).toEqual([
      ['CNAME', 'media.example.org', 'cdn.example.net'],
      ['A', 'cdn.example.net', '93.184.216.34'],
    ]);
    expect(upstream.asked).toEqual(['cdn.example.net A']);
  });

  test('a changed target needs approving again', async () => {
    const paths = tempPaths();
    const first = createRulesEnvelope({
      passphrase: PASSPHRASE,
      userId: USER,
      body: new TextEncoder().encode(serializeDnsRuleSet(RULES)),
      kdfParams: FAST,
    });
    await acceptPulledRules({
      paths,
      record: record(first.envelope),
      isNative,
      askPassphrase: async () => PASSPHRASE,
    });
    approveRedirects(paths, ['google.com'], isNative);

    const moved = RULES.map((r) =>
      r.name === 'google.com'
        ? { ...r, target: { kind: 'ipv4' as const, value: '192.168.1.99' } }
        : r,
    );
    const next = resealRulesEnvelope({
      rulesKey: first.rulesKey,
      userId: USER,
      previous: first.envelope,
      body: new TextEncoder().encode(serializeDnsRuleSet(moved)),
    });
    // No passphrase needed with the stored key.
    const result = await acceptPulledRules({
      paths,
      record: record(next),
      isNative,
      askPassphrase: null,
    });
    expect(result.droppedApprovals).toEqual(['google.com']);
    expect(result.view.pending.map((r) => r.name)).toContain('google.com');

    const { ask } = await resolverFor(paths);
    expect((await ask('google.com')).answers?.[0]).toMatchObject({ data: '93.184.216.34' });
  });
});

describe('native names', () => {
  test('a redirect of a native name is refused at pull and never applied', async () => {
    const { paths, result } = await pulled([
      { type: 'block', name: 'a.example', subdomains: false },
      // Built by hand: the web form refuses this, a hostile writer might not.
      { type: 'redirect', name: 'nate.ox', target: { kind: 'ipv4', value: '10.0.0.1' } } as DnsRule,
    ]);
    expect(result.view.rejected.map((r) => r.code)).toEqual(['redirect_native']);
    expect(result.view.pending).toEqual([]);
    expect(() => approveRedirects(paths, ['nate.ox'], isNative)).toThrow('not a pending redirect');
    const { ask, registry } = await resolverFor(paths);
    expect((await ask('nate.ox')).answers?.[0]).toMatchObject({ data: '10.9.9.9' });
    expect(registry.hits).toEqual(['nate.ox']);
  });
});
