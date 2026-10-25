import { afterEach, describe, expect, test } from 'bun:test';
import type { createEcosystemTraffic } from '@oxy.so/core/server';
import {
  getEcosystemActivity,
  startEcosystemActivity,
  stopEcosystemActivity,
} from './ecosystemActivity';

afterEach(stopEcosystemActivity);
describe('tnp-api workload activity', () => {
  test('passes a temporary role provider without an ECS-only or API-key gate', () => {
    const calls: Parameters<typeof createEcosystemTraffic>[0][] = [];
    let installations = 0;
    const create = ((options) => {
      calls.push(options);
      return {
        installFetch() {
          installations++;
        },
        async stop() {},
      };
    }) as typeof createEcosystemTraffic;
    const ready = () => true;
    startEcosystemActivity(ready, create, 'us-west-2');
    startEcosystemActivity(ready, create, 'us-west-2');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe('tnp-api');
    expect(calls[0]?.ready).toBe(ready);
    expect(typeof calls[0]?.workloadCredentials).toBe('function');
    expect(calls[0]?.credential).toBeUndefined();
    expect(installations).toBe(1);
    expect(getEcosystemActivity()).toBeDefined();
  });
});

test('omits only telemetry when infrastructure region is not configured', () => {
  const create = (() => {
    throw new Error('publisher must not start without location');
  }) as typeof createEcosystemTraffic;
  startEcosystemActivity(() => true, create, '');
  expect(getEcosystemActivity()).toBeUndefined();
});
