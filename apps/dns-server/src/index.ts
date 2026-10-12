import {
  startEcosystemActivity,
  recordTransport,
  stopEcosystemActivity,
} from './ecosystemActivity.js';
import { DnsProxy } from '../../../packages/client/src/proxy';
import {
  DEFAULT_UPSTREAM_DNS,
  type DnsProxyConfig,
  readRateLimitExempt,
} from '../../../packages/client/src/config';

/** A positive integer from the environment, or the fallback. */
function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * The public resolver answers anyone who can reach it, so its defaults are the
 * safe ones: encrypted upstreams (a plaintext upstream would expose every
 * user's public lookups on the path between this server and the upstream),
 * per-source response rate limiting, and caps on TCP connections and work in
 * flight. `TNP_UPSTREAM_DNS` (set in oxy-infra) overrides the upstream list;
 * a plaintext entry there is logged as a warning at startup.
 */
// TNP's WireGuard exits send every VPN user's queries from one address each,
// so they are exempt from the per-source limit (still bound by the global caps).
const exempt = readRateLimitExempt(
  process.env.TNP_DNS_RATE_LIMIT_EXEMPT,
  process.env.NODE_ENV === 'production',
);
if (!exempt.ok) {
  console.error(`[tnp-dns] ${exempt.error}. Refusing to start.`);
  process.exit(1);
}
if (exempt.warning) console.warn(`[tnp-dns] ${exempt.warning}`);

const config: DnsProxyConfig = {
  listenAddr: process.env.TNP_LISTEN_ADDR || '0.0.0.0',
  listenPort: Number(process.env.TNP_LISTEN_PORT) || 5353,
  apiBaseUrl: process.env.TNP_API_URL || 'https://api.tnp.network',
  cacheMaxEntries: envInt('TNP_CACHE_MAX_ENTRIES', 10_000),
  upstreamDns: process.env.TNP_UPSTREAM_DNS || DEFAULT_UPSTREAM_DNS,
  tldCachePath: process.env.TNP_TLD_CACHE_PATH || undefined,
  rateLimit: {
    perSecond: envInt('TNP_RATE_LIMIT_QPS', 20),
    burst: envInt('TNP_RATE_LIMIT_BURST', 100),
  },
  rateLimitExempt: exempt.entries,
  maxTcpConnections: envInt('TNP_MAX_TCP_CONNECTIONS', 256),
  maxInflight: envInt('TNP_MAX_INFLIGHT', 512),
};

const proxy = new DnsProxy(config, recordTransport);

console.log('[tnp-dns] starting public DNS server...');
console.log(`[tnp-dns] listen: ${config.listenAddr}:${config.listenPort}`);
console.log(`[tnp-dns] API: ${config.apiBaseUrl}`);
console.log(`[tnp-dns] upstream: ${config.upstreamDns}`);
console.log(`[tnp-dns] rate-limit exempt sources: ${exempt.entries.length}`);

startEcosystemActivity(() => proxy.listening);
proxy.startTldSync(5 * 60 * 1000);
// Native TLDs are classified from the built-in list before this returns, and a
// failure keeps them: a native name is never forwarded upstream either way.
await proxy.syncTlds();
await proxy.start();

const shutdown = async () => {
  console.log('\n[tnp-dns] shutting down...');
  proxy.stop();
  await stopEcosystemActivity();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
