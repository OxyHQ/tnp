import { describe, expect, test } from 'bun:test';
import { apiDomainKeyLookup } from './domain-keys';

const KEY = 'n4CCDVyVmPikeULWtYh6ohrhAPvd4n9CvhdDgwVSRjw=';

function fakeFetch() {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    await new Promise((r) => setTimeout(r, 10));
    if (url.endsWith('/example.ox')) {
      return Response.json({ name: 'example.ox', domainKey: KEY, rotations: [] });
    }
    if (url.endsWith('/broken.ox')) return new Response('x', { status: 500 });
    return new Response('no', { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('apiDomainKeyLookup', () => {
  test('coalesces identical lookups in flight and caches both answers', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const lookup = apiDomainKeyLookup('https://api.example.test', { fetch: fetchImpl });
    const results = await Promise.all([
      lookup('example.ox'),
      lookup('example.ox'),
      lookup('example.ox'),
    ]);
    expect(results).toEqual([KEY, KEY, KEY]);
    expect(await lookup('missing.ox')).toBeNull();
    expect(await lookup('missing.ox')).toBeNull();
    expect(await lookup('example.ox')).toBe(KEY);
    expect(calls).toHaveLength(2);
  });

  test('a registry error is thrown, not cached as "no key"', async () => {
    const { calls, fetchImpl } = fakeFetch();
    const lookup = apiDomainKeyLookup('https://api.example.test', { fetch: fetchImpl });
    await expect(lookup('broken.ox')).rejects.toThrow('500');
    await expect(lookup('broken.ox')).rejects.toThrow('500');
    expect(calls).toHaveLength(2);
  });

  test('the negative cache is bounded', async () => {
    const { fetchImpl } = fakeFetch();
    const lookup = apiDomainKeyLookup('https://api.example.test', {
      fetch: fetchImpl,
      maxEntries: 3,
    });
    for (let i = 0; i < 10; i++) expect(await lookup(`n${i}.ox`)).toBeNull();
  });
});
