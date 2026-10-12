import {
  INSTALLER_SECURITY_HEADERS,
  SITE_SECURITY_HEADERS,
  withHeaders,
} from './security-headers.js';

// Cloudflare Pages Worker (Advanced Mode: `_routes.json` sends it every request)
// 1. Serves install scripts when requests come from get.tnp.network
//    Autodetects platform: curl/wget gets .sh, PowerShell gets .ps1
// 2. For tnp.network, serves static assets with SPA fallback
// Every response carries the headers in `security-headers.js`; in Advanced
// Mode nothing else in Pages adds them.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // get.tnp.network -- serve install scripts
    if (url.hostname === 'get.tnp.network') {
      const ua = (request.headers.get('user-agent') || '').toLowerCase();
      const isWindows = ua.includes('powershell') || ua.includes('windowspowershell');

      const file = isWindows ? '/install.ps1' : '/install.sh';
      const asset = await env.ASSETS.fetch(new URL(file, url.origin));

      return new Response(asset.body, {
        headers: {
          ...INSTALLER_SECURITY_HEADERS,
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'no-cache',
        },
      });
    }

    // tnp.network -- serve static assets, SPA fallback to index.html
    const response = await env.ASSETS.fetch(request);

    if (response.status === 404) {
      // SPA fallback: serve index.html for client-side routing
      const indexResponse = await env.ASSETS.fetch(new URL('/index.html', url.origin));
      return withHeaders(
        new Response(indexResponse.body, {
          status: 200,
          headers: indexResponse.headers,
        }),
        SITE_SECURITY_HEADERS,
      );
    }

    return withHeaders(response, SITE_SECURITY_HEADERS);
  },
};
