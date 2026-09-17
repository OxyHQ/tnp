#!/usr/bin/env bun
/**
 * Operator tool: place a SANDBOX registration order end to end, without
 * charging anyone, to exercise the real adapter, the outbox and the worker.
 *
 *   bun src/services/scripts/sandbox-order.ts \
 *     --account <provider account id> --owner <oxy user id> \
 *     --name some-test-name.com --contact ./contact.json [--years 1]
 *
 * Then run the worker (`bun run worker:services` with a TNP_SERVICES_* flag on)
 * and follow the operation. The `sandboxNoCharge` authorizer refuses any
 * account that is not `sandbox`, so this cannot buy a real domain.
 */

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { parseContact } from "@tnp/shared-types";
import { closePostgres, connectPostgres } from "../../db/postgres.js";
import { users } from "../../db/schema/index.js";
import { Catalog, readOnlyCall } from "../catalog.js";
import { placeOrder, sandboxNoCharge } from "../orders.js";
import { loadProviderAccount } from "../providers/accounts.js";
import { createProductionRegistry } from "../providers/production.js";

const { values } = parseArgs({
  options: {
    account: { type: "string" },
    owner: { type: "string" },
    name: { type: "string" },
    contact: { type: "string" },
    years: { type: "string", default: "1" },
  },
});

if (!values.account || !values.owner || !values.name || !values.contact) {
  console.error("--account, --owner, --name and --contact are required");
  process.exit(2);
}
const contact = parseContact(JSON.parse(readFileSync(values.contact, "utf8")));
if (!contact.ok) {
  console.error(contact.error);
  process.exit(2);
}

const db = await connectPostgres();
try {
  const account = await loadProviderAccount(db, values.account);
  if (account.environment !== "sandbox") throw new Error("this script only runs against sandbox accounts");

  const [owner] = await db
    .insert(users)
    .values({ oxyUserId: values.owner })
    .onConflictDoUpdate({ target: users.oxyUserId, set: { updatedAt: sql`now()` } })
    .returning({ id: users.id });

  const catalog = new Catalog(db, createProductionRegistry(db));
  const quote = await catalog.quoteRegistration(account, owner.id, values.name, Number(values.years), readOnlyCall(crypto.randomUUID()));
  const c = contact.value;
  const placed = await placeOrder(db, sandboxNoCharge, {
    ownerId: owner.id,
    quoteIds: [quote.id],
    idempotencyKey: `sandbox-order:${quote.id}`,
    contacts: { registrant: c, admin: c, tech: c, billing: c },
    privacy: false,
  });
  console.log(JSON.stringify({ quote: quote.id, order: placed.order.id, state: placed.order.state }));
} finally {
  await closePostgres();
}
