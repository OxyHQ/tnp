import type { EcosystemTraffic } from '@oxy.so/core/server';
import { metadataFromHeaders, sourceRegionFromEdgePop } from '@oxy.so/telemetry/server';

/** Transport counters contain no address, domain, frame, or circuit identifier. */
export function recordTransport(
  traffic: EcosystemTraffic,
  direction: 'inbound' | 'outbound',
  peerRegion?: string,
): void {
  const region = process.env.AWS_REGION;
  traffic.record({
    scope: 'external',
    direction,
    activityType: 'platform',
    sourceRegion: direction === 'inbound' ? peerRegion : region,
    targetRegion: direction === 'inbound' ? region : peerRegion,
  });
}

export function requestEdgeRegion(headers: Headers): string | undefined {
  return sourceRegionFromEdgePop(
    metadataFromHeaders({ 'cf-ray': headers.get('cf-ray') ?? undefined }).edgePop,
  );
}
