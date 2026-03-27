import { DnsProxy } from "../../../packages/client/src/proxy";
import type { TnpConfig } from "../../../packages/client/src/config";

const config: TnpConfig = {
  listenAddr: process.env.TNP_LISTEN_ADDR || "0.0.0.0",
  listenPort: Number(process.env.TNP_LISTEN_PORT) || 53,
  apiBaseUrl: process.env.TNP_API_URL || "https://api.tnp.network",
  upstreamDns: process.env.TNP_UPSTREAM_DNS || "1.1.1.1",
  cacheTtlSeconds: Number(process.env.TNP_CACHE_TTL) || 300,
};

const proxy = new DnsProxy(config);

console.log("[tnp-dns] starting public DNS server...");
console.log(`[tnp-dns] listen: ${config.listenAddr}:${config.listenPort}`);
console.log(`[tnp-dns] API: ${config.apiBaseUrl}`);
console.log(`[tnp-dns] upstream: ${config.upstreamDns}`);

proxy.startTldSync(5 * 60 * 1000);
await proxy.syncTlds();
await proxy.start();

const shutdown = () => {
  console.log("\n[tnp-dns] shutting down...");
  proxy.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
