import { describe, expect, test } from 'bun:test';
import type { createEcosystemTraffic } from '@oxy.so/core/server';
import {
  canAuthenticateAsOxyService,
  getEcosystemActivity,
  startEcosystemActivity,
} from './ecosystemActivity';

/**
 * The identity answer is INJECTED rather than arranged.
 *
 * `canAttestWorkloadIdentity` reads `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`,
 * which ECS sets and nothing else does, so a test that set it would be asserting
 * this suite's idea of how the SDK detects a task role rather than what tnp-api
 * does with the answer. Mocking the module instead is worse still here: bun's
 * `mock.module` is global to the test process, and replacing
 * `@oxy.so/core/server` for one file broke four unrelated tests in this app.
 */
describe('tnp-api ecosystem activity bootstrap', () => {
  test('starts on an attestable task role with no key pair anywhere', () => {
    // The case the key check got wrong. A deployed task carries no pair at all —
    // it attests its ECS task role — and the old gate read that as "no
    // credentials" and returned. From the dashboard that is indistinguishable
    // from a quiet day, with nothing saying the publisher never started.
    delete process.env.OXY_SERVICE_API_KEY;
    delete process.env.OXY_SERVICE_API_SECRET;
    let installations = 0;
    const create = (() => ({
      installFetch() {
        installations++;
      },
      record() {},
    })) as unknown as typeof createEcosystemTraffic;
    startEcosystemActivity(
      () => true,
      () => true,
      create,
    );
    expect(installations).toBe(1);
    expect(getEcosystemActivity()).toBeDefined();
  });

  test('refuses when it can neither attest nor present a pair', () => {
    // The honest "this process cannot act as itself here" — a laptop, a CI box.
    // Asserted through the injected answer, which is what production computes
    // from the two together.
    const create = (() => {
      throw new Error('must not run');
    }) as unknown as typeof createEcosystemTraffic;
    expect(() =>
      startEcosystemActivity(
        () => true,
        () => false,
        create,
      ),
    ).not.toThrow();
  });

  /**
   * The predicate itself, which is where the decision lives — the cases above
   * inject past it and would stay green if it went back to reading the pair.
   */
  describe('canAuthenticateAsOxyService', () => {
    test('an attestable task role is enough, with no pair anywhere', () => {
      delete process.env.OXY_SERVICE_API_KEY;
      delete process.env.OXY_SERVICE_API_SECRET;
      expect(canAuthenticateAsOxyService(() => true)).toBe(true);
    });

    test('a complete pair is enough where nothing can attest', () => {
      process.env.OXY_SERVICE_API_KEY = 'fixture';
      process.env.OXY_SERVICE_API_SECRET = 'fixture';
      expect(canAuthenticateAsOxyService(() => false)).toBe(true);
    });

    test('a half pair is not an identity, and neither is nothing', () => {
      delete process.env.OXY_SERVICE_API_SECRET;
      expect(canAuthenticateAsOxyService(() => false)).toBe(false);
      delete process.env.OXY_SERVICE_API_KEY;
      expect(canAuthenticateAsOxyService(() => false)).toBe(false);
    });
  });
});
