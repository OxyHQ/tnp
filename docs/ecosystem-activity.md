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

## Cloudflare web traffic

The web app's traffic (Cloudflare Pages project `tnp`, serving `tnp.network`) is
measured keylessly by Oxy from Cloudflare's own analytics;
see OxyHQ/oxy `docs/operations/cloudflare-web-activity.md`. This repo holds no
Oxy activity secret and runs no activity code: `apps/web/worker/index.js` only
serves the installer scripts and the SPA fallback. The `OXY_EDGE_ACTIVITY_*` bindings were
never provisioned and nothing reads them now; if an operator ever finds one on a
deployment, it can simply be deleted.
