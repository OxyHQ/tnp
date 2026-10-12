/**
 * The exit agent's settings, from its environment (set by the systemd unit,
 * `deploy/tnp-exit-agent.service`).
 *
 * - `TNP_API_URL`            default `https://api.tnp.network`. HTTPS only,
 *                            except a loopback address for local testing.
 * - `TNP_EXIT_TOKEN`         the bearer secret for `/exit/peers`. When unset,
 *                            read from `$CREDENTIALS_DIRECTORY/exit-token`
 *                            (systemd `LoadCredential=`), which is how the unit
 *                            supplies it: the secret is then in no environment
 *                            block and no file the service user can list.
 * - `TNP_EXIT_INTERFACE`     default `wg0`.
 * - `TNP_EXIT_POLL_SECONDS`  default 20, clamped to 5-300.
 * - `TNP_EXIT_HEALTH_PORT`   default 9817 on 127.0.0.1; 0 turns it off.
 * - `TNP_EXIT_WG_BIN`        default `/usr/bin/wg` (a system path, not a PATH lookup).
 * - `TNP_EXIT_CONNTRACK_BIN` default `/usr/sbin/conntrack`.
 * - `TNP_EXIT_MAX_STALE_SECONDS` default 600, clamped to 60-3600: after this
 *                            long without a successful sync, every peer is
 *                            removed (fail closed; `agent.ts`).
 * - `TNP_EXIT_MONTHLY_CAP_GB` the monthly traffic cap, in + out on the uplink,
 *                            in decimal GB (`traffic-cap.ts`). Unset or 0: no cap.
 * - `TNP_EXIT_THROTTLE_MBIT` default 2: forwarding rate once capped, 1-10000.
 * - `TNP_EXIT_UPLINK`        the interface whose bytes are counted (required with a cap).
 * - `STATE_DIRECTORY`        where the month's count is kept (systemd `StateDirectory=`;
 *                            required with a cap).
 * - `TNP_EXIT_NFT_BIN`       default `/usr/sbin/nft`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isStrongExitToken } from '@tnp/shared-types';
import { BYTES_PER_GB } from './traffic-cap.js';

export interface AgentConfig {
  apiUrl: string;
  token: string;
  iface: string;
  intervalMs: number;
  healthPort: number;
  wgBin: string;
  conntrackBin: string;
  maxStaleMs: number;
  /** The monthly traffic cap; null when none is configured. */
  cap: TrafficCapConfig | null;
}

export interface TrafficCapConfig {
  capBytes: number;
  throttleMbit: number;
  uplink: string;
  stateDir: string;
  nftBin: string;
}

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

const IFACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$/;

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

export function readAgentConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): AgentConfig {
  const apiUrl = (env.TNP_API_URL?.trim() || 'https://api.tnp.network').replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new AgentConfigError('TNP_API_URL is not a URL');
  }
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && isLoopbackHost(parsed.host.replace(/:\d+$/, '')))
  ) {
    throw new AgentConfigError(
      'TNP_API_URL must be https:// (http:// only for a loopback address)',
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new AgentConfigError('TNP_API_URL must not carry credentials, a query or a fragment');
  }

  let token = env.TNP_EXIT_TOKEN?.trim() ?? '';
  if (!token && env.CREDENTIALS_DIRECTORY) {
    try {
      token = readFile(join(env.CREDENTIALS_DIRECTORY, 'exit-token')).trim();
    } catch {
      throw new AgentConfigError('the exit-token credential could not be read');
    }
  }
  if (!token)
    throw new AgentConfigError('TNP_EXIT_TOKEN (or the exit-token credential) is required');
  if (!isStrongExitToken(token)) {
    throw new AgentConfigError('the exit token must be at least 43 random base64url characters');
  }

  const iface = env.TNP_EXIT_INTERFACE?.trim() || 'wg0';
  if (!IFACE_RE.test(iface))
    throw new AgentConfigError('TNP_EXIT_INTERFACE is not an interface name');

  const poll = Number(env.TNP_EXIT_POLL_SECONDS?.trim() || '20');
  const intervalMs =
    Math.min(300, Math.max(5, Number.isFinite(poll) ? Math.round(poll) : 20)) * 1000;

  const healthPort = Number(env.TNP_EXIT_HEALTH_PORT?.trim() || '9817');
  if (!Number.isInteger(healthPort) || healthPort < 0 || healthPort > 65_535) {
    throw new AgentConfigError('TNP_EXIT_HEALTH_PORT must be a port number or 0');
  }

  const program = (name: string, fallback: string) => {
    const value = env[name]?.trim() || fallback;
    if (!/^\/[A-Za-z0-9_./-]+$/.test(value)) {
      throw new AgentConfigError(`${name} must be an absolute program path`);
    }
    return value;
  };
  const wgBin = program('TNP_EXIT_WG_BIN', '/usr/bin/wg');
  const conntrackBin = program('TNP_EXIT_CONNTRACK_BIN', '/usr/sbin/conntrack');

  const stale = Number(env.TNP_EXIT_MAX_STALE_SECONDS?.trim() || '600');
  const maxStaleMs =
    Math.min(3600, Math.max(60, Number.isFinite(stale) ? Math.round(stale) : 600)) * 1000;

  let cap: TrafficCapConfig | null = null;
  const capGb = Number(env.TNP_EXIT_MONTHLY_CAP_GB?.trim() || '0');
  if (!Number.isInteger(capGb) || capGb < 0 || capGb > 1_000_000) {
    throw new AgentConfigError('TNP_EXIT_MONTHLY_CAP_GB must be a whole number of GB (0: no cap)');
  }
  if (capGb > 0) {
    const throttleMbit = Number(env.TNP_EXIT_THROTTLE_MBIT?.trim() || '2');
    if (!Number.isInteger(throttleMbit) || throttleMbit < 1 || throttleMbit > 10_000) {
      throw new AgentConfigError('TNP_EXIT_THROTTLE_MBIT must be a whole number from 1 to 10000');
    }
    const uplink = env.TNP_EXIT_UPLINK?.trim() ?? '';
    if (!IFACE_RE.test(uplink)) {
      throw new AgentConfigError(
        'TNP_EXIT_UPLINK must name the uplink interface when a cap is set',
      );
    }
    const stateDir = env.STATE_DIRECTORY?.trim().split(':')[0] ?? '';
    if (!stateDir.startsWith('/')) {
      throw new AgentConfigError('a traffic cap needs STATE_DIRECTORY (systemd StateDirectory=)');
    }
    cap = {
      capBytes: capGb * BYTES_PER_GB,
      throttleMbit,
      uplink,
      stateDir,
      nftBin: program('TNP_EXIT_NFT_BIN', '/usr/sbin/nft'),
    };
  }

  return { apiUrl, token, iface, intervalMs, healthPort, wgBin, conntrackBin, maxStaleMs, cap };
}
