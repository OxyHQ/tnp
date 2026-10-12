/**
 * The Bun WebSocket binding for `RelayCore` (transport.md §2: the binding is
 * the only runtime-specific part). Shared by `apps/relay` and the relay in the
 * `tnp` binary, so both get the same bounds:
 *
 *  - `maxPayloadLength` = MAX_FRAME_SIZE: Bun closes a connection that sends a
 *    larger message before it is buffered whole.
 *  - `backpressureLimit` + `closeOnBackpressureLimit`: a hard backstop above
 *    the per-circuit enforcement in the core.
 *  - `idleTimeout` with pings: a dead peer's connection, circuits and service
 *    registration are released.
 *  - per-IP admission before the upgrade.
 *
 * Routes: `/tunnel` (anonymous clients), `/service` (service nodes, which must
 * authenticate before anything else), `/health`, `/stats` (aggregate counters
 * only — no names, no addresses).
 */

import type { Server, ServerWebSocket } from 'bun';
import { IDLE_TIMEOUT_MS, MAX_FRAME_SIZE } from '@tnp/protocol/v1';
import type { ConnectionHandle, RelayCore } from './core.js';

interface SocketData {
  kind: 'client' | 'service';
  ip: string;
  handle?: ConnectionHandle;
}

export interface ServeRelayOptions {
  core: RelayCore;
  hostname: string;
  port: number;
  /** Extra HTTP routes (health checks with service names, etc.). Return undefined to fall through. */
  fetch?: (req: Request) => Response | undefined | Promise<Response | undefined>;
  /** Name reported by /health. */
  serviceName?: string;
  /** Observe every HTTP request (aggregate telemetry). Must not record addresses or paths beyond the route. */
  onRequest?: (req: Request) => void;
  /**
   * Take the client address from the LAST `X-Forwarded-For` entry — the one
   * the trusted load balancer appended — instead of the socket peer. Only for a
   * relay that is reachable exclusively through such a proxy; otherwise a
   * client could pick its own address and walk around the per-IP limits.
   */
  trustForwardedFor?: boolean;
  /**
   * How often the relay sends a WebSocket ping to EVERY connection (default
   * 25 s). Idle overlay links are normal — a service node waiting for
   * clients, a client between requests — and the load balancer in front of a
   * production relay drops a connection after 60 s without a byte either way
   * (Cloudflare after 100 s). A ping, and the pong every WebSocket client
   * answers with automatically, keeps both legs of the path active. 0 disables.
   */
  pingIntervalMs?: number;
  /** Override the relay's own idle timeout (seconds; tests). */
  idleTimeoutSeconds?: number;
}

/** Default keepalive: under every idle timeout on the path (ALB 60 s, Cloudflare 100 s). */
export const RELAY_PING_INTERVAL_MS = 25_000;

function clientIp(req: Request, srv: Server<SocketData>, trustForwardedFor: boolean): string {
  if (trustForwardedFor) {
    const forwarded = req.headers.get('x-forwarded-for');
    const last = forwarded?.split(',').at(-1)?.trim();
    if (last) return last;
  }
  return srv.requestIP(req)?.address ?? 'unknown';
}

export interface RelayServer {
  server: Server<SocketData>;
  readonly port: number;
  stop(): Promise<void>;
}

function toBytes(message: string | Buffer | ArrayBuffer | Uint8Array): Uint8Array | null {
  if (typeof message === 'string') return null;
  if (message instanceof Uint8Array) return message;
  return new Uint8Array(message);
}

export function serveRelay(options: ServeRelayOptions): RelayServer {
  const { core } = options;
  const open = new Set<ServerWebSocket<SocketData>>();
  const backstop = 2 * Math.max(core.limits.clientBufferLimit, core.limits.serviceBufferLimit);

  const server = Bun.serve<SocketData>({
    hostname: options.hostname,
    port: options.port,

    async fetch(req, srv) {
      const url = new URL(req.url);
      options.onRequest?.(req);
      if (url.pathname === '/tunnel' || url.pathname === '/service') {
        const ip = clientIp(req, srv, options.trustForwardedFor ?? false);
        const admission = core.admit(ip);
        if (!admission.ok) return new Response(admission.reason, { status: admission.status });
        const kind = url.pathname === '/tunnel' ? 'client' : 'service';
        if (srv.upgrade(req, { data: { kind, ip } })) return undefined;
        core.releaseAdmission(ip);
        return new Response('WebSocket upgrade required', { status: 426 });
      }
      if (url.pathname === '/health') {
        return Response.json({ ok: true, service: options.serviceName ?? 'tnp-relay' });
      }
      if (url.pathname === '/stats') return Response.json(core.stats());
      const extra = await options.fetch?.(req);
      return extra ?? new Response('Not Found', { status: 404 });
    },

    websocket: {
      perMessageDeflate: false,
      maxPayloadLength: MAX_FRAME_SIZE,
      backpressureLimit: backstop,
      closeOnBackpressureLimit: true,
      idleTimeout: options.idleTimeoutSeconds ?? Math.ceil(IDLE_TIMEOUT_MS / 1000),
      sendPings: true,

      open(ws: ServerWebSocket<SocketData>) {
        open.add(ws);
        const transport = {
          send: (frame: Uint8Array) => ws.sendBinary(frame),
          bufferedAmount: () => ws.getBufferedAmount(),
          close: (code?: number, reason?: string) => ws.close(code, reason),
        };
        ws.data.handle =
          ws.data.kind === 'client'
            ? core.acceptClient(transport, ws.data.ip)
            : core.acceptService(transport, ws.data.ip);
      },

      message(ws: ServerWebSocket<SocketData>, message) {
        const bytes = toBytes(message);
        if (!bytes) {
          // Text frames are not part of the protocol.
          ws.close(1003, 'binary frames only');
          return;
        }
        ws.data.handle?.receive(bytes);
      },

      close(ws: ServerWebSocket<SocketData>) {
        open.delete(ws);
        ws.data.handle?.closed();
      },
    },
  });

  const pingEvery = options.pingIntervalMs ?? RELAY_PING_INTERVAL_MS;
  const pinger =
    pingEvery > 0
      ? setInterval(() => {
          for (const ws of open) {
            try {
              ws.ping();
            } catch {
              // closing; its close handler removes it
            }
          }
        }, pingEvery)
      : null;
  pinger?.unref?.();

  return {
    server,
    get port() {
      return server.port ?? options.port;
    },
    async stop() {
      if (pinger) clearInterval(pinger);
      core.shutdown();
      await server.stop(true);
    },
  };
}
