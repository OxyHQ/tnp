/**
 * Response hardening applied to everything the API serves.
 *
 * The API serves three kinds of response: JSON, the installer scripts (text),
 * and the parking page (HTML for an arbitrary native Host). The defaults here
 * are for the first two — nothing on them should ever be rendered, framed or
 * sniffed into something executable — and the parking page loosens exactly one
 * directive, for its own inline stylesheet, by hash (`parking.ts`).
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * No `preload` and no zone-wide commitment: HSTS on `api.tnp.network` and
 * `get.tnp.network` covers those hosts and their subdomains only. Whether all
 * of `tnp.network` is preloaded is a decision for whoever owns the zone, not
 * this service. Browsers ignore the header on plain-HTTP responses, so sending
 * it unconditionally is harmless for the parking page's `http://name.ox`.
 */
export const HSTS = 'max-age=31536000; includeSubDomains';

/** For JSON and text: load nothing, be framed by nothing. */
export const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

export const securityHeaders: RequestHandler = (
  _req: Request,
  res: Response,
  next: NextFunction,
) => {
  res.setHeader('Strict-Transport-Security', HSTS);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // The parking page links out to tnp.network; a referrer would tell that
  // site which native name the visitor was looking at.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', DEFAULT_CSP);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.removeHeader('X-Powered-By');
  next();
};

/**
 * Answer 503 for a request still running after `timeoutMs`.
 *
 * postgres.js queues a query behind a busy pool without limit, and the
 * statement timeout only starts once a query runs, so without this a slow
 * database turns every incoming request into an open connection waiting
 * behind it. The handler is not cancelled — it cannot be, mid-query — but its
 * eventual response is discarded instead of throwing on a finished response.
 */
export function requestTimeout(timeoutMs: number): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (timeoutMs <= 0) return next();

    const timer = setTimeout(() => {
      if (res.headersSent) return;
      res.setHeader('Retry-After', '5');
      res.status(503).json({ error: 'timeout', message: 'The server took too long to respond.' });
    }, timeoutMs);
    timer.unref?.();
    const clear = () => clearTimeout(timer);
    res.on('finish', clear);
    res.on('close', clear);

    // After the timeout answered, the handler's own response is a no-op rather
    // than an ERR_HTTP_HEADERS_SENT thrown from inside its catch block.
    const send = res.send.bind(res);
    res.send = ((body?: unknown) => (res.headersSent ? res : send(body))) as Response['send'];
    const json = res.json.bind(res);
    res.json = ((body?: unknown) => (res.headersSent ? res : json(body))) as Response['json'];
    const setHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: number | string | readonly string[]) =>
      res.headersSent ? res : setHeader(name, value)) as Response['setHeader'];

    next();
  };
}
