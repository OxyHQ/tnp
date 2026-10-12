/**
 * `@tnp/exit` — the agent on each TNP WireGuard exit (docs/architecture/exit-nodes.md §9).
 *
 * Polls the API for the device list and keeps `wg0`'s peers equal to it. It
 * does not create the interface, hold its private key or touch the packet
 * filter: `deploy/wg-up.sh` and the generated nftables ruleset do, as root, at
 * boot. This process runs unprivileged with CAP_NET_ADMIN only.
 */

import { createConntrackRunner, createPeerFetcher, createWgRunner, ExitAgent } from './agent.js';
import { AgentConfigError, readAgentConfig } from './config.js';
import { createNftRunner, stateFile, sysfsCounters, TrafficCap } from './traffic-cap.js';

let config: ReturnType<typeof readAgentConfig>;
try {
  config = readAgentConfig(process.env);
} catch (err) {
  console.error(
    `[tnp-exit] ${err instanceof AgentConfigError ? err.message : 'invalid configuration'}`,
  );
  process.exit(2);
}

const agent = new ExitAgent({
  fetchPeers: createPeerFetcher({ apiUrl: config.apiUrl, token: config.token }),
  runWg: createWgRunner(config.wgBin),
  runConntrack: createConntrackRunner(config.conntrackBin),
  iface: config.iface,
  intervalMs: config.intervalMs,
  maxStaleMs: config.maxStaleMs,
});

const server =
  config.healthPort === 0
    ? null
    : Bun.serve({
        hostname: '127.0.0.1',
        port: config.healthPort,
        fetch(req) {
          if (new URL(req.url).pathname !== '/health')
            return new Response('Not found', { status: 404 });
          const health = agent.health();
          return Response.json(health, {
            status: health.status === 'ok' ? 200 : 503,
            headers: { 'Cache-Control': 'no-store' },
          });
        },
      });

console.log(
  `[tnp-exit] syncing ${config.iface} from ${config.apiUrl} every ${config.intervalMs / 1000}s` +
    (server ? `; health on 127.0.0.1:${config.healthPort}` : ''),
);
agent.start();

// The monthly traffic cap (traffic-cap.ts): counted every minute, persisted
// every minute, so a restart or reboot loses at most nothing — the next reading
// takes its difference from the persisted counters.
let capTimer: ReturnType<typeof setInterval> | null = null;
if (config.cap) {
  const { cap } = config;
  const trafficCap = new TrafficCap({
    settings: { capBytes: cap.capBytes, throttleMbit: cap.throttleMbit },
    wgInterface: config.iface,
    readCounters: sysfsCounters(cap.uplink),
    ...stateFile(cap.stateDir),
    runNft: createNftRunner(cap.nftBin),
  });
  const tick = () =>
    trafficCap.tick().catch((err) => {
      console.error(`[tnp-exit] traffic cap: ${err instanceof Error ? err.message : String(err)}`);
    });
  void tick();
  capTimer = setInterval(tick, 60_000);
  console.log(
    `[tnp-exit] monthly cap ${cap.capBytes / 1e9} GB on ${cap.uplink} (in + out); throttle ${cap.throttleMbit} Mbit/s once reached`,
  );
}

const shutdown = () => {
  if (capTimer) clearInterval(capTimer);
  agent.stop();
  server?.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
