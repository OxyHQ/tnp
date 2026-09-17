/**
 * Builds Namecheap adapters for a provider account.
 *
 * Configuration is validated and the API key resolved here, when the adapter
 * is built: a misconfigured account fails with `ProviderError("credentials")`
 * before any operation is claimed for it. The key lives only inside the
 * transport instance; it is never on the adapter object a caller can inspect.
 *
 * Not registered anywhere by this module — the production registry decides
 * which factories a running process may use.
 */

import type { DnsAdapter, RegistrarAdapter } from "../contracts.js";
import type { AdapterDependencies, AdapterFactory, ProviderAccountConfig } from "../registry.js";
import { NamecheapClient, type NamecheapClientOptions } from "./client.js";
import { readNamecheapSettings } from "./config.js";
import { NamecheapDns } from "./dns.js";
import { NamecheapRegistrar } from "./registrar.js";

function buildClient(
  account: ProviderAccountConfig,
  deps: AdapterDependencies,
  options: NamecheapClientOptions,
): NamecheapClient {
  const settings = readNamecheapSettings(account);
  // `readNamecheapSettings` has already refused a null secretRef.
  const apiKey = deps.secrets.resolve(account.secretRef ?? "");
  return new NamecheapClient(account.ref.id, account.ref.environment, settings, apiKey, deps, options);
}

/** Exported for tests, which pass shorter timeouts; production uses `namecheapFactory`. */
export function createNamecheapRegistrar(
  account: ProviderAccountConfig,
  deps: AdapterDependencies,
  options: NamecheapClientOptions = {},
): RegistrarAdapter {
  return new NamecheapRegistrar(account.ref, buildClient(account, deps, options));
}

export function createNamecheapDns(
  account: ProviderAccountConfig,
  deps: AdapterDependencies,
  options: NamecheapClientOptions = {},
): DnsAdapter {
  return new NamecheapDns(account.ref, buildClient(account, deps, options));
}

export const namecheapFactory: AdapterFactory = {
  adapter: "namecheap",
  createRegistrar: (account, deps) => createNamecheapRegistrar(account, deps),
  createDns: (account, deps) => createNamecheapDns(account, deps),
};
