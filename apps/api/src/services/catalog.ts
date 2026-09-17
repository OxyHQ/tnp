/**
 * Public-domain catalog: availability and quotes.
 *
 * Search starts from what the selected provider account offers. A name whose
 * extension the account does not sell is `unsupported`, a provider that cannot
 * answer yields `unknown` — neither is ever reported as available.
 */

import type { Database } from "../db/postgres.js";
import { quotes } from "../db/schema/index.js";
import { addMoney, type Money } from "./money.js";
import { QUOTE_TTL_MS, type QuoteRow } from "./orders.js";
import { splitRegistrableName, type PublicDomainName } from "./publicNames.js";
import { assertAccountUsable, toAccountConfig, type ProviderAccountRow } from "./providers/accounts.js";
import type { AdapterCallContext, AvailabilityStatus, RegistrarAdapter, SuffixOffer } from "./providers/contracts.js";
import { isProviderError, ProviderError } from "./providers/errors.js";
import type { ProviderRegistry } from "./providers/registry.js";

export const MAX_NAMES_PER_SEARCH = 10;
const SUFFIX_CACHE_MS = 60 * 60_000;

/** A read-only call context: catalog calls never mutate, so nothing to persist. */
export function readOnlyCall(correlationId: string): AdapterCallContext {
  return {
    correlationId,
    beforeSubmit: async () => {
      throw new Error("a catalog call attempted a mutating provider request");
    },
  };
}

export interface AvailabilityAnswer {
  readonly input: string;
  readonly name: PublicDomainName | null;
  readonly status: AvailabilityStatus | "invalid";
  readonly premium: boolean;
  readonly detail?: string;
}

export class Catalog {
  readonly #cache = new Map<string, { at: number; offers: readonly SuffixOffer[] }>();

  constructor(
    private readonly db: Database,
    private readonly registry: ProviderRegistry,
    private readonly now: () => number = Date.now,
  ) {}

  registrarFor(account: ProviderAccountRow): RegistrarAdapter {
    assertAccountUsable(account, "sell");
    return this.registry.registrar(toAccountConfig(account));
  }

  async suffixes(account: ProviderAccountRow, call: AdapterCallContext): Promise<readonly SuffixOffer[]> {
    const cached = this.#cache.get(account.id);
    if (cached && this.now() - cached.at < SUFFIX_CACHE_MS) return cached.offers;
    const offers = await this.registrarFor(account).listSuffixes(call);
    this.#cache.set(account.id, { at: this.now(), offers });
    return offers;
  }

  async checkAvailability(
    account: ProviderAccountRow,
    inputs: readonly string[],
    call: AdapterCallContext,
  ): Promise<AvailabilityAnswer[]> {
    const offers = await this.suffixes(account, call);
    const registerable = new Set(offers.filter((o) => o.registerable).map((o) => o.suffix));
    const allSuffixes = new Set(offers.map((o) => o.suffix));

    const answers: AvailabilityAnswer[] = [];
    const toCheck: PublicDomainName[] = [];
    for (const input of inputs.slice(0, MAX_NAMES_PER_SEARCH)) {
      const split = splitRegistrableName(input, allSuffixes);
      if (!split.ok) {
        answers.push({
          input,
          name: null,
          status: split.reason === "suffix_not_offered" ? "unsupported" : "invalid",
          premium: false,
          detail: split.detail,
        });
        continue;
      }
      if (!registerable.has(split.name.suffix)) {
        answers.push({ input, name: split.name, status: "unsupported", premium: false });
        continue;
      }
      toCheck.push(split.name);
      answers.push({ input, name: split.name, status: "unknown", premium: false });
    }

    if (toCheck.length === 0) return answers;
    try {
      const results = await this.registrarFor(account).checkAvailability(call, toCheck);
      const byName = new Map(results.map((r) => [r.name.ascii, r]));
      return answers.map((a) => {
        const result = a.name ? byName.get(a.name.ascii) : undefined;
        return result ? { ...a, status: result.status, premium: result.premium } : a;
      });
    } catch (err) {
      // Partial results are still results: every checked name stays `unknown`.
      if (isProviderError(err) && (err.code === "rate_limited" || err.code === "provider_unavailable")) {
        return answers.map((a) => (a.status === "unknown" ? { ...a, detail: err.safeMessage } : a));
      }
      throw err;
    }
  }

  /**
   * Quote a registration. Price is cost plus the provider's itemized fees: no
   * retail margin policy is approved (services.md §8), and a quote never hides
   * a surcharge.
   */
  async quoteRegistration(
    account: ProviderAccountRow,
    ownerId: string,
    input: string,
    years: number,
    call: AdapterCallContext,
  ): Promise<QuoteRow> {
    const offers = await this.suffixes(account, call);
    const split = splitRegistrableName(input, new Set(offers.map((o) => o.suffix)));
    if (!split.ok) throw new ProviderError("validation", split.detail, { safeMessage: split.detail });
    const offer = offers.find((o) => o.suffix === split.name.suffix);
    if (!offer?.registerable) throw new ProviderError("unsupported", `.${split.name.suffix} is not registerable`);
    if (offer.requiresExtendedAttributes) {
      throw new ProviderError("unsupported", `.${offer.suffix} needs extended attributes`, {
        safeMessage: `.${offer.suffix} needs registration details TNP does not collect yet.`,
      });
    }
    if (years < offer.minYears || years > offer.maxYears) {
      throw new ProviderError("validation", `years out of range for .${offer.suffix}`, {
        safeMessage: `.${offer.suffix} can be registered for ${offer.minYears}–${offer.maxYears} years.`,
      });
    }

    const registrar = this.registrarFor(account);
    const [availability] = await registrar.checkAvailability(call, [split.name]);
    if (!availability || availability.status !== "available") {
      throw new ProviderError(availability?.status === "unknown" ? "provider_unavailable" : "not_available", `${split.name.ascii} is ${availability?.status ?? "unknown"}`);
    }

    let cost: Money;
    let fees: Money | null = null;
    let renewal: Money | null = null;
    if (availability.premium) {
      // Premium pricing is per name and per year; multi-year premium terms are
      // not quoted rather than extrapolated.
      if (years !== 1 || !availability.premiumRegistrationPrice) {
        throw new ProviderError("unsupported", "premium names are quoted for one year only", {
          safeMessage: "Premium names can only be quoted for one year.",
        });
      }
      cost = availability.premiumRegistrationPrice;
      renewal = availability.premiumRenewalPrice ?? null;
    } else {
      const prices = await registrar.getPrices(call, { operation: "register", suffix: split.name.suffix });
      const price = prices.find((p) => p.years === years);
      if (!price) throw new ProviderError("unsupported", `no ${years}-year price for .${split.name.suffix}`);
      cost = price.cost;
      fees = price.fees;
      const renewals = await registrar.getPrices(call, { operation: "renew", suffix: split.name.suffix });
      renewal = renewals.find((p) => p.years === 1)?.cost ?? null;
    }

    const total = fees ? addMoney(cost, fees) : cost;
    const [quote] = await this.db
      .insert(quotes)
      .values({
        ownerId,
        providerAccountId: account.id,
        operation: "register",
        asciiName: split.name.ascii,
        unicodeName: split.name.unicode,
        suffix: split.name.suffix,
        years,
        currency: cost.currency,
        costMinor: cost.minor,
        feesMinor: fees?.minor ?? 0n,
        priceMinor: total.minor,
        renewalPriceMinor: renewal?.minor ?? null,
        premium: availability.premium,
        expiresAt: new Date(this.now() + QUOTE_TTL_MS),
      })
      .returning();
    return quote;
  }
}
