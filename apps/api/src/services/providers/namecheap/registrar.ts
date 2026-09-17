/**
 * Namecheap `RegistrarAdapter`.
 *
 * Every response field used below is from the method pages under
 * https://www.namecheap.com/support/api/methods/ (read 2026-09-17). Where a page
 * is silent or ambiguous, the choice made is the one that can refuse a sale,
 * never the one that can overcharge or double-charge, and it is written next
 * to the code.
 */

import type {
  AdapterCallContext,
  AvailabilityResult,
  Contact,
  ContactSet,
  PriceOffer,
  PricedOperation,
  ProviderAccountRef,
  PublicDomainLifecycle,
  RegisterDomainRequest,
  RegisterDomainResult,
  RegistrarAdapter,
  RemoteDomainInfo,
  RemoteDomainPage,
  RemoteDomainSummary,
  RenewDomainRequest,
  RenewDomainResult,
  SuffixOffer,
  TransferInRequest,
  TransferState,
  TransferStatus,
} from "../contracts.js";
import { ProviderError } from "../errors.js";
import type { Money } from "../../money.js";
import { parseDecimalAmount } from "../../money.js";
import type { PublicDomainName } from "../../publicNames.js";
import { NAMECHEAP_REGISTRAR_CAPABILITIES } from "./capabilities.js";
import type { CommandResult, NamecheapClient, NamecheapCommand } from "./client.js";
import {
  XmlRejected,
  attr,
  child,
  childText,
  children,
  optionalBool,
  optionalDate,
  parseIntStrict,
  requireAttr,
  requireBool,
  requireChild,
  requireInt,
  text,
  type XmlNode,
} from "./xml.js";

/** `domains.check` accepts at most 50 names per call (error 2011169). */
const CHECK_BATCH = 50;

/**
 * Extensions whose create/setContacts pages require extended attributes. The
 * contract has no field to carry them, so these are refused before a request
 * rather than sent incomplete (https://www.namecheap.com/support/api/extended-attributes/).
 */
export const EXTENDED_ATTRIBUTE_SUFFIXES: ReadonlySet<string> = new Set([
  "us", "eu", "ca", "co.uk", "org.uk", "me.uk", "nu", "asia",
  "com.au", "net.au", "org.au", "es", "nom.es", "com.es", "org.es", "de", "fr",
]);

/**
 * Extensions `domains.transfer.create` accepts "at this time"
 * (https://www.namecheap.com/support/api/methods/domains-transfer/create/).
 */
export const TRANSFER_SUFFIXES: ReadonlySet<string> = new Set([
  "biz", "ca", "cc", "co", "com", "com.es", "com.pe", "es", "in", "info", "me",
  "mobi", "net", "net.pe", "nom.es", "org", "org.es", "org.pe", "pe", "tv", "us",
]);

/**
 * `domains.getInfo` `Status`: documented values are OK, Locked and Expired. The
 * example prints `Ok`, so matching is case-insensitive. "Locked" on getInfo is
 * an administrative lock on the domain (the registrar-transfer lock has its own
 * method), the nearest normalized state is `locked_by_registry`. Anything else
 * is `unknown` with the raw status kept.
 */
export const LIFECYCLE_BY_STATUS: Readonly<Record<string, PublicDomainLifecycle>> = {
  ok: "active",
  active: "active",
  locked: "locked_by_registry",
  expired: "expired",
};

export function lifecycleFromStatus(raw: string): PublicDomainLifecycle {
  return LIFECYCLE_BY_STATUS[raw.trim().toLowerCase()] ?? "unknown";
}

/**
 * Transfer `StatusID` → state, from https://www.namecheap.com/support/api/transfer-statuses/.
 * `-22` is documented twice with opposite meanings ("Canceled - Invalid entry"
 * and "Waiting for EPP Transfer Code"), and 6/7 are charge problems that may
 * still resolve; those stay `unknown` rather than being guessed.
 */
export const TRANSFER_STATE_BY_ID: Readonly<Record<string, TransferState>> = {
  "5": "completed",
  "27": "cancelled",
  "45": "cancelled",
  "0": "pending", "1": "pending", "3": "pending", "9": "pending", "10": "pending",
  "11": "pending", "12": "pending", "13": "pending", "14": "pending", "28": "pending",
  "29": "pending", "35": "pending", "-1": "pending", "-2": "pending", "-5": "pending",
  "2": "failed", "4": "failed", "8": "failed", "15": "failed", "16": "failed",
  "17": "failed", "18": "failed", "19": "failed", "20": "failed", "21": "failed",
  "22": "failed", "23": "failed", "24": "failed", "25": "failed", "26": "failed",
  "30": "failed", "31": "failed", "32": "failed", "33": "failed", "34": "failed",
  "36": "failed", "37": "failed", "48": "failed", "49": "failed", "50": "failed",
  "51": "failed", "-4": "failed",
};

const ACTION_NAME: Readonly<Record<PricedOperation, string>> = {
  register: "REGISTER",
  renew: "RENEW",
  transfer_in: "TRANSFER",
};

const PHONE_RE = /^\+\d{1,3}\.\d{1,14}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

export class NamecheapRegistrar implements RegistrarAdapter {
  readonly adapter = "namecheap";
  readonly capabilities = NAMECHEAP_REGISTRAR_CAPABILITIES;

  constructor(
    readonly account: ProviderAccountRef,
    private readonly client: NamecheapClient,
  ) {}

  async listSuffixes(ctx: AdapterCallContext): Promise<readonly SuffixOffer[]> {
    const command = "namecheap.domains.getTldList";
    const result = await this.client.call(ctx, command, {});
    return this.#read(command, result, (response) => {
      return children(requireChild(response, "Tlds"), "Tld").map((tld): SuffixOffer => {
        const suffix = requireAttr(tld, "Name").toLowerCase();
        return {
          suffix,
          registerable: requireBool(tld, "IsApiRegisterable"),
          renewable: requireBool(tld, "IsApiRenewable"),
          transferable: requireBool(tld, "IsApiTransferable") && TRANSFER_SUFFIXES.has(suffix),
          minYears: requireInt(tld, "MinRegisterYears"),
          maxYears: requireInt(tld, "MaxRegisterYears"),
          idn: optionalBool(tld, "IsSupportsIDN") ?? false,
          requiresExtendedAttributes: EXTENDED_ATTRIBUTE_SUFFIXES.has(suffix),
        };
      });
    });
  }

  async checkAvailability(
    ctx: AdapterCallContext,
    names: readonly PublicDomainName[],
  ): Promise<readonly AvailabilityResult[]> {
    const command = "namecheap.domains.check";
    const found = new Map<string, AvailabilityResult>();
    for (let i = 0; i < names.length; i += CHECK_BATCH) {
      const batch = names.slice(i, i + CHECK_BATCH);
      const result = await this.client.call(ctx, command, { DomainList: batch.map((n) => n.ascii).join(",") });
      this.#read(command, result, (response) => {
        for (const row of children(response, "DomainCheckResult")) {
          const ascii = requireAttr(row, "Domain").toLowerCase();
          const name = batch.find((n) => n.ascii === ascii);
          if (!name) continue;
          const errorNo = attr(row, "ErrorNo");
          const premium = optionalBool(row, "IsPremiumName") ?? false;
          const status =
            errorNo !== undefined && errorNo !== "0"
              ? "unknown"
              : requireBool(row, "Available")
                ? "available"
                : "unavailable";
          // `domains.check` states premium prices without a currency. They are
          // not converted to Money on a guessed currency; `premium: true` is
          // reported and premium registration is refused (see `register`).
          found.set(ascii, { name, status, premium });
        }
      });
    }
    // A name the provider did not answer for is `unknown`, never `unavailable`.
    return names.map((name) => found.get(name.ascii) ?? { name, status: "unknown", premium: false });
  }

  async getPrices(
    ctx: AdapterCallContext,
    query: { readonly operation: PricedOperation; readonly suffix: string },
  ): Promise<readonly PriceOffer[]> {
    const command = "namecheap.users.getPricing";
    const suffix = query.suffix.toLowerCase();
    const result = await this.client.call(ctx, command, {
      ProductType: "DOMAIN",
      ProductCategory: "DOMAINS",
      ActionName: ACTION_NAME[query.operation],
      ProductName: suffix.toUpperCase(),
    });
    return this.#read(command, result, (response) => {
      const offers: PriceOffer[] = [];
      const root = requireChild(response, "UserGetPricingResult");
      for (const productType of children(root, "ProductType")) {
        for (const category of children(productType, "ProductCategory")) {
          if (requireAttr(category, "Name").toUpperCase() !== ACTION_NAME[query.operation]) continue;
          for (const product of children(category, "Product")) {
            if (requireAttr(product, "Name").toLowerCase() !== suffix) continue;
            for (const price of children(product, "Price")) {
              const offer = priceOffer(price, query.operation, suffix);
              if (offer) offers.push(offer);
            }
          }
        }
      }
      return offers;
    });
  }

  async register(ctx: AdapterCallContext, request: RegisterDomainRequest): Promise<RegisterDomainResult> {
    const { name } = request;
    assertYears(request.years, 1, 10);
    assertNotIdn(name);
    assertNoExtendedAttributes(name.suffix);
    const sensitive = contactValues(request.contacts);
    validateContacts(request.contacts);

    // Pricing is always read first: it is the only response that states the
    // account's currency, it enforces `maxCost`, and it proves the extension
    // and term are offered. There is no max-price parameter on
    // `domains.create` for a regular name, so a price change between this
    // read and the create is not prevented — only narrowed. The quote/order
    // layer owns that race.
    const offer = await this.#offerFor(ctx, "register", name.suffix, request.years, request.maxCost);

    const [availability] = await this.checkAvailability(ctx, [name]);
    if (availability.premium) {
      throw new ProviderError("unsupported", `namecheap: premium registration of ${name.ascii} is not automated`, {
        safeMessage: "Premium names cannot be registered automatically.",
      });
    }
    if (availability.status === "unavailable") {
      throw new ProviderError("not_available", `namecheap: ${name.ascii} is not available`);
    }
    if (availability.status !== "available") {
      throw new ProviderError("provider_unavailable", `namecheap: availability of ${name.ascii} is unknown`);
    }

    const command = "namecheap.domains.create";
    const params: Record<string, string> = {
      DomainName: name.ascii,
      Years: String(request.years),
      AddFreeWhoisguard: request.privacy ? "yes" : "no",
      WGEnabled: request.privacy ? "yes" : "no",
      ...contactParams(request.contacts),
    };
    if (request.nameservers.length > 0) params.Nameservers = request.nameservers.join(",");

    const result = await this.client.call(ctx, command, params, { sensitive });
    return this.#read(command, result, (response) => {
      const row = requireChild(response, "DomainCreateResult");
      // `Registered="false"` under Status="OK" is not documented as a refusal,
      // and `NonRealTimeDomain="true"` means the registry has not confirmed.
      // Neither proves nothing was charged, so both are reconciled.
      if (!requireBool(row, "Registered") || optionalBool(row, "NonRealTimeDomain") === true) {
        throw this.client.shapeError(command, "registration not confirmed", sensitive);
      }
      return {
        remoteId: attr(row, "DomainID") ?? null,
        remoteOrderId: attr(row, "OrderID") ?? null,
        charged: optionalMoney(attr(row, "ChargedAmount"), offer.cost.currency),
      };
    }, sensitive);
  }

  async renew(ctx: AdapterCallContext, request: RenewDomainRequest): Promise<RenewDomainResult> {
    const { name } = request;
    assertYears(request.years, 1, 10);
    const offer = await this.#offerFor(ctx, "renew", name.suffix, request.years, request.maxCost);

    const command = "namecheap.domains.renew";
    const result = await this.client.call(ctx, command, { DomainName: name.ascii, Years: String(request.years) });
    return this.#read(command, result, (response) => {
      const row = requireChild(response, "DomainRenewResult");
      if (!requireBool(row, "Renew")) throw this.client.shapeError(command, "renewal not confirmed");
      const details = child(row, "DomainDetails");
      return {
        expiresAt: details ? optionalDate(childText(details, "ExpiredDate"), "ExpiredDate") : null,
        charged: optionalMoney(attr(row, "ChargedAmount"), offer.cost.currency),
        remoteOrderId: attr(row, "OrderID") ?? null,
      };
    });
  }

  async getInfo(ctx: AdapterCallContext, name: PublicDomainName): Promise<RemoteDomainInfo> {
    const command = "namecheap.domains.getInfo";
    const result = await this.client.call(ctx, command, { DomainName: name.ascii });
    return this.#read(command, result, (response) => {
      const row = requireChild(response, "DomainGetInfoResult");
      // Another user's domain shared with this account is not a domain this
      // account holds; treating it as held would let TNP sell operations on it.
      if (optionalBool(row, "IsOwner") === false) {
        throw new ProviderError("not_found", `namecheap: ${name.ascii} is not owned by this account`, {
          submitted: true,
        });
      }
      const rawStatus = requireAttr(row, "Status");
      const details = child(row, "DomainDetails");
      const whoisguard = child(row, "Whoisguard");
      const dns = child(row, "DnsDetails");
      return {
        ascii: (attr(row, "DomainName") ?? name.ascii).toLowerCase(),
        remoteId: attr(row, "ID") ?? null,
        rawStatus,
        lifecycle: lifecycleFromStatus(rawStatus),
        createdAt: details ? optionalDate(childText(details, "CreatedDate"), "CreatedDate") : null,
        expiresAt: details ? optionalDate(childText(details, "ExpiredDate"), "ExpiredDate") : null,
        // getInfo's `LockDetails` is empty in the documented example and the
        // page does not describe it; `getLock` is the authoritative read.
        locked: null,
        privacy: whoisguard ? optionalBool(whoisguard, "Enabled") : null,
        autoRenew: null,
        // `IsUsingOurDNS` is not in the documented example (only `ProviderType`),
        // so its absence is "unknown", not "no".
        usesProviderDns: dns ? optionalBool(dns, "IsUsingOurDNS") : null,
        nameservers: dns ? children(dns, "Nameserver").map((ns) => text(ns)?.toLowerCase() ?? "").filter(Boolean) : [],
      };
    });
  }

  async listDomains(
    ctx: AdapterCallContext,
    page: { readonly page: number; readonly pageSize: number },
  ): Promise<RemoteDomainPage> {
    if (!Number.isInteger(page.page) || page.page < 1) {
      throw new ProviderError("validation", "namecheap: page must be a positive integer");
    }
    // Documented bounds; clamping silently would make a caller's paging skip rows.
    if (!Number.isInteger(page.pageSize) || page.pageSize < 10 || page.pageSize > 100) {
      throw new ProviderError("validation", "namecheap: pageSize must be between 10 and 100");
    }
    const command = "namecheap.domains.getList";
    const result = await this.client.call(ctx, command, {
      ListType: "ALL",
      Page: String(page.page),
      PageSize: String(page.pageSize),
      SortBy: "NAME",
    });
    return this.#read(command, result, (response) => {
      const list = requireChild(response, "DomainGetListResult");
      const paging = requireChild(response, "Paging");
      const items = children(list, "Domain").map((row): RemoteDomainSummary => ({
        ascii: requireAttr(row, "Name").toLowerCase(),
        remoteId: attr(row, "ID") ?? null,
        expiresAt: optionalDate(attr(row, "Expires"), "Expires"),
        expired: requireBool(row, "IsExpired"),
        locked: optionalBool(row, "IsLocked"),
        autoRenew: optionalBool(row, "AutoRenew"),
      }));
      return {
        items,
        page: parseIntStrict(requiredText(paging, "CurrentPage"), "CurrentPage"),
        pageSize: parseIntStrict(requiredText(paging, "PageSize"), "PageSize"),
        total: parseIntStrict(requiredText(paging, "TotalItems"), "TotalItems"),
      };
    });
  }

  async getContacts(ctx: AdapterCallContext, name: PublicDomainName): Promise<ContactSet> {
    const command = "namecheap.domains.getContacts";
    const result = await this.client.call(ctx, command, { DomainName: name.ascii });
    return this.#read(command, result, (response) => {
      const row = requireChild(response, "DomainContactsResult");
      return {
        registrant: readContact(requireChild(row, "Registrant")),
        admin: readContact(requireChild(row, "Admin")),
        tech: readContact(requireChild(row, "Tech")),
        billing: readContact(requireChild(row, "AuxBilling")),
      };
    });
  }

  async setContacts(ctx: AdapterCallContext, name: PublicDomainName, contacts: ContactSet): Promise<void> {
    assertNoExtendedAttributes(name.suffix);
    validateContacts(contacts);
    const sensitive = contactValues(contacts);
    const command = "namecheap.domains.setContacts";
    const result = await this.client.call(
      ctx,
      command,
      { DomainName: name.ascii, ...contactParams(contacts) },
      { sensitive },
    );
    this.#read(command, result, (response) => {
      const row = requireChild(response, "DomainSetContactResult");
      if (!requireBool(row, "IsSuccess")) throw this.client.shapeError(command, "IsSuccess is false", sensitive);
    }, sensitive);
  }

  async getLock(ctx: AdapterCallContext, name: PublicDomainName): Promise<boolean> {
    const command = "namecheap.domains.getRegistrarLock";
    const result = await this.client.call(ctx, command, { DomainName: name.ascii });
    return this.#read(command, result, (response) =>
      requireBool(requireChild(response, "DomainGetRegistrarLockResult"), "RegistrarLockStatus"),
    );
  }

  async setLock(ctx: AdapterCallContext, name: PublicDomainName, locked: boolean): Promise<void> {
    const command = "namecheap.domains.setRegistrarLock";
    const result = await this.client.call(ctx, command, {
      DomainName: name.ascii,
      LockAction: locked ? "LOCK" : "UNLOCK",
    });
    this.#read(command, result, (response) => {
      const row = requireChild(response, "DomainSetRegistrarLockResult");
      if (!requireBool(row, "IsSuccess")) throw this.client.shapeError(command, "IsSuccess is false");
    });
  }

  async transferIn(ctx: AdapterCallContext, request: TransferInRequest): Promise<TransferStatus> {
    const { name } = request;
    const sensitive = [request.authCode, toBase64(request.authCode)];
    if (!TRANSFER_SUFFIXES.has(name.suffix)) {
      throw new ProviderError("unsupported", `namecheap: .${name.suffix} transfers are not accepted through the API`);
    }
    // "Though it is possible to configure a transfer price up to 10 years, the
    // duration should be set to 1 year only."
    if (request.years !== 1) {
      throw new ProviderError("validation", "namecheap: transfers are for exactly 1 year", {
        safeMessage: "Transfers include exactly one year.",
      });
    }
    if (request.authCode.length === 0 || /[\r\n]/.test(request.authCode)) {
      throw new ProviderError("validation", "namecheap: authorization code is empty or malformed");
    }
    await this.#offerFor(ctx, "transfer_in", name.suffix, 1, request.maxCost);

    const command = "namecheap.domains.transfer.create";
    // "EPPcode with special characters must be converted into base64 format and
    // sent in the format EPPcode=base64:converted code."
    const eppCode = /^[A-Za-z0-9]+$/.test(request.authCode) ? request.authCode : `base64:${toBase64(request.authCode)}`;
    const result = await this.client.call(
      ctx,
      command,
      { DomainName: name.ascii, Years: "1", EPPCode: eppCode },
      { sensitive },
    );
    return this.#read(command, result, (response) => {
      const row = requireChild(response, "DomainTransferCreateResult");
      if (!requireBool(row, "Transfer")) throw this.client.shapeError(command, "transfer order not confirmed", sensitive);
      const statusId = requireAttr(row, "StatusID");
      return {
        remoteTransferId: requireAttr(row, "TransferID"),
        state: TRANSFER_STATE_BY_ID[statusId] ?? "unknown",
        rawStatus: `StatusID ${statusId}`,
      };
    }, sensitive);
  }

  async getTransferStatus(ctx: AdapterCallContext, remoteTransferId: string): Promise<TransferStatus> {
    if (!/^\d{1,10}$/.test(remoteTransferId)) {
      throw new ProviderError("validation", "namecheap: transfer id must be numeric");
    }
    const command = "namecheap.domains.transfer.getStatus";
    const result = await this.client.call(ctx, command, { TransferID: remoteTransferId });
    return this.#read(command, result, (response) => {
      const row = requireChild(response, "DomainTransferGetStatusResult");
      const statusId = requireAttr(row, "StatusID");
      const status = attr(row, "Status") ?? "";
      return {
        remoteTransferId: attr(row, "TransferID") ?? remoteTransferId,
        state: TRANSFER_STATE_BY_ID[statusId] ?? "unknown",
        rawStatus: status ? `StatusID ${statusId}: ${status}` : `StatusID ${statusId}`,
      };
    });
  }

  async getBalance(ctx: AdapterCallContext): Promise<Money> {
    const command = "namecheap.users.getBalances";
    const result = await this.client.call(ctx, command, {});
    return this.#read(command, result, (response) => {
      const row = requireChild(response, "UserGetBalancesResult");
      return money(requireAttr(row, "AvailableBalance"), requireAttr(row, "Currency"));
    });
  }

  async #offerFor(
    ctx: AdapterCallContext,
    operation: PricedOperation,
    suffix: string,
    years: number,
    maxCost: Money | null,
  ): Promise<PriceOffer> {
    const offer = (await this.getPrices(ctx, { operation, suffix })).find((o) => o.years === years);
    if (!offer) {
      throw new ProviderError("unsupported", `namecheap: no ${operation} price for .${suffix} over ${years} year(s)`);
    }
    if (maxCost !== null) {
      const total = offer.fees ? offer.cost.minor + offer.fees.minor : offer.cost.minor;
      if (maxCost.currency !== offer.cost.currency || total > maxCost.minor) {
        throw new ProviderError("conflict", `namecheap: ${operation} of .${suffix} costs more than maxCost`, {
          safeMessage: "The price changed. Review the new price before trying again.",
        });
      }
    }
    return offer;
  }

  /**
   * Interpret a successful response. A shape this code does not understand is
   * a provider failure for a read and an unknown outcome for a write — never a
   * TypeError, and never a guessed default.
   */
  #read<T>(command: NamecheapCommand, result: CommandResult, parse: (response: XmlNode) => T, sensitive: readonly string[] = []): T {
    try {
      return parse(result.response);
    } catch (err) {
      if (err instanceof XmlRejected) throw this.client.shapeError(command, err.message, sensitive);
      if (err instanceof RangeError) throw this.client.shapeError(command, err.message, sensitive);
      throw err;
    }
  }
}

function priceOffer(price: XmlNode, operation: PricedOperation, suffix: string): PriceOffer | null {
  if (requireAttr(price, "DurationType").toUpperCase() !== "YEAR") return null;
  const years = requireInt(price, "Duration");
  const currency = requireAttr(price, "Currency").toUpperCase();
  // The page defines `Price` as the final price and `YourPrice` as the user's
  // price without saying which is charged. The larger is used so `maxCost` can
  // only refuse too much, never allow an overcharge.
  const perYear = maxMoney(
    money(requireAttr(price, "Price"), currency),
    optionalMoney(attr(price, "YourPrice"), currency),
  );
  // Prices are per year: the documented example quotes .biz at 8.55 for one
  // year and 8.87 for two, which cannot be a two-year total.
  const cost: Money = { currency, minor: perYear.minor * BigInt(years) };
  // `AdditionalCost`/`YourAdditonalCost` (sic) are not on the documented
  // example; when present they are the itemized ICANN-style fee, taken the same
  // conservative way.
  const feePerYear = [attr(price, "AdditionalCost"), attr(price, "YourAdditonalCost")]
    .map((value) => optionalMoney(value, currency))
    .reduce<Money | null>((acc, value) => (value === null ? acc : maxMoney(value, acc)), null);
  const fees = feePerYear && feePerYear.minor > 0n ? { currency, minor: feePerYear.minor * BigInt(years) } : null;
  return { suffix, operation, years, cost, fees };
}

function money(value: string, currency: string): Money {
  return parseDecimalAmount(value, currency.toUpperCase());
}

function optionalMoney(value: string | undefined, currency: string): Money | null {
  if (value === undefined || value.trim() === "") return null;
  return money(value, currency);
}

function maxMoney(a: Money, b: Money | null): Money {
  if (b === null) return a;
  return b.minor > a.minor ? b : a;
}

function requiredText(node: XmlNode, name: string): string {
  const value = childText(node, name);
  if (value === undefined) throw new XmlRejected("shape", `missing ${name}`);
  return value;
}

function assertYears(years: number, min: number, max: number): void {
  if (!Number.isInteger(years) || years < min || years > max) {
    throw new ProviderError("validation", `namecheap: years must be an integer from ${min} to ${max}`);
  }
}

/**
 * IDN registration requires an `IdnCode` language tag the contract does not
 * carry (https://www.namecheap.com/support/api/methods/domains/create/).
 */
function assertNotIdn(name: PublicDomainName): void {
  if (name.ascii.split(".").some((label) => label.startsWith("xn--"))) {
    throw new ProviderError("unsupported", `namecheap: IDN registration of ${name.ascii} needs an IdnCode`, {
      safeMessage: "Internationalized names cannot be registered automatically yet.",
    });
  }
}

function assertNoExtendedAttributes(suffix: string): void {
  if (EXTENDED_ATTRIBUTE_SUFFIXES.has(suffix)) {
    throw new ProviderError("unsupported", `namecheap: .${suffix} requires extended attributes`, {
      safeMessage: "This extension needs registrant details that cannot be collected yet.",
    });
  }
}

const CONTACT_ROLES: ReadonlyArray<readonly [keyof ContactSet, string]> = [
  ["registrant", "Registrant"],
  ["tech", "Tech"],
  ["admin", "Admin"],
  ["billing", "AuxBilling"],
];

function validateContacts(contacts: ContactSet): void {
  for (const [role] of CONTACT_ROLES) {
    const c = contacts[role];
    const required = [c.firstName, c.lastName, c.address1, c.city, c.stateProvince, c.postalCode, c.email];
    if (required.some((v) => v.trim() === "") || !COUNTRY_RE.test(c.country) || !PHONE_RE.test(c.phone)) {
      // The role is named; the values are not.
      throw new ProviderError("validation", `namecheap: ${role} contact is incomplete or malformed`, {
        safeMessage: "Contact details are incomplete. Check the phone format (+NNN.NNNNNNNNNN) and country.",
      });
    }
  }
}

function contactParams(contacts: ContactSet): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [role, prefix] of CONTACT_ROLES) {
    const c = contacts[role];
    out[`${prefix}FirstName`] = c.firstName;
    out[`${prefix}LastName`] = c.lastName;
    out[`${prefix}Address1`] = c.address1;
    out[`${prefix}City`] = c.city;
    out[`${prefix}StateProvince`] = c.stateProvince;
    out[`${prefix}PostalCode`] = c.postalCode;
    out[`${prefix}Country`] = c.country;
    out[`${prefix}Phone`] = c.phone;
    out[`${prefix}EmailAddress`] = c.email;
    if (c.organization) out[`${prefix}OrganizationName`] = c.organization;
    if (c.jobTitle) out[`${prefix}JobTitle`] = c.jobTitle;
    if (c.address2) out[`${prefix}Address2`] = c.address2;
  }
  return out;
}

/** Every contact value, so a provider message echoing one is redacted. */
function contactValues(contacts: ContactSet): string[] {
  return CONTACT_ROLES.flatMap(([role]) => Object.values(contacts[role]).filter((v): v is string => typeof v === "string"));
}

function readContact(node: XmlNode): Contact {
  const required = (field: string): string => {
    const value = childText(node, field);
    if (value === undefined) throw new XmlRejected("shape", `contact is missing ${field}`);
    return value;
  };
  const optional = (field: string): string | undefined => childText(node, field);
  return {
    firstName: required("FirstName"),
    lastName: required("LastName"),
    organization: optional("OrganizationName"),
    jobTitle: optional("JobTitle"),
    address1: required("Address1"),
    address2: optional("Address2"),
    city: required("City"),
    stateProvince: required("StateProvince"),
    postalCode: required("PostalCode"),
    country: required("Country"),
    phone: required("Phone"),
    email: required("EmailAddress"),
  };
}

function toBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}
