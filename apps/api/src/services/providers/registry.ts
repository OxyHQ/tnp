/**
 * Adapter registry: which code serves a provider account.
 *
 * A factory is registered per adapter name; an account row names its adapter
 * and environment; the registry builds the family the caller asks for. The
 * production registry (`createProductionRegistry`) registers real adapters
 * only — the test-only adapter in `providers/testing/` is registered by tests
 * and can never be selected by a running process.
 */

import type {
  DnsAdapter,
  ProviderAccountRef,
  RegistrarAdapter,
} from "./contracts.js";
import { ProviderError } from "./errors.js";
import type { SecretResolver } from "./secrets.js";

export type QuotaPriority = "interactive" | "critical";

/**
 * Admission control for provider calls, shared by every replica.
 *
 * `critical` is renewals and reconciliation; `interactive` is search and
 * anything a user is waiting on. Interactive traffic may only use the
 * unreserved share of each window, so public search can never starve a
 * renewal. Refusal throws `ProviderError("rate_limited", { submitted: false })`.
 */
export interface QuotaGate {
  acquire(accountId: string, priority: QuotaPriority): Promise<void>;
}

export interface AdapterDependencies {
  readonly secrets: SecretResolver;
  readonly quota: QuotaGate;
  readonly fetch: typeof fetch;
  readonly now: () => Date;
}

/** The subset of a `provider_accounts` row an adapter is built from. */
export interface ProviderAccountConfig {
  readonly ref: ProviderAccountRef;
  /** Non-secret adapter configuration (usernames, client IP, endpoints by name). */
  readonly config: Readonly<Record<string, unknown>>;
  /** Pointer resolved through `SecretResolver`; never the secret itself. */
  readonly secretRef: string | null;
}

export interface AdapterFactory {
  readonly adapter: string;
  createRegistrar?(account: ProviderAccountConfig, deps: AdapterDependencies): RegistrarAdapter;
  createDns?(account: ProviderAccountConfig, deps: AdapterDependencies): DnsAdapter;
}

export class ProviderRegistry {
  readonly #factories = new Map<string, AdapterFactory>();

  constructor(private readonly deps: AdapterDependencies) {}

  register(factory: AdapterFactory): this {
    if (this.#factories.has(factory.adapter)) {
      throw new Error(`adapter ${factory.adapter} is already registered`);
    }
    this.#factories.set(factory.adapter, factory);
    return this;
  }

  has(adapter: string): boolean {
    return this.#factories.has(adapter);
  }

  registrar(account: ProviderAccountConfig): RegistrarAdapter {
    const factory = this.#factory(account);
    if (!factory.createRegistrar) {
      throw new ProviderError("unsupported", `adapter ${factory.adapter} does not implement registration`);
    }
    return factory.createRegistrar(account, this.deps);
  }

  dns(account: ProviderAccountConfig): DnsAdapter {
    const factory = this.#factory(account);
    if (!factory.createDns) {
      throw new ProviderError("unsupported", `adapter ${factory.adapter} does not implement DNS hosting`);
    }
    return factory.createDns(account, this.deps);
  }

  #factory(account: ProviderAccountConfig): AdapterFactory {
    const factory = this.#factories.get(account.ref.adapter);
    if (!factory) {
      throw new ProviderError("unsupported", `no adapter registered for ${account.ref.adapter}`);
    }
    return factory;
  }
}
