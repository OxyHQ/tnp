import { canAttestWorkloadIdentity, createEcosystemTraffic } from '@oxy.so/core/server';

let activity: ReturnType<typeof createEcosystemTraffic> | undefined;

/**
 * Whether this process can act as its Oxy application AT ALL.
 *
 * The question the key check was always asking, and the reason it had to stop
 * asking it by name. Under oxy ADR 0026 a first-party service proves what it
 * IS: on ECS the task role attests and there is no secret anywhere, and
 * `createEcosystemTraffic` mints from whichever of the two it finds. A deployed
 * task therefore carries neither variable.
 *
 * Read this rather than the pair, because the pair's absence stopped being
 * evidence of anything. On the deploy that drops the two variables a key check
 * would take the `return` below on a task whose identity is its ROLE — and what
 * that looks like from outside is this service reporting zero traffic to the
 * ecosystem dashboard, indistinguishable from a quiet day, with one warning
 * line in the log and nothing anywhere saying the publisher was never started.
 *
 * A checkout that can neither attest nor present a pair is still the honest
 * "this process cannot act as itself here", and the two names are still the
 * thing to set THERE.
 */
export function canAuthenticateAsOxyService(
  /**
   * The SDK boundary, injectable because it is the one thing a test cannot
   * honestly arrange: it reads `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, which
   * ECS sets and nothing else does, so setting it would assert a suite's idea of
   * how the SDK detects a task role rather than what this function decides.
   */
  canAttest: () => boolean = canAttestWorkloadIdentity,
): boolean {
  return (
    canAttest() ||
    Boolean(process.env.OXY_SERVICE_API_KEY?.trim() && process.env.OXY_SERVICE_API_SECRET?.trim())
  );
}

export function startEcosystemActivity(
  ready: () => boolean,
  /** Injectable so a test can state the answer instead of arranging ECS's environment. */
  canAuthenticate: () => boolean = canAuthenticateAsOxyService,
  /** Injectable for the same reason: constructing the real publisher needs a real identity. */
  create: typeof createEcosystemTraffic = createEcosystemTraffic,
): void {
  if (!canAuthenticate()) {
    console.warn('Ecosystem activity is disabled for tnp-api: no attestable task role and no OXY_SERVICE_API_KEY/OXY_SERVICE_API_SECRET');
    return;
  }
  if (activity) return;
  activity = create({ service: 'tnp-api', ready });
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
