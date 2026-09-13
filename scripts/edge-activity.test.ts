import { test, expect } from 'bun:test';

const entries = ["../apps/web/worker/index.js"];
for (const entry of entries) {
  test(`${entry}: preserves assets while publishing anonymous incoming/outgoing counts`, async () => {
    const worker = (await import(entry)).default;
    const response = new Response('asset', {headers: {'Content-Type':'image/png', 'Cache-Control':'public,max-age=31536000,immutable'}});
    const request = new Request('https://example.com/private-image.png?user=secret', {headers:{'CF-Connecting-IP':'203.0.113.2'}});
    Object.assign(request, {cf:{colo:'MAD'}});
    const calls: {url:string;init?:RequestInit}[] = [];
    const tasks: Promise<unknown>[] = [];
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({url:String(input),init});
      return String(input).endsWith('/auth/service-token') ? Response.json({token:'token',expiresIn:3600}) : new Response(null,{status:204});
    }) as typeof fetch;
    try {
      const result = await worker.fetch(request, {ASSETS:{fetch:async()=>response}, OXY_EDGE_ACTIVITY_ENABLED:'true',OXY_EDGE_ACTIVITY_API_KEY:'key',OXY_EDGE_ACTIVITY_API_SECRET:'secret'}, {waitUntil:(p:Promise<unknown>)=>tasks.push(p)});
      expect(result.status).toBe(200);
      expect(result.headers.get('Cache-Control')).toContain('immutable');
      expect(await result.text()).toBe('asset');
      await Promise.all(tasks);
      expect(calls.map(c=>c.url)).toEqual(['https://api.oxy.so/auth/service-token','https://api.oxy.so/internal/activity']);
      const body = String(calls[1].init?.body);
      expect(body).not.toMatch(/private-image|secret|203\.0|example.com/);
      const events = JSON.parse(body);
      expect(events.map((event:{direction:string})=>event.direction)).toEqual(['inbound','outbound']);
      expect(events[0]).toMatchObject({region:'edge-mad',scope:'external',activityType:'media'});
    } finally { globalThis.fetch = oldFetch; }
  });
  test(`${entry}: asset failures preserve the original error with monitoring disabled`, async () => {
    const worker = (await import(entry)).default;
    const error = new Error('asset failure');
    await expect(worker.fetch(new Request('https://example.com/file.png'), {ASSETS:{fetch:async()=>{throw error;}}}, {waitUntil:()=>{throw new Error('disabled activity');}})).rejects.toBe(error);
  });
}
