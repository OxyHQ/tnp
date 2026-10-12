import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const entry = '../apps/web/worker/index.js';
const headersEntry = '../apps/web/worker/security-headers.js';
const repo = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(repo, path), 'utf8');

type Env = { ASSETS: { fetch: (input: Request | URL) => Promise<Response> } };
type Worker = { fetch: (request: Request, env: Env) => Promise<Response> };

const loadWorker = async (): Promise<Worker> => (await import(entry)).default;
const loadHeaders = async (): Promise<{
  CONTENT_SECURITY_POLICY: string;
  SITE_SECURITY_HEADERS: Record<string, string>;
  INSTALLER_SECURITY_HEADERS: Record<string, string>;
}> => import(headersEntry);

/** The source list of one CSP directive, or undefined when it is absent. */
function directive(policy: string, name: string): string[] | undefined {
  const segment = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return segment?.split(/\s+/).slice(1);
}

function expectSiteHeaders(response: Response, expected: Record<string, string>) {
  for (const [name, value] of Object.entries(expected)) {
    expect(response.headers.get(name)).toBe(value);
  }
}

test(`${entry}: preserves the asset response, status and headers`, async () => {
  const worker = await loadWorker();
  const response = new Response('asset', {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public,max-age=31536000,immutable',
    },
  });
  const result = await worker.fetch(new Request('https://tnp.network/image.png'), {
    ASSETS: { fetch: async () => response },
  });
  expect(result.status).toBe(200);
  expect(result.headers.get('Content-Type')).toBe('image/png');
  expect(result.headers.get('Cache-Control')).toContain('immutable');
  expect(await result.text()).toBe('asset');
});

test(`${entry}: asset failures propagate the original error`, async () => {
  const worker = await loadWorker();
  const error = new Error('asset failure');
  await expect(
    worker.fetch(new Request('https://tnp.network/file.png'), {
      ASSETS: {
        fetch: async () => {
          throw error;
        },
      },
    }),
  ).rejects.toBe(error);
});

describe(`${entry}: security headers on tnp.network`, () => {
  test('every asset response carries the full site header set', async () => {
    const worker = await loadWorker();
    const { SITE_SECURITY_HEADERS } = await loadHeaders();
    const result = await worker.fetch(new Request('https://tnp.network/'), {
      ASSETS: {
        fetch: async () =>
          new Response('<!doctype html>', {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          }),
      },
    });
    expectSiteHeaders(result, SITE_SECURITY_HEADERS);
    expect(result.headers.get('Strict-Transport-Security')).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
    expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(result.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(result.headers.get('X-Frame-Options')).toBe('DENY');
    // Not `same-origin`: that severs window.opener for the auth.oxy.so sign-in popup.
    expect(result.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin-allow-popups');
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb']) {
      expect(result.headers.get('Permissions-Policy')).toContain(`${feature}=()`);
    }
    expect(await result.text()).toBe('<!doctype html>');
  });

  test('the worker-built SPA fallback carries the same headers', async () => {
    const worker = await loadWorker();
    const { SITE_SECURITY_HEADERS } = await loadHeaders();
    const requested: string[] = [];
    const result = await worker.fetch(new Request('https://tnp.network/domains/abc'), {
      ASSETS: {
        fetch: async (input) => {
          const url = input instanceof Request ? input.url : input.href;
          requested.push(new URL(url).pathname);
          return url.endsWith('/index.html')
            ? new Response('index', { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
            : new Response('missing', { status: 404 });
        },
      },
    });
    expect(requested).toEqual(['/domains/abc', '/index.html']);
    expect(result.status).toBe(200);
    expect(result.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expectSiteHeaders(result, SITE_SECURITY_HEADERS);
    expect(await result.text()).toBe('index');
  });

  test('a policy already on the asset is replaced, never doubled', async () => {
    const worker = await loadWorker();
    const { CONTENT_SECURITY_POLICY } = await loadHeaders();
    const result = await worker.fetch(new Request('https://tnp.network/'), {
      ASSETS: {
        fetch: async () =>
          new Response('x', {
            headers: {
              'Content-Security-Policy': 'default-src *',
              'Referrer-Policy': 'unsafe-url',
            },
          }),
      },
    });
    expect(result.headers.get('Content-Security-Policy')).toBe(CONTENT_SECURITY_POLICY);
    expect(result.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  test('a bodiless 304 passes through with its status', async () => {
    const worker = await loadWorker();
    const result = await worker.fetch(new Request('https://tnp.network/app.js'), {
      ASSETS: {
        fetch: async () => new Response(null, { status: 304, headers: { ETag: '"abc"' } }),
      },
    });
    expect(result.status).toBe(304);
    expect(result.headers.get('ETag')).toBe('"abc"');
    expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

describe(`${entry}: get.tnp.network installer`, () => {
  for (const [userAgent, file] of [
    ['curl/8.7.1', '/install.sh'],
    ['Mozilla/5.0 (Windows NT; Windows NT 10.0) WindowsPowerShell/5.1', '/install.ps1'],
  ] as const) {
    test(`${file}: byte-identical body, text/plain, nosniff, closed policy`, async () => {
      const worker = await loadWorker();
      const { INSTALLER_SECURITY_HEADERS } = await loadHeaders();
      const script = read(`apps/web/public${file}`);
      const result = await worker.fetch(
        new Request('https://get.tnp.network/', { headers: { 'user-agent': userAgent } }),
        {
          ASSETS: {
            fetch: async (input) => {
              const path = new URL(input instanceof Request ? input.url : input.href).pathname;
              expect(path).toBe(file);
              return new Response(script, {
                headers: { 'Content-Type': 'application/octet-stream' },
              });
            },
          },
        },
      );
      expect(result.status).toBe(200);
      expect(await result.text()).toBe(script);
      expect(result.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
      expect(result.headers.get('Cache-Control')).toBe('no-cache');
      expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expectSiteHeaders(result, INSTALLER_SECURITY_HEADERS);
      expect(directive(result.headers.get('Content-Security-Policy') ?? '', 'default-src')).toEqual(
        ["'none'"],
      );
    });
  }
});

describe('Content-Security-Policy', () => {
  test('no inline or eval script, no framing, no plugins, no <base>', async () => {
    const { CONTENT_SECURITY_POLICY: csp } = await loadHeaders();
    expect(directive(csp, 'default-src')).toEqual(["'self'"]);
    expect(directive(csp, 'script-src')).toEqual(["'self'"]);
    expect(directive(csp, 'script-src-attr')).toEqual(["'none'"]);
    expect(directive(csp, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(csp, 'object-src')).toEqual(["'none'"]);
    expect(directive(csp, 'base-uri')).toEqual(["'none'"]);
    expect(directive(csp, 'form-action')).toEqual(["'self'"]);
    expect(directive(csp, 'font-src')).toEqual(["'self'"]);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toContain('strict-dynamic');
    // Only style-src may carry 'unsafe-inline' (react-native-web's runtime <style>).
    for (const name of csp.split(';').map((part) => part.trim().split(/\s+/)[0])) {
      if (name !== 'style-src')
        expect(directive(csp, name ?? '') ?? []).not.toContain("'unsafe-inline'");
    }
    // No scheme-wide or wildcard sources anywhere.
    for (const source of csp.split(/[;\s]+/)) {
      expect(['*', 'https:', 'http:', 'wss:', 'ws:']).not.toContain(source);
      expect(source.includes('*')).toBe(false);
    }
  });

  test('connect-src allows the API origins the built app is configured with', async () => {
    const { CONTENT_SECURITY_POLICY: csp } = await loadHeaders();
    const connect = directive(csp, 'connect-src') ?? [];

    const viteApiUrl = read('.github/workflows/deploy.yml').match(/VITE_API_URL:\s*(\S+)/)?.[1];
    expect(viteApiUrl).toBeDefined();
    expect(connect).toContain(new URL(viteApiUrl ?? '').origin);

    const oxyApi = read('apps/web/src/main.tsx').match(/const OXY_API = '([^']+)'/)?.[1];
    expect(oxyApi).toBeDefined();
    const oxyOrigin = new URL(oxyApi ?? '').origin;
    expect(connect).toContain(oxyOrigin);
    expect(connect).toContain(oxyOrigin.replace(/^https:/, 'wss:'));
  });

  test('index.html has no inline executable script and no inline handlers', () => {
    const html = read('apps/web/index.html');
    for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
      const attributes = match[1] ?? '';
      if (/\bsrc\s*=/i.test(attributes)) continue;
      // A JSON-LD data block never executes, so script-src does not govern it.
      expect(attributes).toMatch(/type\s*=\s*["']application\/ld\+json["']/i);
    }
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  });
});

describe('Pages deploy uses the locked wrangler', () => {
  test('wrangler is an exact devDependency of @tnp/web', () => {
    const manifest = JSON.parse(read('apps/web/package.json'));
    expect(manifest.devDependencies?.wrangler).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('deploy.yml runs the installed binary and never fetches one', () => {
    const workflow = read('.github/workflows/deploy.yml');
    const runs = [...workflow.matchAll(/^\s*run:\s*(.+)$/gm)].map((match) => match[1] ?? '');
    expect(runs.some((run) => run.startsWith('./node_modules/.bin/wrangler pages deploy'))).toBe(
      true,
    );
    for (const run of runs) {
      expect(run).not.toMatch(/\b(bunx|npx|pnpm dlx|yarn dlx)\b[^\n]*wrangler/);
      expect(run).not.toContain('wrangler@');
      expect(run).not.toContain('--minimum-release-age=0');
    }
    expect(workflow).not.toMatch(/^\s*(-\s*)?uses:\s*cloudflare\/wrangler-action/m);
  });
});
