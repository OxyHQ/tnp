#!/usr/bin/env bun
/**
 * Operator tool: create or update a provider account row.
 *
 *   bun src/services/scripts/provider-account.ts \
 *     --adapter namecheap --environment sandbox --label primary \
 *     --secret-ref env:NAMECHEAP_SANDBOX_API_KEY \
 *     --config '{"apiUser":"…","userName":"…","clientIp":"203.0.113.10"}' \
 *     [--sales enabled|sales_disabled] [--management active|read_only|disabled]
 *
 * It stores a secret REFERENCE only. Passing something that looks like a key
 * where the reference goes is refused by the table's CHECK constraint.
 * Production accounts additionally need `--confirm-production`.
 */

import { parseArgs } from "node:util";
import { sql } from "drizzle-orm";
import { closePostgres, connectPostgres } from "../../db/postgres.js";
import { providerAccounts } from "../../db/schema/index.js";
import { recordAudit } from "../audit.js";

const { values } = parseArgs({
  options: {
    adapter: { type: "string" },
    environment: { type: "string" },
    label: { type: "string" },
    "secret-ref": { type: "string" },
    config: { type: "string", default: "{}" },
    sales: { type: "string", default: "sales_disabled" },
    management: { type: "string", default: "read_only" },
    "confirm-production": { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const environment = values.environment;
if (environment !== "sandbox" && environment !== "production") fail("--environment must be sandbox or production");
if (environment === "production" && !values["confirm-production"]) fail("production accounts need --confirm-production");
if (!values.adapter || !values.label) fail("--adapter and --label are required");
const sales = values.sales;
if (sales !== "enabled" && sales !== "sales_disabled") fail("--sales must be enabled or sales_disabled");
const management = values.management;
if (management !== "active" && management !== "read_only" && management !== "disabled") fail("--management must be active, read_only or disabled");

let config: Record<string, unknown>;
try {
  const parsed: unknown = JSON.parse(values.config ?? "{}");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
  config = parsed as Record<string, unknown>;
} catch {
  fail("--config must be a JSON object");
}
if (Object.keys(config).some((k) => /key|secret|password|token/i.test(k))) {
  fail("--config holds non-secret settings only; pass secrets through --secret-ref");
}

const db = await connectPostgres();
try {
  const [row] = await db
    .insert(providerAccounts)
    .values({
      adapter: values.adapter,
      environment,
      label: values.label,
      secretRef: values["secret-ref"] ?? null,
      config,
      salesState: sales,
      managementMode: management,
    })
    .onConflictDoUpdate({
      target: [providerAccounts.adapter, providerAccounts.environment, providerAccounts.label],
      set: {
        secretRef: values["secret-ref"] ?? null,
        config,
        salesState: sales,
        managementMode: management,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: providerAccounts.id });
  await recordAudit(db, {
    actor: { kind: "system" },
    action: "provider_account.upsert",
    resourceType: "provider_account",
    resourceId: row.id,
    outcome: "applied",
    metadata: { tool: "provider-account.ts", adapter: values.adapter, environment, sales, management, hasSecretRef: Boolean(values["secret-ref"]) },
  });
  console.log(JSON.stringify({ id: row.id, adapter: values.adapter, environment, label: values.label, sales, management }));
} finally {
  await closePostgres();
}
