import { createEcosystemTraffic } from '@oxy.so/core/server';
import { workloadCredentials } from './oxy.js';

let activity: ReturnType<typeof createEcosystemTraffic> | undefined;

/** Own publishers use a live workload registration, never a customer API key.
 * Temporary AWS roles work on ECS and authenticated development hosts. The
 * publisher reports missing/revoked identity using its shared retry policy.
 */
export function startEcosystemActivity(
  ready: () => boolean,
  create: typeof createEcosystemTraffic = createEcosystemTraffic,
  region = process.env.AWS_REGION,
): void {
  if (activity || !region) return;
  activity = create({ service: 'tnp-api', ready, region, workloadCredentials });
  activity.installFetch();
}

export function getEcosystemActivity() {
  return activity;
}

/** Transport counters contain no address, domain, frame, or circuit identifier. */
export function recordTransport(direction: 'inbound' | 'outbound', peerRegion?: string): void {
  const region = process.env.AWS_REGION;
  activity?.record({
    scope: 'external',
    direction,
    activityType: 'platform',
    sourceRegion: direction === 'inbound' ? peerRegion : region,
    targetRegion: direction === 'inbound' ? region : peerRegion,
  });
}

export async function stopEcosystemActivity(): Promise<void> {
  const current = activity;
  activity = undefined;
  await current?.stop();
}
