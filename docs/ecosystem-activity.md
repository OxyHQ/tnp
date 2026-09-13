# Ecosystem activity

The API, public DNS daemon, and hosted relay each have a collector and a live
infrastructure heartbeat. Enable a process with `OXY_ECOSYSTEM_ACTIVITY_ENABLED=true`,
`AWS_REGION`, `OXY_SERVICE_API_KEY`, and `OXY_SERVICE_API_SECRET`. Missing required
configuration fails at startup; disabled collection emits a warning. These
settings do not activate infrastructure: the three ECS services remain parked,
and the relay retains the separate publication and deployment blockers documented
in `architecture/relays.md`.

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
