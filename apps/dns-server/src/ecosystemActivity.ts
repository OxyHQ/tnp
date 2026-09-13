import { createEcosystemTraffic } from '@oxy.so/core/server';

let activity: ReturnType<typeof createEcosystemTraffic> | undefined;

export function startEcosystemActivity(ready: () => boolean): void {
  const enabled = process.env.OXY_ECOSYSTEM_ACTIVITY_ENABLED;
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false') {
    throw new Error('OXY_ECOSYSTEM_ACTIVITY_ENABLED must be true or false');
  }
  if (enabled !== 'true') {
    console.warn('Ecosystem activity is disabled for tnp-dns');
    return;
  }
  if (activity) return;
  activity = createEcosystemTraffic({ service: 'tnp-dns', ready });
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
