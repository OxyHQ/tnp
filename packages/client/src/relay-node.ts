/**
 * The relay embedded in the `tnp` binary (`tnp relay`).
 *
 * Routing, authentication and every bound come from `@tnp/relay-core`, the
 * same code `apps/relay` runs. This file only adds what a community relay run
 * from the binary needs on top: registering with the relay directory and
 * heartbeating.
 *
 * It used to carry its own copy of the routing — global client-chosen circuit
 * ids, unauthenticated `/service?domain=` with eviction, no bounds — with the
 * same bugs as `apps/relay`, so a fix to one was not a fix (audit S1, S2, S6).
 */

import {
  apiDomainKeyLookup,
  type DomainKeyLookup,
  RelayCore,
  type RelayServer,
  serveRelay,
} from '@tnp/relay-core';
import {
  normalizeRelayEndpoint,
  parseRegisterRelayRequest,
  type RegisterRelayRequest,
} from '@tnp/shared-types';
import type { TnpApiClient } from './api';
import { loadOrCreateIdentity, toBase64 } from './crypto';

export interface RelayNodeStats {
  serviceNodes: number;
  activeCircuits: number;
  totalConnections: number;
  bytesRelayed: number;
  uptimeSeconds: number;
}

export interface RelayNodeConfig {
  port: number;
  host: string;
  /**
   * The public `ws://` or `wss://` URL other people's clients dial.
   *
   * Not derivable from `host`/`port`: those are the bind address, which is
   * `0.0.0.0` by default and says nothing about the name, port or TLS
   * termination the relay is actually reachable through. The registry
   * publishes this value verbatim in the directory, and service nodes sign
   * it when they authenticate, so guessing it would make both fail.
   */
  endpoint: string;
  maxConnections: number;
  /** Advertised bandwidth ceiling in Mbit/s. 0 means the operator states none. */
  bandwidth: number;
  authToken: string;
  location: string;
  apiBaseUrl: string;
  identityKeyPath: string;
  /** Override the registry lookup of domain keys (tests). */
  lookupDomainKey?: DomainKeyLookup;
}

/** How often a registered relay tells the registry it is still serving. */
const HEARTBEAT_INTERVAL_MS = 30_000;

export class RelayNode {
  private relay: RelayServer | null = null;
  private core: RelayCore | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;
  /** Canonical endpoint the registry accepted, and the key the heartbeat uses. */
  private registeredEndpoint: string | null = null;
  private running = false;

  constructor(private config: RelayNodeConfig) {}

  get isRunning(): boolean {
    return this.running;
  }

  /** The bound port (useful when configured with port 0). */
  get port(): number {
    return this.relay?.port ?? this.config.port;
  }

  getStats(): RelayNodeStats {
    const s = this.core?.stats();
    return {
      serviceNodes: s?.serviceNodes ?? 0,
      activeCircuits: s?.circuits ?? 0,
      totalConnections: s?.connections ?? 0,
      bytesRelayed: s?.bytesForwarded ?? 0,
      uptimeSeconds: this.startTime > 0 ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
    };
  }

  private publicEndpoint(): string {
    const endpoint = normalizeRelayEndpoint(this.config.endpoint);
    if (endpoint === null) {
      throw new Error(
        `Cannot register relay: endpoint ${JSON.stringify(this.config.endpoint)} is not a ws:// or wss:// URL. ` +
          'Set the public URL clients dial, e.g. --endpoint wss://relay.example.com',
      );
    }
    return endpoint;
  }

  /**
   * Build this relay's registration request.
   *
   * Separate from `start` so the request can be validated — and rejected —
   * before the listener binds a port. It is typed as the API's own contract
   * and then run through the API's own parser, so a field this relay stops
   * sending is a typecheck failure and a value the registry would refuse is a
   * local error naming the field, not a 400 from a round trip.
   */
  private buildRegistration(): RegisterRelayRequest {
    const endpoint = this.publicEndpoint();
    const identity = loadOrCreateIdentity(this.config.identityKeyPath);

    const request: RegisterRelayRequest = {
      endpoint,
      publicKey: toBase64(identity.publicKey),
      // No `operator`: the registry decides whether a relay is Oxy-operated,
      // from the account that registers it, and never takes a relay's word.
      capacity: {
        maxConnections: this.config.maxConnections,
        bandwidth: this.config.bandwidth,
      },
      location: this.config.location,
    };

    const parsed = parseRegisterRelayRequest(request);
    if (!parsed.ok) {
      throw new Error(`Cannot register relay: ${parsed.error}`);
    }
    return parsed.value;
  }

  async start(apiClient: TnpApiClient): Promise<void> {
    if (this.running) {
      throw new Error('Relay node is already running');
    }
    // A private relay (no token) may omit its endpoint; service nodes then
    // authenticate against the bind address and must dial exactly that URL.
    const endpoint =
      !this.config.authToken && !this.config.endpoint
        ? `ws://${this.config.host}:${this.config.port}`
        : this.publicEndpoint();

    // Register with the API before binding anything. A relay that cannot be
    // published is not a relay anyone can reach, and failing here leaves the
    // node stopped rather than listening-but-invisible.
    if (this.config.authToken) {
      const request = this.buildRegistration();
      try {
        const registration = await apiClient.registerRelay(request, this.config.authToken);
        this.registeredEndpoint = registration.endpoint;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to register relay: ${msg}`);
      }
    }

    this.core = new RelayCore({
      endpoint: normalizeRelayEndpoint(endpoint) ?? endpoint,
      lookupDomainKey: this.config.lookupDomainKey ?? apiDomainKeyLookup(this.config.apiBaseUrl),
      limits: { maxConnections: Math.max(1, this.config.maxConnections) },
    });
    this.relay = serveRelay({
      core: this.core,
      hostname: this.config.host,
      port: this.config.port,
      serviceName: 'tnp-relay-node',
    });
    this.startTime = Date.now();
    this.running = true;

    const registeredEndpoint = this.registeredEndpoint;
    if (registeredEndpoint && this.config.authToken) {
      this.heartbeatTimer = setInterval(() => {
        apiClient
          .sendRelayHeartbeat(registeredEndpoint, this.config.authToken)
          .catch((err: unknown) => {
            // A missed heartbeat is not fatal — the registry degrades the relay
            // and it recovers on the next one — but a run of them means the
            // relay is quietly dropping out of the directory, so say so.
            console.warn(
              `[relay] heartbeat failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }, HEARTBEAT_INTERVAL_MS);
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    const relay = this.relay;
    this.relay = null;
    this.core = null;
    this.running = false;
    this.registeredEndpoint = null;
    if (relay) await relay.stop();
  }
}
