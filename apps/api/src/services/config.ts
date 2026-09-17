/**
 * Services-layer feature flags. Every flag defaults to off.
 *
 * Independent switches (services.md §9): turning on the catalog does not open
 * sales, and turning everything off leaves TNP Network exactly as it is.
 * There is no renewals flag yet: renewals TNP executes are paid, and arrive
 * with the Peable payment integration rather than as a switch that does nothing. A
 * flag is on only for the literal values `1` or `true`, so a typo or an empty
 * variable fails closed.
 */

import type { ProviderEnvironment } from "./providers/contracts.js";

export interface ServicesConfig {
  /** Public-domain search and quotes. */
  readonly catalog: boolean;
  /** Placing orders. Also needs the Peable payment integration, which does not exist yet. */
  readonly sales: boolean;
  /** Editing zones hosted by an integrated provider. */
  readonly dnsWrite: boolean;
  /**
   * Whether the worker process runs the outbox. Separate from the product
   * flags on purpose: turning off search, sales or DNS editing must not stop
   * syncing and reconciling resources that already exist.
   */
  readonly worker: boolean;
  /** Which provider environment customer-facing routes use. */
  readonly environment: ProviderEnvironment;
  readonly workerConcurrency: number;
  readonly workerPoolSize: number;
}

function flag(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

export function readServicesConfig(env: Readonly<Record<string, string | undefined>> = process.env): ServicesConfig {
  return {
    catalog: flag(env.TNP_SERVICES_CATALOG),
    sales: flag(env.TNP_SERVICES_SALES),
    dnsWrite: flag(env.TNP_SERVICES_DNS_WRITE),
    worker: flag(env.TNP_SERVICES_WORKER),
    // Production must be chosen explicitly; a missing value never points
    // customer traffic at a production registrar account.
    environment: env.TNP_SERVICES_ENVIRONMENT === "production" ? "production" : "sandbox",
    workerConcurrency: positiveInt(env.TNP_SERVICES_WORKER_CONCURRENCY, 2, 16),
    workerPoolSize: positiveInt(env.TNP_SERVICES_WORKER_POOL_SIZE, 4, 20),
  };
}
