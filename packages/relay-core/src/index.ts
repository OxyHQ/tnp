/**
 * `@tnp/relay-core` — the one relay implementation (docs/architecture/relays.md).
 *
 * `apps/relay` (the standalone server) and `packages/client/src/relay-node.ts`
 * (the relay in the `tnp` binary) both run this. There used to be two copies
 * with the same bugs in each; a fix to one was not a fix.
 */
export {
  type Admission,
  type ConnectionHandle,
  type DomainKeyLookup,
  RelayCore,
  type RelayCoreOptions,
  type RelayIdentity,
  type RelayStats,
  type RelayTransport,
} from './core.js';
export { type ApiDomainKeyLookupOptions, apiDomainKeyLookup } from './domain-keys.js';
export { DEFAULT_LIMITS, type RelayLimits } from './limits.js';
export { type RelayServer, type ServeRelayOptions, serveRelay } from './serve.js';
