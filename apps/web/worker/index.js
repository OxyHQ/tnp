import {
  INSTALLER_SECURITY_HEADERS,
  SITE_SECURITY_HEADERS,
  withHeaders,
} from './security-headers.js';

// Cloudflare Pages Worker (Advanced Mode: `_routes.json` sends it every request)
// 1. get.tnp.network: redirects to the installer the API serves. The API is the
//    only source of the installers (apps/api/src/installers/): they embed the
//    pinned release key and version from @tnp/shared-types, which a static copy
//    here would silently drift from (one did: it pinned v0.1.0 and verified
//    nothing). In production get.tnp.network is routed to the API directly;
//    this only matters if the host ever reaches Pages.
// 2. For tnp.network, serves static assets with SPA fallback
// Every response carries the headers in `security-headers.js`; in Advanced
// Mode nothing else in Pages adds them.
const INSTALLER_ORIGIN = 'https://api.tnp.network';

function installerPath(pathname, userAgent) {
  if (pathname === '/install.sh') return '/client/install.sh';
  if (pathname === '/ps' || pathname === '/install.ps1') return '/client/install.ps1';
  return (userAgent || '').toLowerCase().includes('powershell')
    ? '/client/install.ps1'
    : '/client/install.sh';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === 'get.tnp.network') {
      const target = installerPath(url.pathname, request.headers.get('user-agent'));
      return new Response(null, {
        status: 302,
        headers: {
          ...INSTALLER_SECURITY_HEADERS,
          location: `${INSTALLER_ORIGIN}${target}`,
          'cache-control': 'no-store',
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
