/**
 * The API's Express application, assembled without starting anything.
 *
 * Split from `index.ts` so the middleware order — headers, rate limits,
 * timeouts, auth — is testable against the real assembly rather than a copy.
 * The services router is passed in, never imported: only `index.ts` may import
 * the services layer (`bun run validate:boundaries`).
 */

import { isIP } from 'node:net';
import cors from 'cors';
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { config } from './config.js';
import { getDb } from './db/postgres.js';
import { getEcosystemActivity } from './ecosystemActivity.js';
import { createHealthRouter } from './health.js';
import { oxyAuthOptional } from './middleware/auth.js';
import { createNetworkLimits, type NetworkLimitSettings } from './middleware/networkLimits.js';
import { requestTimeout, securityHeaders } from './middleware/security.js';
import { PARKING_CSP, renderParkingPage } from './parking.js';
import { decideParkingPage, loadNameFacts, type NameFacts } from './registry/resolve.js';
import clientRouter, { installerRoute } from './routes/client.js';
import dnsRouter from './routes/dns.js';
import domainKeysRouter from './routes/domain-keys.js';
import domainsRouter from './routes/domains.js';
import { createExitRouter } from './routes/exit.js';
import meRouter, { dnsRulesBodyParser } from './routes/me.js';
import nodesRouter from './routes/nodes.js';
import relaysRouter from './routes/relays.js';
import tldsRouter from './routes/tlds.js';
import { isValidHostname } from './utils/hostname.js';
import { logError } from './utils/logError.js';

export interface AppOptions {
  /** `/services`, built by `index.ts` from the services layer. */
  servicesRouter: RequestHandler;
  /** Defaults to the real optional Oxy auth. */
  auth?: RequestHandler;
  /** Defaults to the database; injectable so the parking page is testable without one. */
  loadParkingFacts?: (host: string) => Promise<NameFacts>;
  /** Defaults to the process's ecosystem traffic publisher, when one was started. */
  ecosystemActivity?: typeof getEcosystemActivity;
  limits?: NetworkLimitSettings;
  corsOrigins?: string[];
  requestTimeoutMs?: number;
}

export function createApp(options: AppOptions): express.Express {
  const auth = options.auth ?? oxyAuthOptional;
  const loadParkingFacts =
    options.loadParkingFacts ?? ((host: string) => loadNameFacts(getDb(), host));

  const limits = createNetworkLimits(
    options.limits ?? {
      trustProxyHops: config.trustProxyHops,
      trustCloudflareHeader: config.trustCloudflareHeader,
      cloudflareIpRanges: config.cloudflareIpRanges,
      exempt: config.rateLimitExempt,
      vpnExitAddresses: config.vpnExitAddresses,
    },
  );
  if (limits.invalidEntries.length > 0) {
    console.warn(
      `[tnp-api] ignoring unparseable rate-limit address entries: ${limits.invalidEntries.join(', ')}`,
    );
  }

  const app = express();
  app.disable('x-powered-by');
  // `trust proxy` stays off: it would let a client steer `req.hostname` with
  // X-Forwarded-Host. The rate limiter applies the proxy hop count itself
  // (middleware/clientIp.ts).

  app.use((req, res, next) => {
    const activity = (options.ecosystemActivity ?? getEcosystemActivity)();
    if (activity) activity.observeHttp(req, res, next);
    else next();
  });

  app.use(securityHeaders);
  app.use(
    cors({
      origin: options.corsOrigins ?? config.corsOrigins,
      credentials: true,
    }),
  );
  // Before the body parser and before auth: a client over its budget costs
  // neither a JSON parse nor a token validation.
  app.use(limits.perAddress);
  app.use(requestTimeout(options.requestTimeoutMs ?? config.requestTimeoutMs));
  // The encrypted DNS-rule envelope may exceed the default 100 KB; this
  // parser runs first on that one path, and the app-wide one then skips it.
  app.use('/me/dns-rules', dnsRulesBodyParser);
  app.use(express.json());

  // Serve installer scripts when accessed via get.tnp.network
  // curl -fsSL https://get.tnp.network | sh  →  serves install.sh
  // irm https://get.tnp.network/ps | iex     →  serves install.ps1 (also `/` from PowerShell)
  app.use((req, _res, next) => {
    const host = req.hostname;
    if (host !== 'get.tnp.network') return next();

    const route = installerRoute(req.path, req.get('user-agent'));
    if (route) req.url = route;
    next();
  });

  // Public routes -- no auth needed at all
  app.use('/dns', dnsRouter);
  app.use('/client', clientRouter);
  app.use('/health', createHealthRouter());
  // TNP's WireGuard exits, authenticated by their own bearer secret, never Oxy.
  app.use('/exit', createExitRouter({ vpn: () => config.vpn }));

  // Routes with mixed auth -- the optional auth resolves req.userId/req.user if
  // a token is present; individual write handlers enforce auth with
  // requireOxyAuth from @oxy.so/core/server. GET requests work without a token.
  // `perUser` meters writes per account once the account is known.
  app.use('/tlds', auth, limits.perUser, tldsRouter);
  app.use('/domains', auth, limits.perUser, domainsRouter);
  app.use('/domain-keys', auth, limits.perUser, domainKeysRouter);
  app.use('/nodes', auth, limits.perUser, nodesRouter);
  app.use('/relays', auth, limits.perUser, relaysRouter);
  // The caller's own resources; every route requires auth.
  app.use('/me', auth, limits.perUser, meRouter);

  // The optional services layer (docs/architecture/services.md). Every action is
  // off unless its flag is set, and no adapter is constructed until a flagged
  // route needs one — the network routes above never depend on it.
  app.use('/services', auth, limits.perUser, options.servicesRouter);

  // Serve parking page directly for TNP domain Host headers.
  // When a user visits "nate.ox" in their browser and the domain has no
  // service node, DNS points to this server and we render the parking page
  // inline — no redirect, URL stays as "nate.ox".
  app.use(async (req, res, next) => {
    const host = req.hostname;
    if (
      !host ||
      host === 'localhost' ||
      host.endsWith('tnp.network') ||
      host.endsWith('oxy.so') ||
      host.endsWith('pages.dev')
    ) {
      return next();
    }
    // A bare address is a request to the load balancer by IP, never a native name.
    if (!host.includes('.') || isIP(host) !== 0) return next();

    // `req.hostname` is the raw Host header. Express does not validate it, so it
    // can carry anything the sender put there — verified against Express 5.2.1:
    // `Host: a.ox<script>alert(1)</script>` arrives intact. Reject anything that
    // is not a plausible DNS name before it reaches a database query or the
    // response body.
    if (!isValidHostname(host)) return next();

    // Through a promise, so a synchronous throw (no database yet) is logged and
    // passed on like a failed query rather than escaping as a 500.
    const facts = await Promise.resolve()
      .then(() => loadParkingFacts(host))
      .catch((err: unknown) => {
        logError('Parking lookup error:', err);
        return null;
      });
    if (!facts) return next();

    const page = decideParkingPage(facts, {
      parkingIp: config.parkingIp,
      expiryEnforced: config.nativeExpiryEnforced,
      now: new Date(),
    });
    if (!page) return next();

    res.setHeader('Content-Security-Policy', PARKING_CSP);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderParkingPage(host, page));
  });

  // JSON, with the headers above, rather than Express's default HTML pages —
  // which replace the CSP and, for an error, would describe the failure.
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    logError('Unhandled error:', err);
    if (res.headersSent) return next(err);
    const status = (err as { status?: unknown })?.status;
    // A body-parser refusal (malformed JSON, too large) carries its own 4xx.
    const code = typeof status === 'number' && status >= 400 && status < 500 ? status : 500;
    res.status(code).json({ error: code === 500 ? 'Internal error' : 'Bad request' });
  });

  return app;
}
