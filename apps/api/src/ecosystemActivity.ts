import { createEcosystemTraffic } from '@oxy.so/core/server';

let activity: ReturnType<typeof createEcosystemTraffic> | undefined;

export function startEcosystemActivity(ready: () => boolean): void {
  if (!process.env.OXY_SERVICE_API_KEY?.trim() || !process.env.OXY_SERVICE_API_SECRET?.trim()) {
    console.warn('Ecosystem activity is disabled for tnp-api (missing OXY_SERVICE_API_KEY/OXY_SERVICE_API_SECRET)');
    return;
  }
  if (activity) return;
  activity = createEcosystemTraffic({ service: 'tnp-api', ready });
  activity.installFetch();
}

export function getEcosystemActivity() { return activity; }

/** Transport counters contain no address, domain, frame, or circuit identifier. */
export function recordTransport(direction: 'inbound' | 'outbound', peerRegion?: string): void {
  const region = process.env.AWS_REGION;
  activity?.record({
    scope: 'external', direction, activityType: 'platform',
    sourceRegion: direction === 'inbound' ? peerRegion : region,
    targetRegion: direction === 'inbound' ? region : peerRegion,
  });
}

export async function stopEcosystemActivity(): Promise<void> {
  const current = activity;
  activity = undefined;
  await current?.stop();
}
