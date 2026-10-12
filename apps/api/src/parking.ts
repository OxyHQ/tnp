/**
 * The parking page: the HTML the API serves when a browser asks for a native
 * name that has no live service node (`decideParkingPage`).
 *
 * It is served for an arbitrary Host the visitor's resolver pointed here, so
 * it gets the strictest policy that still renders it: no script, no frame, no
 * form, no base, no images, no fetches, and one inline stylesheet allowed by
 * its SHA-256 rather than by `'unsafe-inline'`. Links still navigate; CSP does
 * not restrict top-level navigation.
 */

import { createHash } from 'node:crypto';
import type { ParkingPage } from './registry/resolve.js';
import { escapeHtml } from './utils/hostname.js';

const STYLE = `
    *{margin:0;padding:0;box-sizing:border-box}
    body{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#000;color:#e0e0e0;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;text-align:center;padding:2rem}
    h1{font-size:2.5rem;color:#00ffa3;margin-bottom:1rem;letter-spacing:-0.02em}
    p{font-size:0.875rem;color:#888;margin-bottom:2rem}
    a{color:#00ffa3;text-decoration:none;font-size:0.875rem;transition:color .2s}
    a:hover{color:#fff}
    .links{display:flex;flex-direction:column;gap:0.75rem}
    .footer{position:fixed;bottom:2rem;font-size:0.75rem;color:#444}
    .footer a{color:#555;font-size:0.75rem}
  `;

const STYLE_HASH = createHash('sha256').update(STYLE, 'utf8').digest('base64');

export const PARKING_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${STYLE_HASH}'`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * The page for `host`. `host` must already have passed `isValidHostname`,
 * which excludes every character that is dangerous here; the escape below is
 * defence in depth, keeping the page safe if that validator is ever loosened.
 */
export function renderParkingPage(host: string, page: ParkingPage): string {
  const safeHost = escapeHtml(host);

  const copy = {
    available: {
      title: `${safeHost} — Available on TNP`,
      subtitle: 'This domain is available. Register it on The Network Protocol.',
      ctaText: 'Register this domain',
    },
    registered: {
      title: `${safeHost} — Registered on TNP`,
      subtitle: 'This domain is registered on The Network Protocol.',
      ctaText: 'View domain details',
    },
    // Never the "available" page: an expired name is held for its owner, and
    // telling a visitor they can register it would be false.
    held: {
      title: `${safeHost} — Expired, held on TNP`,
      subtitle:
        "This domain's registration has expired. It is held for its owner and cannot be registered by anyone else.",
      ctaText: 'View domain details',
    },
  }[page];
  const { title, subtitle, ctaText } = copy;
  // Encoded for URL semantics, then escaped for the HTML attribute it lands in.
  // `encodeURIComponent` alone leaves `'` intact, which is harmless inside a
  // double-quoted attribute and a breakout the moment someone changes the
  // quoting — so both steps run rather than relying on the quote style.
  // The detail page is per registered name, so a subdomain links to its parent.
  const registrable = host.toLowerCase().split('.').slice(-2).join('.');
  const ctaHref =
    page === 'available'
      ? 'https://tnp.network/register'
      : `https://tnp.network/d/${escapeHtml(encodeURIComponent(registrable))}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta name="referrer" content="no-referrer">
  <title>${title}</title>
  <style>${STYLE}</style>
</head>
<body>
  <h1>${safeHost}</h1>
  <p>${subtitle}</p>
  <div class="links">
    <a href="${ctaHref}" rel="noreferrer">[${ctaText}]</a>
    <a href="https://oxy.so/tnp" rel="noreferrer">[What is TNP?]</a>
  </div>
  <div class="footer">Powered by <a href="https://tnp.network" rel="noreferrer">TNP</a> · <a href="https://oxy.so" rel="noreferrer">Oxy</a></div>
</body>
</html>`;
}
