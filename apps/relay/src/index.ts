/**
 * The standalone TNP relay. All routing, authentication and bounds are
 * `@tnp/relay-core` — the same code the relay in the `tnp` binary runs.
 *
 * PARKED: not published, not deployed, ECS desired count 0 — see
 * docs/architecture/relays.md §8 for the blockers that remain open.
 *
 * Environment:
 *   RELAY_ENDPOINT   required: the public ws(s):// URL clients and service
 *                    nodes dial. Service nodes sign it when they authenticate,
 *                    so it must match what they dial exactly.
 *   TNP_API_URL      registry the domain keys are read from (default
 *                    https://api.tnp.network)
 *   RELAY_HOST / RELAY_PORT   bind address (default 0.0.0.0:8080)
 *   RELAY_TRUST_FORWARDED_FOR=1   take client addresses from the load
 *                    balancer's X-Forwarded-For (only behind one)
 */

import { apiDomainKeyLookup, RelayCore, serveRelay } from '@tnp/relay-core';
import { normalizeRelayEndpoint } from '@tnp/shared-types';
import {
  recordTransport,
  requestEdgeRegion,
  startEcosystemActivity,
  stopEcosystemActivity,
} from './ecosystemActivity.js';

const RELAY_PORT = Number(process.env.RELAY_PORT) || 8080;
const RELAY_HOST = process.env.RELAY_HOST ?? '0.0.0.0';
const API_URL = process.env.TNP_API_URL?.trim() || 'https://api.tnp.network';
const endpoint = normalizeRelayEndpoint(process.env.RELAY_ENDPOINT ?? '');

if (!endpoint) {
  console.error('[relay] RELAY_ENDPOINT must be the public ws:// or wss:// URL of this relay');
  process.exit(1);
}

let ready = false;
startEcosystemActivity(() => ready);

const core = new RelayCore({ endpoint, lookupDomainKey: apiDomainKeyLookup(API_URL) });
const relay = serveRelay({
  core,
  hostname: RELAY_HOST,
  port: RELAY_PORT,
  trustForwardedFor: process.env.RELAY_TRUST_FORWARDED_FOR === '1',
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

console.log(`[relay] TNP relay listening on ${RELAY_HOST}:${RELAY_PORT} as ${endpoint}`);

export { relay };
