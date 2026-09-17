/**
 * Provider contracts, one per capability family (docs/architecture/services.md §3).
 *
 * There is no `Provider` super-interface. A DNS host does not implement
 * registration and a registrar does not implement hosting: an adapter
 * implements the families it really serves, and declares, per operation,
 * whether that operation is automated, manual or unsupported — with the date
 * and environment in which that was validated.
 *
 * An operation declared `unsupported` or `manual` still exists on the
 * interface; its implementation throws `ProviderError("unsupported")`. It never
 * returns an empty success.
 */

import type { Money } from "../money.js";
import type { PublicDomainName } from "../publicNames.js";

export type ProviderEnvironment = "sandbox" | "production";

export type CapabilitySupport = "automated" | "manual" | "unsupported";

export interface CapabilityDeclaration {
  readonly support: CapabilitySupport;
  /** Restrictions: extensions, account state, documentation caveats. */
  readonly conditions?: string;
  /**
   * ISO date on which the operation was exercised against a real provider
   * environment, or `null` when it is implemented only against documentation
   * and recorded fixtures.
   */
  readonly validatedAt: string | null;
  readonly validatedIn: ProviderEnvironment | null;
}

export type CapabilityMatrix<Operation extends string> = Readonly<
  Record<Operation, CapabilityDeclaration>
>;

/** The provider account an adapter instance acts for. Never carries secrets. */
export interface ProviderAccountRef {
  readonly id: string;
  readonly adapter: string;
  readonly environment: ProviderEnvironment;
}

export interface AdapterCallContext {
  /** Correlates provider calls with the operation or request that made them. */
  readonly correlationId: string;
  readonly signal?: AbortSignal;
  /**
   * Called immediately before a mutating request is written to the network.
   * The operation engine persists `submitted_at` here, so a crash between this
   * call and the response is recovered by reconciliation, never re-execution.
   * Adapters MUST await it before sending any mutating request.
   */
  readonly beforeSubmit: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

export type RegistrarOperation =
  | "suffixes"
  | "availability"
  | "pricing"
  | "register"
  | "renew"
  | "info"
  | "list"
  | "contacts.read"
  | "contacts.update"
  | "lock.read"
  | "lock.update"
  | "transfer_in"
  | "transfer_status"
  | "transfer_out"
  | "balance";

export type PricedOperation = "register" | "renew" | "transfer_in";

export interface SuffixOffer {
  /** ASCII suffix without a leading dot: `com`, `co.uk`. */
  readonly suffix: string;
  readonly registerable: boolean;
  readonly renewable: boolean;
  readonly transferable: boolean;
  readonly minYears: number;
  readonly maxYears: number;
  readonly idn: boolean;
  /** Extension needs attributes beyond the standard contact set (e.g. `.us` nexus). */
  readonly requiresExtendedAttributes: boolean;
}

export type AvailabilityStatus = "available" | "unavailable" | "unknown" | "unsupported";

export interface AvailabilityResult {
  readonly name: PublicDomainName;
  readonly status: AvailabilityStatus;
  readonly premium: boolean;
  /** Registration price when the provider quotes a premium price with the check. */
  readonly premiumRegistrationPrice?: Money;
  readonly premiumRenewalPrice?: Money;
}

export interface PriceOffer {
  readonly suffix: string;
  readonly operation: PricedOperation;
  readonly years: number;
  /** What TNP's account is charged. */
  readonly cost: Money;
  /** Additional non-refundable fees the provider adds (e.g. ICANN fee), if itemized. */
  readonly fees: Money | null;
}

export interface Contact {
  readonly firstName: string;
  readonly lastName: string;
  readonly organization?: string;
  readonly jobTitle?: string;
  readonly address1: string;
  readonly address2?: string;
  readonly city: string;
  readonly stateProvince: string;
  readonly postalCode: string;
  /** ISO 3166-1 alpha-2. */
  readonly country: string;
  /** E.164-like `+NNN.NNNNNNNNNN` as registrars expect. */
  readonly phone: string;
  readonly email: string;
}

export interface ContactSet {
  readonly registrant: Contact;
  readonly admin: Contact;
  readonly tech: Contact;
  readonly billing: Contact;
}

export interface RegisterDomainRequest {
  readonly name: PublicDomainName;
  readonly years: number;
  readonly contacts: ContactSet;
  /** Empty: use the registrar's default nameservers. */
  readonly nameservers: readonly string[];
  readonly privacy: boolean;
  /** Refuse if the provider would charge more than this. */
  readonly maxCost: Money | null;
}

export interface RegisterDomainResult {
  readonly remoteId: string | null;
  readonly charged: Money | null;
  readonly remoteOrderId: string | null;
}

export interface RenewDomainRequest {
  readonly name: PublicDomainName;
  readonly years: number;
  readonly maxCost: Money | null;
}

export interface RenewDomainResult {
  readonly expiresAt: Date | null;
  readonly charged: Money | null;
  readonly remoteOrderId: string | null;
}

/** Provider-neutral lifecycle. The provider's raw status is kept alongside it. */
export type PublicDomainLifecycle =
  | "active"
  | "expired"
  | "redemption"
  | "pending"
  | "transferring_in"
  | "transferred_out"
  | "locked_by_registry"
  | "unknown";

export interface RemoteDomainInfo {
  readonly ascii: string;
  readonly remoteId: string | null;
  readonly rawStatus: string;
  readonly lifecycle: PublicDomainLifecycle;
  readonly createdAt: Date | null;
  readonly expiresAt: Date | null;
  readonly locked: boolean | null;
  readonly privacy: boolean | null;
  readonly autoRenew: boolean | null;
  /** Whether the registrar's own DNS serves the zone. */
  readonly usesProviderDns: boolean | null;
  readonly nameservers: readonly string[];
}

export interface RemoteDomainSummary {
  readonly ascii: string;
  readonly remoteId: string | null;
  readonly expiresAt: Date | null;
  readonly expired: boolean;
  readonly locked: boolean | null;
  readonly autoRenew: boolean | null;
}

export interface RemoteDomainPage {
  readonly items: readonly RemoteDomainSummary[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export type TransferState = "pending" | "completed" | "failed" | "cancelled" | "unknown";

export interface TransferStatus {
  readonly remoteTransferId: string;
  readonly state: TransferState;
  readonly rawStatus: string;
}

export interface TransferInRequest {
  readonly name: PublicDomainName;
  /** EPP authorization code. Redacted everywhere except the request body itself. */
  readonly authCode: string;
  readonly years: number;
  readonly maxCost: Money | null;
}

export interface RegistrarAdapter {
  readonly adapter: string;
  readonly account: ProviderAccountRef;
  readonly capabilities: CapabilityMatrix<RegistrarOperation>;

  listSuffixes(ctx: AdapterCallContext): Promise<readonly SuffixOffer[]>;
  checkAvailability(
    ctx: AdapterCallContext,
    names: readonly PublicDomainName[],
  ): Promise<readonly AvailabilityResult[]>;
  getPrices(
    ctx: AdapterCallContext,
    query: { readonly operation: PricedOperation; readonly suffix: string },
  ): Promise<readonly PriceOffer[]>;
  register(ctx: AdapterCallContext, request: RegisterDomainRequest): Promise<RegisterDomainResult>;
  renew(ctx: AdapterCallContext, request: RenewDomainRequest): Promise<RenewDomainResult>;
  /** Throws `ProviderError("not_found")` when this account does not hold the name. */
  getInfo(ctx: AdapterCallContext, name: PublicDomainName): Promise<RemoteDomainInfo>;
  listDomains(
    ctx: AdapterCallContext,
    page: { readonly page: number; readonly pageSize: number },
  ): Promise<RemoteDomainPage>;
  getContacts(ctx: AdapterCallContext, name: PublicDomainName): Promise<ContactSet>;
  setContacts(ctx: AdapterCallContext, name: PublicDomainName, contacts: ContactSet): Promise<void>;
  getLock(ctx: AdapterCallContext, name: PublicDomainName): Promise<boolean>;
  setLock(ctx: AdapterCallContext, name: PublicDomainName, locked: boolean): Promise<void>;
  transferIn(ctx: AdapterCallContext, request: TransferInRequest): Promise<TransferStatus>;
  getTransferStatus(ctx: AdapterCallContext, remoteTransferId: string): Promise<TransferStatus>;
  /** TNP's own wholesale balance. Never shown to customers. */
  getBalance(ctx: AdapterCallContext): Promise<Money>;
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

export type DnsOperation = "zone.read" | "zone.replace";

export interface ZoneRecord {
  /** Relative host: `@` for the apex, `www`, `_dmarc`. */
  readonly host: string;
  readonly type: string;
  readonly value: string;
  readonly ttl: number;
  /** MX preference (and SRV priority, if ever supported). */
  readonly priority: number | null;
}

export interface Zone {
  readonly records: readonly ZoneRecord[];
  /**
   * Zone-level settings the provider requires to be sent back on a full
   * replace (Namecheap's `EmailType`, for instance). Preserved verbatim: a
   * setting TNP does not understand is a setting TNP must not reset.
   */
  readonly settings: Readonly<Record<string, string>>;
  /** Whether this provider is actually serving the zone right now. */
  readonly servedByProvider: boolean;
}

export interface DnsAdapter {
  readonly adapter: string;
  readonly account: ProviderAccountRef;
  readonly capabilities: CapabilityMatrix<DnsOperation>;
  /** Record types this adapter can round-trip without losing fields. */
  readonly supportedRecordTypes: readonly string[];

  readZone(ctx: AdapterCallContext, name: PublicDomainName): Promise<Zone>;
  /**
   * Replace the whole zone with `zone`. Records not in `zone` are deleted by the
   * provider — callers go through `services/dns/apply.ts`, which reads, merges
   * and re-reads, and never call this with a partial set.
   */
  replaceZone(ctx: AdapterCallContext, name: PublicDomainName, zone: Zone): Promise<void>;
}

// ---------------------------------------------------------------------------
// Hosting — designed only (services.md §10). No adapter implements this yet.
// ---------------------------------------------------------------------------

export type HostingOperation =
  | "plans"
  | "provision"
  | "status"
  | "change_plan"
  | "suspend"
  | "resume"
  | "cancel"
  | "access"
  | "backup_export";

export type SiteState = "provisioning" | "active" | "suspended" | "cancelled" | "unknown";

export interface HostingPlan {
  readonly id: string;
  readonly family: "managed_web" | "static" | "vps";
  readonly region: string;
  /** Hard limits. There is no "unlimited". */
  readonly limits: Readonly<Record<string, number>>;
  readonly cost: Money;
  readonly termMonths: number;
}

export interface SiteStatus {
  readonly remoteId: string;
  readonly state: SiteState;
  readonly rawStatus: string;
  readonly usage: Readonly<Record<string, number>>;
}

export interface HostingAdapter {
  readonly adapter: string;
  readonly account: ProviderAccountRef;
  readonly capabilities: CapabilityMatrix<HostingOperation>;

  listPlans(ctx: AdapterCallContext): Promise<readonly HostingPlan[]>;
  provision(ctx: AdapterCallContext, request: { readonly planId: string; readonly label: string }): Promise<SiteStatus>;
  getStatus(ctx: AdapterCallContext, remoteId: string): Promise<SiteStatus>;
  changePlan(ctx: AdapterCallContext, remoteId: string, planId: string): Promise<SiteStatus>;
  suspend(ctx: AdapterCallContext, remoteId: string): Promise<SiteStatus>;
  resume(ctx: AdapterCallContext, remoteId: string): Promise<SiteStatus>;
  cancel(ctx: AdapterCallContext, remoteId: string): Promise<SiteStatus>;
  /** A short-lived, least-privilege access grant. Never wholesale credentials. */
  createAccess(ctx: AdapterCallContext, remoteId: string): Promise<{ readonly url: string; readonly expiresAt: Date }>;
  exportBackup(ctx: AdapterCallContext, remoteId: string): Promise<{ readonly url: string; readonly expiresAt: Date }>;
}
