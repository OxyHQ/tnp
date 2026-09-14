# Ecosystem activity

The API, public DNS daemon, and hosted relay each have a collector and a live
infrastructure heartbeat. Each process turns collection on for itself once
`OXY_SERVICE_API_KEY` and `OXY_SERVICE_API_SECRET` are both set (plus
`AWS_REGION` for region metadata) — this credential is dedicated to ecosystem
activity in all three apps and used for nothing else, so there is no separate
enable flag. Missing either credential emits a warning and collection stays
off. These settings do not activate infrastructure. The September 13 live ECS
audit found one running API task and one running DNS task; the relay alone
remains parked with desired count zero and retains the separate publication
and deployment blockers documented in `architecture/relays.md`.

The shared SDK observes API HTTP requests/responses and outgoing fetch/Node HTTP
calls, including the DNS daemon's control-plane calls. The DNS proxy exposes an
optional callback carrying only `inbound` or `outbound` for UDP/TCP traffic. The
public daemon installs it; the desktop/client proxy does not publish telemetry.
Observer failures cannot alter DNS answers.

The hosted relay counts received frames and accepted sends. Encrypted frames
remain opaque and are categorized as platform traffic; it does not infer media
from encrypted content. Community service nodes are external peers, not Oxy
infrastructure. Only a Cloudflare PoP from the upgrade headers contributes a
peer region. DNS UDP/TCP peers have no such metadata, so their geography remains
unknown. There is no IP geolocation and no fabricated geographic line.

No DNS query name, peer address, circuit ID, domain, frame contents, or key enters
an activity event. Counts, direction, category, and the hosting region are the
only DNS transport metadata. Infrastructure heartbeats describe these processes,
not an arbitrary community node or an undeployed service.

## Cloudflare edge requests

Every deployed frontend request, including static files, runs the shared `@oxy.so/telemetry/edge` observer. Workers use `run_worker_first = true`; Pages builds emit a bundled Advanced Mode `_worker.js` with `_routes.json` including `/*`. The original asset handler still owns responses, redirects, streams, MIME handling and cache headers. This increases Worker/Functions invocations for static requests.

Configure **server-only** bindings `OXY_EDGE_ACTIVITY_ENABLED=true`, `OXY_EDGE_ACTIVITY_API_KEY`, `OXY_EDGE_ACTIVITY_API_SECRET`, and optionally `OXY_EDGE_ACTIVITY_API_URL` (default `https://api.oxy.so`). Use a dedicated activity credential, separate from the backend application credential. Never place these bindings in public Expo/Vite variables or committed files. Enabled publication failures emit a fixed error while preserving website availability. Deployment and valid credentials are required before this is live; a code merge alone does not enable coverage.

Each completed response publishes a batch with incoming and outgoing counters through `ctx.waitUntil`. Failed handlers count only the incoming request. Health, collector and authentication control requests are excluded. No URLs, payloads, IP addresses, user identifiers or query strings are sent. Cloudflare `request.cf.colo` identifies the serving PoP; the visitor endpoint stays unknown, so external static activity is a PoP pulse, not a fabricated geographic arc. Credentials and counters never enter frontend bundles.
