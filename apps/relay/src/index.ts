/**
 * The standalone TNP relay. All routing, authentication and bounds are
 * `@tnp/relay-core` — the same code the relay in the `tnp` binary runs.
 *
 * Publishable; it serves traffic only once an oxy-infra change pins a
 * reviewed image digest, sets its secrets and scales it up
 * (docs/architecture/relays.md §8). It is listed for clients only through
 * the API's signed directory (`TNP_OXY_RELAYS`), and proves its relay key to
 * every client and service node that asks.
 *
 * Environment: see config.ts. `bun apps/relay/src/index.ts --check-config`
 * validates the environment and prints the endpoint and relay public key
 * without binding a port or contacting anything.
 */

import { apiDomainKeyLookup, RelayCore, serveRelay } from '@tnp/relay-core';
import { loadRelayConfig } from './config.js';

const loaded = loadRelayConfig(process.env);
if (!loaded.ok) {
  for (const error of loaded.errors) console.error(`[relay] ${error}`);
  process.exit(1);
}
const config = loaded.config;

if (process.argv.includes('--check-config')) {
  // Public values only: the endpoint, and the relay key the directory must list.
  console.log(
    JSON.stringify({ ok: true, endpoint: config.endpoint, relayKey: config.relayKey }, null, 2),
  );
  process.exit(0);
}

// Imported only for a real start: `--check-config` must not start telemetry.
const { recordTransport, requestEdgeRegion, startEcosystemActivity, stopEcosystemActivity } =
  await import('./ecosystemActivity.js');

let ready = false;
startEcosystemActivity(() => ready);

const core = new RelayCore({
  endpoint: config.endpoint,
  identity: config.identity,
  lookupDomainKey: apiDomainKeyLookup(config.apiUrl),
});
const relay = serveRelay({
  core,
  hostname: config.host,
  port: config.port,
  trustForwardedFor: config.trustForwardedFor,
  onRequest(req) {
    // Aggregate only: a direction and an edge region, never an address or name.
    if (new URL(req.url).pathname !== '/health') {
      recordTransport('inbound', requestEdgeRegion(req.headers));
    }
  },
});

ready = true;
const shutdown = async () => {
  ready = false;
  await relay.stop();
  await stopEcosystemActivity();
};
process.once('SIGTERM', () => {
  void shutdown();
});
process.once('SIGINT', () => {
  void shutdown();
});

console.log(
  `[relay] TNP relay listening on ${config.host}:${config.port} as ${config.endpoint} (relay key ${config.relayKey})`,
);

export { relay };
