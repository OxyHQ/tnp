import { describe, expect, test } from 'bun:test';
import { createSocket } from 'node:dgram';
import dnsPacket from 'dns-packet';
import { DnsProxy } from './proxy';

async function withUpstream(run: (port: number) => Promise<void>) {
  const upstream = createSocket('udp4');
  upstream.on('message', (message, peer) => {
    const query = dnsPacket.decode(message);
    const response = dnsPacket.encode({ ...query, type: 'response', flags: dnsPacket.RECURSION_AVAILABLE });
    upstream.send(response, peer.port, peer.address);
  });
  await new Promise<void>(resolve => upstream.bind(0, '127.0.0.1', resolve));
  try { await run(upstream.address().port); }
  finally { upstream.close(); }
}

function makeProxy(port: number, observer: (direction: 'inbound' | 'outbound') => void) {
  return new DnsProxy({
    listenAddr: '127.0.0.1', listenPort: 0, apiBaseUrl: 'https://api.example.test',
    cacheMaxEntries: 10, upstreamDns: `127.0.0.1:${port}`,
  }, observer);
}

const query = () => dnsPacket.encode({ id: 12, type: 'query', questions: [{ name: 'private-query.example', type: 'A' }] });

describe('DNS traffic observation', () => {
  test('reports actual upstream send and receive with only direction, never the queried name or address', async () => {
    await withUpstream(async port => {
      const events: unknown[][] = [];
      const proxy = makeProxy(port, (...args) => events.push(args));
      expect(proxy.listening).toBe(false);
      const answer = await proxy.handleQuery(query(), true);
      expect(dnsPacket.decode(answer).id).toBe(12);
      expect(events).toEqual([['outbound'], ['inbound']]);
    });
  });

  test('a failing observer cannot change the DNS response', async () => {
    await withUpstream(async port => {
      const proxy = makeProxy(port, () => { throw new Error('publisher unavailable'); });
      const answer = await proxy.handleQuery(query(), true);
      expect(dnsPacket.decode(answer).type).toBe('response');
      expect(dnsPacket.decode(answer).id).toBe(12);
    });
  });
});
