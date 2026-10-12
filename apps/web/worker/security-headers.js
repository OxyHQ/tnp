// Security headers for every response the tnp.network Pages deployment serves.
//
// They are set HERE, in the worker, and not in `public/_headers`: the site runs
// in Pages Advanced Mode (`dist/_worker.js`, routed for `/*` by `_routes.json`),
// so every response is one the worker returns, including the ones it builds
// itself (the SPA fallback and the get.tnp.network installer). Advanced Mode
// also switches off the `nosniff` / `Referrer-Policy` defaults plain Pages
// injects (~/Oxy/docs/infra-and-deploys.md), so nothing is sent unless the
// worker sends it. One place, one policy, asserted by
// `scripts/web-worker.test.ts`.
//
// The Oxy SDK keeps a long-lived device credential in localStorage, so a single
// script that runs on this origin owns the user's Oxy account. The CSP is the
// line that keeps a foreign script from running here at all.

/**
 * Origins the dashboard talks to, and nothing else.
 *
 * - `https://api.tnp.network` — TNP's API. The deploy builds the app with
 *   `VITE_API_URL=https://api.tnp.network` (`.github/workflows/deploy.yml`);
 *   a test fails if that value and this list drift apart.
 * - `https://api.oxy.so` / `wss://api.oxy.so` — the Oxy API `OxyProvider` is
 *   given in `src/main.tsx`, over HTTPS and the session Socket.IO channel.
 * - `https://cloud.oxy.so` — the Oxy CDN avatars and files resolve through.
 *
 * The Oxy sign-in popup (auth.oxy.so) is a top-level window the SDK opens, not
 * a subresource, so it needs no source here; its result arrives by
 * `postMessage`.
 */
export const TNP_API_ORIGIN = 'https://api.tnp.network';
export const OXY_API_ORIGIN = 'https://api.oxy.so';
export const OXY_API_WEBSOCKET_ORIGIN = 'wss://api.oxy.so';
export const OXY_CDN_ORIGIN = 'https://cloud.oxy.so';

/**
 * The page's Content-Security-Policy, one directive per entry.
 *
 * - `script-src 'self'`: the built `index.html` has one external module script
 *   and one `application/ld+json` data block, which never executes and needs
 *   no source. No `'unsafe-inline'`, no `'unsafe-eval'`.
 * - `style-src 'unsafe-inline'`: react-native-web (which `@oxy.so/services` and
 *   Bloom render through) and sonner inject `<style>` elements at runtime;
 *   without it the app renders unstyled. Styles cannot run script. This is the
 *   same exception the Oxy-wide baseline (`@oxy.so/core/server`) makes.
 * - `img-src blob:`: the SDK's avatar crop and file screens preview a picked
 *   file through `URL.createObjectURL`.
 * - No Cloudflare Web Analytics hosts: third-party measurement does not run on
 *   a page this audience signs in on. If the zone ever injects the beacon, it
 *   is blocked, by design.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${OXY_CDN_ORIGIN}`,
  "font-src 'self'",
  `connect-src 'self' ${TNP_API_ORIGIN} ${OXY_API_ORIGIN} ${OXY_API_WEBSOCKET_ORIGIN} ${OXY_CDN_ORIGIN}`,
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

/** Every powerful feature the dashboard never uses, denied to it and to anything it embeds. */
export const PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'serial=()',
  'hid=()',
  'display-capture=()',
  'publickey-credentials-get=()',
  'publickey-credentials-create=()',
  'browsing-topics=()',
].join(', ');

/** Headers every response carries, whatever its type. */
const BASE_HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

/**
 * Headers for the dashboard (documents and the assets they load).
 *
 * `Cross-Origin-Opener-Policy` is `same-origin-allow-popups`, NOT `same-origin`:
 * Oxy sign-in opens auth.oxy.so in a popup that hands its result back through
 * `window.opener.postMessage`, and `same-origin` severs `window.opener` for
 * that cross-origin popup, which breaks sign-in. `same-origin-allow-popups`
 * keeps the popups this page opens while still detaching the page from any
 * cross-origin window that opened IT.
 */
export const SITE_SECURITY_HEADERS = Object.freeze({
  ...BASE_HEADERS,
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Permissions-Policy': PERMISSIONS_POLICY,
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
});

/**
 * Headers for the get.tnp.network installer scripts. Plain text is never a
 * document a browser should render or execute, so the policy is closed
 * completely.
 */
export const INSTALLER_SECURITY_HEADERS = Object.freeze({
  ...BASE_HEADERS,
  'Content-Security-Policy':
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
});

/**
 * Copy `response` with `headers` set on it, overwriting any earlier value.
 * Body and status are passed through untouched.
 */
export function withHeaders(response, headers) {
  const merged = new Headers(response.headers);
  for (const [name, value] of Object.entries(headers)) {
    merged.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}
