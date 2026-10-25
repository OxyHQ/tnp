import { afterEach, expect, test } from 'bun:test';
import type { createEcosystemTraffic } from '@oxy.so/core/server';
import { startEcosystemActivity, stopEcosystemActivity } from './ecosystemActivity';
afterEach(stopEcosystemActivity);
test('tnp-relay publishes using a temporary role, without customer keys', () => {
  const calls: Parameters<typeof createEcosystemTraffic>[0][] = [];
  const create = ((options) => {
    calls.push(options);
    return { installFetch() {}, async stop() {} };
  }) as typeof createEcosystemTraffic;
  startEcosystemActivity(() => true, create, 'us-west-2');
  expect(calls[0]?.service).toBe('tnp-relay');
  expect(typeof calls[0]?.workloadCredentials).toBe('function');
  expect(calls[0]?.credential).toBeUndefined();
});
