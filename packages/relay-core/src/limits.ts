/**
 * Every bound the relay enforces, in one place (docs/architecture/relays.md §3).
 *
 * Each one closes a single-client denial-of-service path the prototype relay
 * had (audit S6): no frame cap, no circuit cap, no per-IP limit, no handshake
 * rate limit, no backpressure, unbounded tables.
 */

import {
  HANDSHAKE_TIMEOUT_MS,
  MAX_CIRCUITS_PER_CONNECTION,
  MAX_PENDING_OPENS,
  STREAM_WINDOW_INITIAL,
} from '@tnp/protocol/v1';

export interface RelayLimits {
  /** Open WebSocket connections, all kinds. */
  maxConnections: number;
  /** Open connections from one IP address. */
  maxConnectionsPerIp: number;
  /** New connections per IP: bucket size and refill per second. */
  connectBurstPerIp: number;
  connectRefillPerSecondPerIp: number;
  /** Circuits one client connection may hold (protocol constant 64). */
  maxCircuitsPerClient: number;
  /** Circuits awaiting CIRCUIT_CREATED per client connection (protocol constant 32). */
  maxPendingPerClient: number;
  /** Circuits one service-node connection carries. */
  maxCircuitsPerService: number;
  /**
   * Circuits one CLIENT CONNECTION may hold to any one service, and circuits
   * one IP ADDRESS may hold to any one service across all its connections.
   * Both well below `maxCircuitsPerService`, so a single address cannot take
   * every slot a service has (it is refused, fairly, with CIRCUIT_LIMIT) and
   * an innocent client still gets in.
   */
  maxCircuitsPerClientPerService: number;
  maxCircuitsPerIpPerService: number;
  /**
   * An open circuit with no frame in either direction for this long is
   * destroyed. Above the service node's own stream idle timeout, so the
   * service node normally ends it first with a sealed reset.
   */
  circuitIdleMs: number;
  /**
   * Bytes buffered across ALL connections. Per-connection limits times the
   * connection cap is far too much memory; above this, the connections with
   * the most buffered are closed first until the total is back under it.
   */
  globalBufferLimit: number;
  /** Service-node AUTH attempts per IP (each costs a registry lookup): bucket and refill per second. */
  authBurstPerIp: number;
  authRefillPerSecondPerIp: number;
  /** How long a name with no domain key is remembered as such (bounded, per name). */
  lookupNegativeTtlMs: number;
  lookupCacheMax: number;
  /** Circuits across the whole relay. */
  maxCircuits: number;
  /** Names served at once. */
  maxServiceNodes: number;
  /**
   * CIRCUIT_CREATE per IP — the expensive part (a DH at the service node) is
   * rate-limited before it is forwarded (security.md §9).
   */
  createBurstPerIp: number;
  createRefillPerSecondPerIp: number;
  /**
   * Bytes buffered towards one connection beyond which a forwarded frame
   * destroys ITS circuit instead of being queued. Honest ends never get here:
   * the end-to-end window bounds each circuit's bytes in flight to
   * STREAM_WINDOW_INITIAL, so these are circuits × window plus slack. Only a
   * sender that ignores its window can fill a buffer, and it loses the circuit
   * it was filling it with — the destination connection, and everyone else's
   * circuits on it, are left alone.
   */
  clientBufferLimit: number;
  serviceBufferLimit: number;
  /** Service-node AUTH must complete within this. */
  handshakeTimeoutMs: number;
  /** A circuit not answered with CIRCUIT_CREATED within this is destroyed. */
  createTimeoutMs: number;
  /** Frames for circuits a connection does not own, before it is closed. */
  maxViolations: number;
  /** IP addresses tracked for rate limiting at once; beyond it new IPs are refused. */
  maxTrackedIps: number;
  /** How often an authenticated service node's domain key is re-checked with the registry. */
  reauthIntervalMs: number;
}

const SLACK = 1024 * 1024;

export const DEFAULT_LIMITS: RelayLimits = {
  maxConnections: 4096,
  maxConnectionsPerIp: 32,
  connectBurstPerIp: 30,
  connectRefillPerSecondPerIp: 1,
  maxCircuitsPerClient: MAX_CIRCUITS_PER_CONNECTION,
  maxPendingPerClient: MAX_PENDING_OPENS,
  maxCircuitsPerService: 256,
  maxCircuitsPerClientPerService: 16,
  maxCircuitsPerIpPerService: 16,
  circuitIdleMs: 15 * 60_000,
  globalBufferLimit: 512 * 1024 * 1024,
  authBurstPerIp: 10,
  authRefillPerSecondPerIp: 0.2,
  lookupNegativeTtlMs: 30_000,
  lookupCacheMax: 4096,
  maxCircuits: 32_768,
  maxServiceNodes: 4096,
  createBurstPerIp: 128,
  createRefillPerSecondPerIp: 32,
  clientBufferLimit: MAX_CIRCUITS_PER_CONNECTION * STREAM_WINDOW_INITIAL + SLACK,
  serviceBufferLimit: 256 * STREAM_WINDOW_INITIAL + SLACK,
  handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
  createTimeoutMs: HANDSHAKE_TIMEOUT_MS,
  maxViolations: 64,
  maxTrackedIps: 65_536,
  reauthIntervalMs: 10 * 60_000,
};

/** A token bucket. Integers only; `take` never lets the count go negative. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  take(now: number): boolean {
    this.refill(now);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  /** True once the bucket is full again — the entry holds nothing worth keeping. */
  full(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.capacity;
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSecond);
  }
}

interface IpEntry {
  connections: number;
  connect: TokenBucket;
  create: TokenBucket;
  auth: TokenBucket;
}

/**
 * Per-IP connection counts and rate limits.
 *
 * An IP is held only while it has a connection open or a bucket still
 * refilling (seconds to a minute) — the "short bounded abuse window" of
 * privacy-model.md §4 — and is never written anywhere. The table is bounded:
 * when it is full of live entries a new address is refused rather than the
 * table growing.
 */
export class IpTracker {
  private readonly entries = new Map<string, IpEntry>();

  constructor(private readonly limits: RelayLimits) {}

  get size(): number {
    return this.entries.size;
  }

  /** Admit a new connection from `ip`, or say why not. */
  admit(ip: string, now: number): 'ok' | 'rate' | 'per-ip' | 'table-full' {
    let entry = this.entries.get(ip);
    if (!entry) {
      if (this.entries.size >= this.limits.maxTrackedIps) {
        this.sweep(now);
        if (this.entries.size >= this.limits.maxTrackedIps) return 'table-full';
      }
      entry = {
        connections: 0,
        connect: new TokenBucket(
          this.limits.connectBurstPerIp,
          this.limits.connectRefillPerSecondPerIp,
          now,
        ),
        create: new TokenBucket(
          this.limits.createBurstPerIp,
          this.limits.createRefillPerSecondPerIp,
          now,
        ),
        auth: new TokenBucket(
          this.limits.authBurstPerIp,
          this.limits.authRefillPerSecondPerIp,
          now,
        ),
      };
      this.entries.set(ip, entry);
    }
    if (entry.connections >= this.limits.maxConnectionsPerIp) return 'per-ip';
    if (!entry.connect.take(now)) return 'rate';
    entry.connections++;
    return 'ok';
  }

  release(ip: string): void {
    const entry = this.entries.get(ip);
    if (entry && entry.connections > 0) entry.connections--;
  }

  /** One CIRCUIT_CREATE from `ip`. */
  allowCreate(ip: string, now: number): boolean {
    const entry = this.entries.get(ip);
    return entry ? entry.create.take(now) : false;
  }

  /** One service-node AUTH from `ip`. */
  allowAuth(ip: string, now: number): boolean {
    const entry = this.entries.get(ip);
    return entry ? entry.auth.take(now) : false;
  }

  /** Drop entries with no connection whose buckets have refilled. */
  sweep(now: number): void {
    for (const [ip, entry] of this.entries) {
      if (
        entry.connections === 0 &&
        entry.connect.full(now) &&
        entry.create.full(now) &&
        entry.auth.full(now)
      ) {
        this.entries.delete(ip);
      }
    }
  }
}
