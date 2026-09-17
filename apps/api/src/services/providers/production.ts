/**
 * The registry a running process uses: real adapters only.
 *
 * Adding a provider here is the act of making it selectable in production, so
 * it follows that provider's admission record (docs/providers/), not the other
 * way round. The test-only memory adapter is never registered here.
 */

import type { Database } from "../../db/postgres.js";
import { createPostgresQuotaGate } from "./rateLimit.js";
import { ProviderRegistry, type AdapterFactory } from "./registry.js";
import { createEnvSecretResolver } from "./secrets.js";

export const PRODUCTION_ADAPTERS: readonly AdapterFactory[] = [];

export function createProductionRegistry(db: Database): ProviderRegistry {
  const registry = new ProviderRegistry({
    secrets: createEnvSecretResolver(),
    quota: createPostgresQuotaGate(db),
    fetch: globalThis.fetch,
    now: () => new Date(),
  });
  for (const factory of PRODUCTION_ADAPTERS) registry.register(factory);
  return registry;
}
