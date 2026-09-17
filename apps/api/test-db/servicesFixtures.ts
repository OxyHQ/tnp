/**
 * Fixtures for services-layer database tests: a user, a sandbox provider
 * account bound to the in-memory adapter, and an engine wired to it.
 */

import { eq, sql } from "drizzle-orm";
import type { Database } from "../src/db/postgres.js";
import { operations, providerAccounts, users } from "../src/db/schema/index.js";
import { OperationEngine, type EngineOptions } from "../src/services/operations/engine.js";
import { createOperationHandlers } from "../src/services/operations/handlers.js";
import type { ContactSet } from "../src/services/providers/contracts.js";
import { ProviderRegistry, type QuotaGate } from "../src/services/providers/registry.js";
import { createEnvSecretResolver } from "../src/services/providers/secrets.js";
import { MemoryProviderState, memoryProviderFactory } from "../src/services/providers/testing/memoryProvider.js";
import type { TestDatabase } from "./harness.js";

export const openQuota: QuotaGate = { acquire: async () => {} };

export const CONTACT = {
  firstName: "Test",
  lastName: "Registrant",
  address1: "1 Example Street",
  city: "Exampleton",
  stateProvince: "EX",
  postalCode: "00000",
  country: "US",
  phone: "+1.5555550100",
  email: "registrant@example.invalid",
};
export const CONTACTS: ContactSet = { registrant: CONTACT, admin: CONTACT, tech: CONTACT, billing: CONTACT };

export function asDatabase(t: TestDatabase): Database {
  return t.db;
}

export async function createUser(db: Database, oxyUserId = `oxy-${crypto.randomUUID()}`): Promise<string> {
  const [row] = await db.insert(users).values({ oxyUserId }).returning({ id: users.id });
  return row.id;
}

export async function createAccount(
  db: Database,
  overrides: Partial<typeof providerAccounts.$inferInsert> = {},
): Promise<typeof providerAccounts.$inferSelect> {
  const [row] = await db
    .insert(providerAccounts)
    .values({
      adapter: "memory",
      environment: "sandbox",
      label: `memory-${crypto.randomUUID()}`,
      salesState: "enabled",
      managementMode: "active",
      ...overrides,
    })
    .returning();
  return row;
}

export function memoryRegistry(state: MemoryProviderState, quota: QuotaGate = openQuota): ProviderRegistry {
  return new ProviderRegistry({
    secrets: createEnvSecretResolver({}),
    quota,
    fetch: globalThis.fetch,
    now: () => new Date(),
  }).register(memoryProviderFactory(state));
}

export function engineFor(
  db: Database,
  state: MemoryProviderState,
  options: Partial<EngineOptions> = {},
): OperationEngine {
  return new OperationEngine({
    db,
    workerId: `test-worker-${crypto.randomUUID().slice(0, 8)}`,
    handlers: createOperationHandlers(memoryRegistry(state)),
    settleMs: 0,
    ...options,
  });
}

/** Make an operation runnable now, instead of waiting out its backoff. */
export async function makeDue(db: Database, operationId: string): Promise<void> {
  await db.update(operations).set({ nextRunAt: sql`now() - interval '1 second'` }).where(eq(operations.id, operationId));
}

export async function loadOperation(db: Database, id: string) {
  const [row] = await db.select().from(operations).where(eq(operations.id, id));
  return row;
}

export { MemoryProviderState };
