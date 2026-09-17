/**
 * Quotes and orders.
 *
 * A quote pins provider account, price and expiry. An order consumes quotes
 * and, in ONE transaction, writes the order, its lines, the pending resources
 * and the operations that will fulfil them — so there is never a paid order
 * with no operation, or an operation with no order.
 *
 * Payment is the seam that does not exist yet (services.md §8). The production
 * `PaymentAuthorizer` refuses, so no order can be placed until a mechanism is
 * approved and integrated. Tests and the sandbox operator script supply their
 * own authorizers; the sandbox one refuses any production account.
 */

import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/postgres.js";
import {
  dnsZones,
  domainContacts,
  orderLines,
  orders,
  providerAccounts,
  publicDomains,
  quotes,
} from "../db/schema/index.js";
import { recordAudit, type AuditActor } from "./audit.js";
import { addMoney, type Money } from "./money.js";
import { hashIntent, IdempotencyConflictError } from "./operations/intent.js";
import { OPERATION_KINDS } from "./operations/handlers.js";
import { enqueueOperation } from "./operations/store.js";
import type { Contact, ContactSet, ProviderEnvironment } from "./providers/contracts.js";

export type QuoteRow = typeof quotes.$inferSelect;
export type OrderRow = typeof orders.$inferSelect;

export interface PaymentAuthorization {
  /** The payment system's own reference. Never card or wallet data. */
  readonly reference: string;
  readonly state: "authorized" | "captured";
}

export interface PaymentRequest {
  readonly ownerId: string;
  readonly total: Money;
  /** Passed through so the payment system deduplicates a retried order too. */
  readonly idempotencyKey: string;
  readonly environment: ProviderEnvironment;
}

export interface PaymentAuthorizer {
  authorize(request: PaymentRequest): Promise<PaymentAuthorization>;
}

export class PaymentsNotConfiguredError extends Error {
  constructor() {
    super("no payment mechanism is approved and configured");
    this.name = "PaymentsNotConfiguredError";
  }
}

/** The only production authorizer until services.md §8 is decided. */
export const unconfiguredPayments: PaymentAuthorizer = {
  async authorize() {
    throw new PaymentsNotConfiguredError();
  },
};

/**
 * For the sandbox operator script: authorizes without charging anyone, and
 * only for sandbox. A production request is refused before anything is written.
 */
export const sandboxNoCharge: PaymentAuthorizer = {
  async authorize(request) {
    if (request.environment !== "sandbox") throw new PaymentsNotConfiguredError();
    return { reference: `sandbox-no-charge:${request.idempotencyKey}`, state: "captured" };
  },
};

export const QUOTE_TTL_MS = 15 * 60_000;

export class QuoteUnusableError extends Error {
  constructor(
    readonly quoteId: string,
    readonly reason: "missing" | "expired" | "consumed" | "mixed_currency" | "mixed_environment" | "not_orderable" | "already_in_inventory",
  ) {
    super(`quote ${quoteId} cannot be ordered: ${reason}`);
    this.name = "QuoteUnusableError";
  }
}

export interface PlaceOrderInput {
  readonly ownerId: string;
  readonly quoteIds: readonly string[];
  readonly idempotencyKey: string;
  /** Contacts for every registration line. Stored per domain, never in the operation payload. */
  readonly contacts: ContactSet;
  readonly privacy: boolean;
  readonly actor: AuditActor;
}

export interface PlacedOrder {
  readonly order: OrderRow;
  readonly created: boolean;
}

/**
 * Place an order.
 *
 * Order of effects: quotes are validated, then payment is authorized with the
 * order's idempotency key, then everything is written in one transaction that
 * re-checks the quotes under `FOR UPDATE`. If that transaction loses a race
 * after authorization, the authorization is orphaned — the payment system
 * deduplicates by the same key, and reconciliation of orphaned authorizations
 * is part of the payment integration gate, not something to paper over here.
 */
export async function placeOrder(
  db: Database,
  payments: PaymentAuthorizer,
  input: PlaceOrderInput,
): Promise<PlacedOrder> {
  const quoteIds = [...new Set(input.quoteIds)].sort();
  const intentHash = hashIntent({ quoteIds, privacy: input.privacy });

  const existing = await findOrderByKey(db, input.ownerId, input.idempotencyKey);
  if (existing) {
    if (existing.intentHash !== intentHash) throw new IdempotencyConflictError(input.idempotencyKey);
    return { order: existing, created: false };
  }

  const { total, environment } = await priceQuotes(db, input.ownerId, quoteIds, false);
  const authorization = await payments.authorize({
    ownerId: input.ownerId,
    total,
    idempotencyKey: input.idempotencyKey,
    environment,
  });

  return db.transaction(async (tx) => {
    const [order] = await tx
      .insert(orders)
      .values({
        ownerId: input.ownerId,
        state: "fulfilling",
        paymentState: authorization.state,
        paymentReference: authorization.reference,
        currency: total.currency,
        totalMinor: total.minor,
        idempotencyKey: input.idempotencyKey,
        intentHash,
      })
      .onConflictDoNothing({ target: [orders.ownerId, orders.idempotencyKey] })
      .returning();
    if (!order) {
      const winner = await findOrderByKey(tx, input.ownerId, input.idempotencyKey);
      if (!winner || winner.intentHash !== intentHash) throw new IdempotencyConflictError(input.idempotencyKey);
      return { order: winner, created: false };
    }

    // Re-read under lock: a quote consumed by a concurrent order between the
    // check above and here must not be sold twice.
    const locked = await tx
      .select({ quote: quotes, environment: providerAccounts.environment })
      .from(quotes)
      .innerJoin(providerAccounts, eq(providerAccounts.id, quotes.providerAccountId))
      .where(and(inArray(quotes.id, quoteIds), eq(quotes.ownerId, input.ownerId)))
      .for("update", { of: quotes });
    const byId = new Map(locked.map((r) => [r.quote.id, r]));

    for (const quoteId of quoteIds) {
      const row = byId.get(quoteId);
      if (!row) throw new QuoteUnusableError(quoteId, "missing");
      const { quote } = row;
      if (quote.consumedAt) throw new QuoteUnusableError(quoteId, "consumed");

      await tx.update(quotes).set({ consumedAt: sql`now()` }).where(eq(quotes.id, quote.id));

      if (quote.operation !== "register") throw new QuoteUnusableError(quote.id, "not_orderable");

      const [domain] = await tx
        .insert(publicDomains)
        .values({
          ownerId: input.ownerId,
          asciiName: quote.asciiName,
          unicodeName: quote.unicodeName,
          suffix: quote.suffix,
          providerAccountId: quote.providerAccountId,
          lifecycle: "pending",
          privacy: input.privacy,
        })
        .returning();
      await tx.insert(domainContacts).values(
        (["registrant", "admin", "tech", "billing"] as const).map((role) => ({
          publicDomainId: domain.id,
          role,
          data: contactRecord(input.contacts[role]),
        })),
      );
      await tx.insert(dnsZones).values({
        publicDomainId: domain.id,
        authority: "provider",
        providerAccountId: quote.providerAccountId,
        state: "unknown",
      });

      const [line] = await tx
        .insert(orderLines)
        .values({
          orderId: order.id,
          quoteId: quote.id,
          priceMinor: quote.priceMinor,
          currency: quote.currency,
          publicDomainId: domain.id,
        })
        .returning();

      const { operation } = await enqueueOperation(tx, {
        kind: OPERATION_KINDS.register,
        scope: `user:${input.ownerId}`,
        idempotencyKey: `order:${order.id}:line:${line.id}`,
        ownerId: input.ownerId,
        resourceType: "public_domain",
        resourceId: domain.id,
        providerAccountId: quote.providerAccountId,
        payload: {
          publicDomainId: domain.id,
          years: quote.years,
          privacy: input.privacy,
          environment: row.environment,
          // The provider may not charge more than the quote's cost.
          maxCostMinor: (quote.costMinor + quote.feesMinor).toString(),
          currency: quote.currency,
        },
      });
      await tx.update(orderLines).set({ operationId: operation.id }).where(eq(orderLines.id, line.id));
    }

    await recordAudit(tx, {
      actor: input.actor,
      action: "order.place",
      resourceType: "order",
      resourceId: order.id,
      outcome: "accepted",
      metadata: { lines: quoteIds.length, currency: total.currency, totalMinor: total.minor.toString(), paymentState: authorization.state },
    });
    return { order, created: true };
  });
}

async function findOrderByKey(db: Database | Parameters<Parameters<Database["transaction"]>[0]>[0], ownerId: string, key: string) {
  const [row] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.ownerId, ownerId), eq(orders.idempotencyKey, key)))
    .limit(1);
  return row ?? null;
}

/** Validate quotes and total them. Unlocked: the transaction re-checks. */
export async function priceQuotes(
  db: Database,
  ownerId: string,
  quoteIds: readonly string[],
  allowConsumed: boolean,
): Promise<{ total: Money; environment: ProviderEnvironment }> {
  if (quoteIds.length === 0) throw new QuoteUnusableError("", "missing");
  const rows = await db
    .select({ quote: quotes, environment: providerAccounts.environment })
    .from(quotes)
    .innerJoin(providerAccounts, eq(providerAccounts.id, quotes.providerAccountId))
    .where(and(inArray(quotes.id, [...quoteIds]), eq(quotes.ownerId, ownerId), gt(quotes.expiresAt, sql`now()`), allowConsumed ? sql`true` : isNull(quotes.consumedAt)));

  let total: Money | null = null;
  let environment: ProviderEnvironment | null = null;
  for (const id of quoteIds) {
    const row = rows.find((r) => r.quote.id === id);
    if (!row) throw new QuoteUnusableError(id, "expired");
    if (row.quote.operation !== "register") throw new QuoteUnusableError(id, "not_orderable");
    const [held] = await db
      .select({ id: publicDomains.id })
      .from(publicDomains)
      .where(
        and(
          eq(publicDomains.providerAccountId, row.quote.providerAccountId),
          eq(publicDomains.asciiName, row.quote.asciiName),
          sql`${publicDomains.lifecycle} not in ('failed', 'transferred_out')`,
        ),
      )
      .limit(1);
    if (held) throw new QuoteUnusableError(id, "already_in_inventory");
    const price: Money = { currency: row.quote.currency, minor: row.quote.priceMinor };
    if (total && total.currency !== price.currency) throw new QuoteUnusableError(id, "mixed_currency");
    if (environment && environment !== row.environment) throw new QuoteUnusableError(id, "mixed_environment");
    total = total ? addMoney(total, price) : price;
    environment = row.environment;
  }
  if (!total || !environment) throw new QuoteUnusableError("", "missing");
  return { total, environment };
}

function contactRecord(contact: Contact): Record<string, string> {
  return Object.fromEntries(
    Object.entries(contact).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
