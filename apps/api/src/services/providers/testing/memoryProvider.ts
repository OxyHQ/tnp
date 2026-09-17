/**
 * An in-memory registrar and DNS host, for tests only.
 *
 * It exists so the contracts are exercised by two implementations with
 * different behaviour (services.md §3): its capabilities differ from
 * Namecheap's on purpose (no transfers, manual contact updates, a narrower
 * record-type set), it can add latency, and it can fail in each of the ways
 * the operation engine must survive — refusing before submission, applying and
 * then timing out, timing out without applying.
 *
 * It is never registered by `createProductionRegistry`, and the import
 * boundary check refuses any non-test import of this directory.
 */

import type { Money } from "../../money.js";
import type { PublicDomainName } from "../../publicNames.js";
import type {
  AdapterCallContext,
  AvailabilityResult,
  CapabilityMatrix,
  ContactSet,
  DnsAdapter,
  DnsOperation,
  PriceOffer,
  PricedOperation,
  ProviderAccountRef,
  RegistrarAdapter,
  RegistrarOperation,
  RegisterDomainRequest,
  RemoteDomainInfo,
  RemoteDomainPage,
  RenewDomainRequest,
  SuffixOffer,
  TransferStatus,
  Zone,
} from "../contracts.js";
import { ProviderError } from "../errors.js";
import type { AdapterFactory } from "../registry.js";

const automated = { support: "automated", validatedAt: null, validatedIn: null } as const;
const unsupported = { support: "unsupported", validatedAt: null, validatedIn: null } as const;

export const MEMORY_REGISTRAR_CAPABILITIES: CapabilityMatrix<RegistrarOperation> = {
  suffixes: automated,
  availability: automated,
  pricing: automated,
  register: automated,
  renew: automated,
  info: automated,
  list: automated,
  "contacts.read": automated,
  "contacts.update": { support: "manual", conditions: "Requires a support ticket.", validatedAt: null, validatedIn: null },
  "lock.read": automated,
  "lock.update": automated,
  transfer_in: unsupported,
  transfer_status: unsupported,
  transfer_out: unsupported,
  balance: automated,
};

/** How the next call to a method misbehaves. */
export type Fault =
  /** Behave normally; lets a later call in the same method's queue misbehave. */
  | { readonly mode: "none" }
  /** Throws before `beforeSubmit`: nothing sent, nothing applied. */
  | { readonly mode: "refuse"; readonly code: ProviderError["code"] }
  /** Sends, applies, then loses the response. */
  | { readonly mode: "apply_then_timeout" }
  /** Sends, does not apply, then loses the response. */
  | { readonly mode: "timeout_without_apply" };

interface StoredDomain {
  remoteId: string;
  expiresAt: Date;
  createdAt: Date;
  locked: boolean;
  contacts: ContactSet;
  zone: Zone;
}

export class MemoryProviderState {
  readonly domains = new Map<string, StoredDomain>();
  /** Names someone else already holds. */
  readonly taken = new Set<string>();
  readonly premium = new Map<string, Money>();
  readonly faults = new Map<string, Fault[]>();
  readonly calls: { method: string; name?: string }[] = [];
  balance: Money = { currency: "USD", minor: 100_000n };
  latencyMs = 0;
  registerCost: Money = { currency: "USD", minor: 1099n };
  renewCost: Money = { currency: "USD", minor: 1299n };
  fee: Money = { currency: "USD", minor: 20n };
  suffixes: SuffixOffer[] = [
    { suffix: "com", registerable: true, renewable: true, transferable: false, minYears: 1, maxYears: 10, idn: true, requiresExtendedAttributes: false },
    { suffix: "co.uk", registerable: true, renewable: true, transferable: false, minYears: 1, maxYears: 10, idn: false, requiresExtendedAttributes: false },
    { suffix: "us", registerable: true, renewable: true, transferable: false, minYears: 1, maxYears: 10, idn: false, requiresExtendedAttributes: true },
  ];

  failNext(method: string, fault: Fault): void {
    const queue = this.faults.get(method) ?? [];
    queue.push(fault);
    this.faults.set(method, queue);
  }

  takeFault(method: string): Fault | undefined {
    return this.faults.get(method)?.shift();
  }
}

async function pause(ms: number): Promise<void> {
  if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
}

function timeout(method: string): ProviderError {
  return new ProviderError("unknown_outcome", `${method} timed out after sending`, { submitted: true });
}

export function createMemoryAdapters(account: ProviderAccountRef, state: MemoryProviderState) {
  /** Run a mutating call with fault injection around the submission point. */
  async function mutate<T>(method: string, ctx: AdapterCallContext, apply: () => T): Promise<T> {
    state.calls.push({ method });
    await pause(state.latencyMs);
    const taken = state.takeFault(method);
    const fault = taken?.mode === "none" ? undefined : taken;
    if (fault?.mode === "refuse") throw new ProviderError(fault.code, `${method} refused`, { submitted: false });
    await ctx.beforeSubmit();
    if (fault?.mode === "timeout_without_apply") throw timeout(method);
    const result = apply();
    if (fault?.mode === "apply_then_timeout") throw timeout(method);
    return result;
  }

  async function read<T>(method: string, apply: () => T): Promise<T> {
    state.calls.push({ method });
    await pause(state.latencyMs);
    const taken = state.takeFault(method);
    const fault = taken?.mode === "none" ? undefined : taken;
    if (fault?.mode === "refuse") throw new ProviderError(fault.code, `${method} refused`, { submitted: false });
    if (fault) throw new ProviderError("provider_unavailable", `${method} timed out`, { submitted: true });
    return apply();
  }

  function held(name: PublicDomainName): StoredDomain {
    const domain = state.domains.get(name.ascii);
    if (!domain) throw new ProviderError("not_found", `${name.ascii} is not in this account`);
    return domain;
  }

  function capCost(cost: Money, max: Money | null) {
    if (max && (max.currency !== cost.currency || cost.minor > max.minor)) {
      throw new ProviderError("conflict", "price above the accepted maximum", { submitted: true });
    }
  }

  const registrar: RegistrarAdapter = {
    adapter: "memory",
    account,
    capabilities: MEMORY_REGISTRAR_CAPABILITIES,
    listSuffixes: () => read("listSuffixes", () => state.suffixes),
    checkAvailability: (_ctx, names) =>
      read("checkAvailability", () =>
        names.map((name): AvailabilityResult => {
          const premium = state.premium.get(name.ascii);
          return {
            name,
            status: state.taken.has(name.ascii) || state.domains.has(name.ascii) ? "unavailable" : "available",
            premium: premium !== undefined,
            premiumRegistrationPrice: premium,
            premiumRenewalPrice: premium,
          };
        }),
      ),
    getPrices: (_ctx, query: { operation: PricedOperation; suffix: string }) =>
      read("getPrices", () =>
        [1, 2, 3].map((years): PriceOffer => ({
          suffix: query.suffix,
          operation: query.operation,
          years,
          cost: { currency: "USD", minor: (query.operation === "renew" ? state.renewCost : state.registerCost).minor * BigInt(years) },
          fees: state.fee,
        })),
      ),
    register: (ctx, request: RegisterDomainRequest) =>
      mutate("register", ctx, () => {
        if (state.taken.has(request.name.ascii) || state.domains.has(request.name.ascii)) {
          throw new ProviderError("not_available", "taken", { submitted: true });
        }
        const cost = { currency: "USD", minor: state.registerCost.minor * BigInt(request.years) };
        capCost(cost, request.maxCost);
        const now = new Date();
        const expiresAt = new Date(now);
        expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + request.years);
        const remoteId = `mem-${state.domains.size + 1}`;
        state.domains.set(request.name.ascii, {
          remoteId,
          createdAt: now,
          expiresAt,
          locked: true,
          contacts: request.contacts,
          zone: { records: [], settings: { EmailType: "NONE" }, servedByProvider: true },
        });
        state.balance = { ...state.balance, minor: state.balance.minor - cost.minor };
        return { remoteId, charged: cost, remoteOrderId: `order-${remoteId}` };
      }),
    renew: (ctx, request: RenewDomainRequest) =>
      mutate("renew", ctx, () => {
        const domain = held(request.name);
        capCost({ currency: "USD", minor: state.renewCost.minor * BigInt(request.years) }, request.maxCost);
        const next = new Date(domain.expiresAt);
        next.setUTCFullYear(next.getUTCFullYear() + request.years);
        domain.expiresAt = next;
        return { expiresAt: next, charged: state.renewCost, remoteOrderId: null };
      }),
    getInfo: (_ctx, name): Promise<RemoteDomainInfo> =>
      read("getInfo", () => {
        const domain = held(name);
        return {
          ascii: name.ascii,
          remoteId: domain.remoteId,
          rawStatus: "Ok",
          lifecycle: "active",
          createdAt: domain.createdAt,
          expiresAt: domain.expiresAt,
          locked: domain.locked,
          privacy: null,
          autoRenew: false,
          usesProviderDns: domain.zone.servedByProvider,
          nameservers: [],
        };
      }),
    listDomains: (_ctx, page): Promise<RemoteDomainPage> =>
      read("listDomains", () => {
        const all = [...state.domains.entries()];
        const slice = all.slice((page.page - 1) * page.pageSize, page.page * page.pageSize);
        return {
          items: slice.map(([ascii, d]) => ({ ascii, remoteId: d.remoteId, expiresAt: d.expiresAt, expired: false, locked: d.locked, autoRenew: false })),
          page: page.page,
          pageSize: page.pageSize,
          total: all.length,
        };
      }),
    getContacts: (_ctx, name) => read("getContacts", () => held(name).contacts),
    setContacts: async () => {
      throw new ProviderError("unsupported", "contact updates are manual at this provider");
    },
    getLock: (_ctx, name) => read("getLock", () => held(name).locked),
    setLock: (ctx, name, locked) =>
      mutate("setLock", ctx, () => {
        held(name).locked = locked;
      }),
    transferIn: async (): Promise<TransferStatus> => {
      throw new ProviderError("unsupported", "transfers are not offered by this provider");
    },
    getTransferStatus: async (): Promise<TransferStatus> => {
      throw new ProviderError("unsupported", "transfers are not offered by this provider");
    },
    getBalance: () => read("getBalance", () => state.balance),
  };

  const dns: DnsAdapter = {
    adapter: "memory",
    account,
    capabilities: { "zone.read": automated, "zone.replace": automated } satisfies CapabilityMatrix<DnsOperation>,
    supportedRecordTypes: ["A", "AAAA", "CNAME", "MX", "TXT"],
    readZone: (_ctx, name) =>
      read("readZone", () => {
        const zone = held(name).zone;
        return { records: [...zone.records], settings: { ...zone.settings }, servedByProvider: zone.servedByProvider };
      }),
    replaceZone: (ctx, name, zone) =>
      mutate("replaceZone", ctx, () => {
        held(name).zone = { records: [...zone.records], settings: { ...zone.settings }, servedByProvider: true };
      }),
  };

  return { registrar, dns };
}

export function memoryProviderFactory(state: MemoryProviderState): AdapterFactory {
  return {
    adapter: "memory",
    createRegistrar: (account) => createMemoryAdapters(account.ref, state).registrar,
    createDns: (account) => createMemoryAdapters(account.ref, state).dns,
  };
}
