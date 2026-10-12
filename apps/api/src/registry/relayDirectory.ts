/**
 * The signed relay directory (`GET /relays/directory`): which relays are
 * listed, and the key that signs the list.
 *
 * Normative: docs/architecture/discovery.md §2 and relays.md §8.
 *
 * - **Oxy-operated relays** come from `TNP_OXY_RELAYS`, a JSON list of
 *   `{endpoint, relayKey, region}` in the API's own configuration. They need
 *   no Oxy account token to be listed, and no registry row can make a relay
 *   `oxy`: that is decided only here.
 * - **Community relays** come from the registry: heartbeat-fresh, `wss://` on
 *   a public host, AND recently proven to hold the private half of the key
 *   they publish (registry/relays.ts). They are always `community`.
 * - **The signing key** is `TNP_DIRECTORY_SIGNING_SEED` (base64 32-byte Ed25519
 *   seed; SSM SecureString in production). Without it there is no directory:
 *   the route answers 503. There is never an unsigned fallback — a client
 *   accepting one would turn a detected attack into a successful one.
 *
 * The API holding the key means a compromised API can sign a directory. The
 * signature protects against network tampering, database tampering and
 * stale or rolled-back directories; it is not a defence against the API
 * itself (relays.md §8 says exactly what is and is not guaranteed).
 */

import {
  encodeBase64,
  MAX_DIRECTORY_RELAYS,
  parsePublicKey,
  type DirectoryRelay,
  type SignedRelayDirectory,
  signingKeyPairFromSeedBase64,
  signRelayDirectory,
} from '@tnp/crypto';
import {
  normalizeRelayEndpoint,
  publicRelayEndpointProblem,
  RELAY_DIRECTORY_LIFETIME_SECONDS,
  RELAY_DIRECTORY_SIGNING_KEYS_BASE64,
  RelayCapability,
} from '@tnp/shared-types';

/** One Oxy-operated relay from `TNP_OXY_RELAYS`. */
export interface OxyRelayConfig {
  endpoint: string;
  /** Canonical base64 of the relay's 32-byte Ed25519 key (`RELAY_KEY_SEED`'s public half). */
  relayKey: string;
  region: string;
}

/** A community relay as the registry hands it over. */
export interface CommunityRelayRow {
  endpoint: string;
  publicKey: string;
  location: string;
}

const MAX_REGION = 64;
const PRINTABLE = /^[\x20-\x7e]*$/;
const ALL_CAPABILITIES = [RelayCapability.SERVICE, RelayCapability.TUNNEL];

/**
 * Parse `TNP_OXY_RELAYS`. Strict: one bad entry rejects the whole value, with
 * a message naming the entry — a half-applied relay list is how an operator
 * ends up thinking a relay is listed when it is not.
 */
export function parseOxyRelays(
  raw: string | undefined,
): { ok: true; relays: OxyRelayConfig[] } | { ok: false; error: string } {
  const text = raw?.trim() ?? '';
  if (text === '') return { ok: true, relays: [] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'TNP_OXY_RELAYS is not valid JSON' };
  }
  if (!Array.isArray(value)) return { ok: false, error: 'TNP_OXY_RELAYS must be a JSON array' };
  const relays: OxyRelayConfig[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of value.entries()) {
    const where = `TNP_OXY_RELAYS[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `${where} must be an object` };
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (key !== 'endpoint' && key !== 'relayKey' && key !== 'region') {
        return { ok: false, error: `${where} has an unexpected field ${JSON.stringify(key)}` };
      }
    }
    const endpoint = typeof e.endpoint === 'string' ? normalizeRelayEndpoint(e.endpoint) : null;
    if (endpoint === null || publicRelayEndpointProblem(endpoint) !== null) {
      return { ok: false, error: `${where}.endpoint must be a public wss:// URL` };
    }
    if (seen.has(endpoint)) return { ok: false, error: `${where}.endpoint is listed twice` };
    seen.add(endpoint);
    let relayKey: string;
    try {
      relayKey = encodeBase64(parsePublicKey(e.relayKey as string));
    } catch {
      return { ok: false, error: `${where}.relayKey must be canonical base64 of 32 bytes` };
    }
    const region = e.region ?? '';
    if (typeof region !== 'string' || region.length > MAX_REGION || !PRINTABLE.test(region)) {
      return { ok: false, error: `${where}.region must be printable ASCII, at most 64 characters` };
    }
    relays.push({ endpoint, relayKey, region });
  }
  return { ok: true, relays };
}

/** Signs directories. Holds the secret in memory only. */
export interface DirectorySigner {
  readonly publicKey: Uint8Array;
  sign(directory: Parameters<typeof signRelayDirectory>[0]): SignedRelayDirectory;
}

/**
 * The signer for `TNP_DIRECTORY_SIGNING_SEED`, or null with the reason. The
 * reason never contains the seed.
 */
export function directorySignerFromSeed(
  seed: string | undefined,
): { signer: DirectorySigner; pinned: boolean } | { signer: null; problem: string } {
  if (!seed?.trim()) {
    return {
      signer: null,
      problem: 'TNP_DIRECTORY_SIGNING_SEED is not set — GET /relays/directory answers 503',
    };
  }
  let keyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
  try {
    keyPair = signingKeyPairFromSeedBase64(seed);
  } catch {
    return {
      signer: null,
      problem:
        'TNP_DIRECTORY_SIGNING_SEED is not canonical base64 of 32 bytes — GET /relays/directory answers 503',
    };
  }
  const { publicKey, secretKey } = keyPair;
  const pinned = RELAY_DIRECTORY_SIGNING_KEYS_BASE64.includes(encodeBase64(publicKey));
  return {
    signer: {
      publicKey,
      sign: (directory) => signRelayDirectory(directory, secretKey),
    },
    pinned,
  };
}

/** The relay entries a directory lists: configured Oxy relays first, then proven community relays. */
export function directoryRelays(
  oxyRelays: readonly OxyRelayConfig[],
  community: readonly CommunityRelayRow[],
): DirectoryRelay[] {
  const out: DirectoryRelay[] = oxyRelays.slice(0, MAX_DIRECTORY_RELAYS).map((relay) => ({
    endpoint: relay.endpoint,
    relayKey: relay.relayKey,
    operator: 'oxy',
    capabilities: [...ALL_CAPABILITIES],
    region: relay.region,
  }));
  const seen = new Set(out.map((relay) => relay.endpoint));
  for (const row of community) {
    // The registry enforces all of this on the way in; rows written before it
    // did are checked again rather than signed as they are.
    const endpoint = normalizeRelayEndpoint(row.endpoint);
    if (endpoint === null || endpoint !== row.endpoint) continue;
    if (publicRelayEndpointProblem(endpoint) !== null || seen.has(endpoint)) continue;
    let relayKey: string;
    try {
      relayKey = encodeBase64(parsePublicKey(row.publicKey));
    } catch {
      continue;
    }
    if (relayKey !== row.publicKey) continue;
    const region =
      row.location.length <= MAX_REGION && PRINTABLE.test(row.location) ? row.location : '';
    seen.add(endpoint);
    out.push({
      endpoint,
      relayKey,
      operator: 'community',
      capabilities: [...ALL_CAPABILITIES],
      region,
    });
    if (out.length >= MAX_DIRECTORY_RELAYS) break;
  }
  return out;
}

export interface RelayDirectoryServiceOptions {
  signer: DirectorySigner;
  oxyRelays: readonly OxyRelayConfig[];
  /** Proven, fresh community relays. A failure degrades to the Oxy relays only. */
  listCommunity: () => Promise<CommunityRelayRow[]>;
  /** Milliseconds. */
  clock?: () => number;
  /** How long one signed document is served before it is re-signed. */
  cacheSeconds?: number;
  lifetimeSeconds?: number;
  onError?: (err: unknown) => void;
}

/**
 * Signs the directory at request time, caching each document briefly.
 *
 * The serial is the signing time in Unix seconds (and equals `issuedAt`),
 * never below the previous one this process signed. Several API tasks sign independently; their
 * clocks agree to well under the cache window, and a client that receives a
 * slightly older serial than one it already holds keeps the one it holds
 * (packages/client/src/relay-directory.ts) rather than failing.
 */
export class RelayDirectoryService {
  private cached: { document: SignedRelayDirectory; until: number } | null = null;
  private inFlight: Promise<SignedRelayDirectory> | null = null;
  private lastSerial = 0;
  private readonly clock: () => number;

  constructor(private readonly options: RelayDirectoryServiceOptions) {
    this.clock = options.clock ?? Date.now;
  }

  async current(): Promise<SignedRelayDirectory> {
    const nowMs = this.clock();
    if (this.cached && nowMs < this.cached.until) return this.cached.document;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.build().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async build(): Promise<SignedRelayDirectory> {
    let community: CommunityRelayRow[] = [];
    let degraded = false;
    try {
      community = await this.options.listCommunity();
    } catch (err) {
      // The Oxy relays come from configuration and are still right; serving
      // them keeps discovery up while the database is not.
      degraded = true;
      this.options.onError?.(err);
    }
    const nowMs = this.clock();
    // serial == issuedAt (the verifier requires serial <= issuedAt), never
    // below what this process signed before, even if the clock steps back.
    const issuedAt = Math.max(Math.floor(nowMs / 1000), this.lastSerial);
    const serial = issuedAt;
    this.lastSerial = serial;
    const document = this.options.signer.sign({
      v: 1,
      serial,
      issuedAt,
      expiresAt: issuedAt + (this.options.lifetimeSeconds ?? RELAY_DIRECTORY_LIFETIME_SECONDS),
      relays: directoryRelays(this.options.oxyRelays, community),
    });
    // A degraded document is served but not cached, so the next request
    // tries the registry again.
    this.cached = degraded
      ? null
      : { document, until: nowMs + (this.options.cacheSeconds ?? 60) * 1000 };
    return document;
  }
}
