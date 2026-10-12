/**
 * The standalone relay's configuration, from the environment. Pure, so the
 * rules are tested without starting anything (config.test.ts), and so
 * `--check-config` can validate a task definition without binding a port.
 *
 *   RELAY_ENDPOINT   required: the public URL clients and service nodes dial.
 *                    The relay signs it in every identity proof, and service
 *                    nodes sign it when they authenticate, so it must be
 *                    exactly the URL in the signed directory (`TNP_OXY_RELAYS`
 *                    on the API). In production it must be wss:// on a public
 *                    host.
 *   RELAY_KEY_SEED   required: base64 of the relay key's 32-byte Ed25519 seed
 *                    (SSM SecureString in production). Its public half is the
 *                    `relayKey` the directory lists; a stable seed is what
 *                    keeps the relay's identity across restarts. Derive the
 *                    public key with `bun scripts/relay-key.ts`.
 *   TNP_API_URL      registry the domain keys are read from (default
 *                    https://api.tnp.network)
 *   RELAY_HOST / RELAY_PORT   bind address (default 0.0.0.0:8080)
 *   RELAY_TRUST_FORWARDED_FOR=1   take client addresses from the load
 *                    balancer's X-Forwarded-For (only behind one)
 */

import { encodeBase64, signingKeyPairFromSeedBase64 } from '@tnp/crypto';
import { normalizeRelayEndpoint, publicRelayEndpointProblem } from '@tnp/shared-types';

export interface RelayConfig {
  endpoint: string;
  identity: { publicKey: Uint8Array; secretKey: Uint8Array };
  /** The relay key, base64: what `TNP_OXY_RELAYS` must list for `endpoint`. */
  relayKey: string;
  apiUrl: string;
  host: string;
  port: number;
  trustForwardedFor: boolean;
}

export type RelayConfigResult = { ok: true; config: RelayConfig } | { ok: false; errors: string[] };

export function loadRelayConfig(env: Record<string, string | undefined>): RelayConfigResult {
  const errors: string[] = [];
  const production = env.NODE_ENV === 'production';

  const endpoint = normalizeRelayEndpoint(env.RELAY_ENDPOINT ?? '');
  if (!endpoint) {
    errors.push('RELAY_ENDPOINT must be the public ws:// or wss:// URL of this relay');
  } else if (production) {
    const problem = publicRelayEndpointProblem(endpoint);
    if (problem) errors.push(`RELAY_ENDPOINT: ${problem}`);
  }

  let identity: RelayConfig['identity'] | null = null;
  const seed = env.RELAY_KEY_SEED?.trim() ?? '';
  if (!seed) {
    errors.push(
      'RELAY_KEY_SEED is required: base64 of the relay key’s 32-byte Ed25519 seed ' +
        '(its public half is the relayKey the signed directory lists for RELAY_ENDPOINT)',
    );
  } else {
    try {
      identity = signingKeyPairFromSeedBase64(seed);
    } catch {
      // Never echo the value: it is the relay's private key.
      errors.push('RELAY_KEY_SEED is not canonical base64 of 32 bytes');
    }
  }

  const rawPort = env.RELAY_PORT?.trim();
  const port = rawPort ? Number(rawPort) : 8080;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    errors.push('RELAY_PORT must be an integer from 0 to 65535');
  }

  if (errors.length > 0 || !endpoint || !identity) return { ok: false, errors };
  return {
    ok: true,
    config: {
      endpoint,
      identity,
      relayKey: encodeBase64(identity.publicKey),
      apiUrl: env.TNP_API_URL?.trim() || 'https://api.tnp.network',
      host: env.RELAY_HOST?.trim() || '0.0.0.0',
      port,
      trustForwardedFor: env.RELAY_TRUST_FORWARDED_FOR === '1',
    },
  };
}
