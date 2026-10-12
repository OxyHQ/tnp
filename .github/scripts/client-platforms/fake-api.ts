/**
 * A stand-in for the TNP API, for the client end-to-end tests
 * (.github/workflows/client-platforms.yml).
 *
 *   bun fake-api.ts <port> <request-log>
 *
 * Serves the two endpoints the resolver reads: `/dns/tlds` (only `.ox`) and
 * `/dns/resolve`, where `e2e.ox` has one A record, 203.0.113.7 (TEST-NET-3,
 * RFC 5737: it can never be a real answer from public DNS, so seeing it proves
 * the lookup went through TNP). Every request is appended to the log, so a
 * test can show the installed resolver really asked this server. Everything
 * else is a 404, which the client must treat as an error, not as data.
 */

import { appendFileSync } from 'node:fs';

export const E2E_NAME = 'e2e.ox';
export const E2E_ADDRESS = '203.0.113.7';

const port = Number(process.argv[2]);
const log = process.argv[3];
if (!Number.isInteger(port) || port <= 0 || !log) {
  console.error('usage: bun fake-api.ts <port> <request-log>');
  process.exit(2);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(req) {
    const url = new URL(req.url);
    appendFileSync(log, `${new Date().toISOString()} ${req.method} ${url.pathname}${url.search}\n`);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname === '/dns/tlds') return json([{ name: 'ox', custom: false }]);
    if (url.pathname === '/dns/resolve') {
      const name = (url.searchParams.get('name') ?? '').toLowerCase().replace(/\.$/, '');
      const type = (url.searchParams.get('type') ?? 'A').toUpperCase();
      if (name !== E2E_NAME) return json({ name, type, answers: [], rcode: 'NXDOMAIN' });
      const answers = type === 'A' ? [{ name, type: 'A', value: E2E_ADDRESS, ttl: 30 }] : [];
      return json({ name, type, answers, rcode: 'NOERROR' });
    }
    return json({ error: 'not found' }, 404);
  },
});

console.log(`fake TNP API on http://127.0.0.1:${port}`);
