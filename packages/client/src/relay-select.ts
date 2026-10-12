/**
 * Which relays `tnp serve` attaches to.
 *
 * A relay is selectable only through the SIGNED relay directory
 * (relay-directory.ts; docs/architecture/relays.md §8, blocker 6). Within it:
 *
 * - Automatically, only Oxy-operated relays are chosen. A community relay
 *   sees the node's address, which domain it serves, and when and how much it
 *   is reached, so attaching to one is a decision for the person running the
 *   node, made with `--relay`, never something the directory decides for
 *   them. Oxy relays are ordered by measured latency (a connection plus the
 *   relay's identity proof); the node fails over down the list.
 * - With `--relay <url>`: if the URL is in the directory, the relay must prove
 *   the directory's key for it. If it is not, the operator's explicit choice
 *   is honoured with a loud warning — the relay cannot be authenticated, and
 *   clients will refuse it anyway, since they only use listed relays.
 */

import { decodeBase64Strict, encodeBase64 } from '@tnp/crypto';
import {
  normalizeRelayEndpoint,
  publicRelayEndpointProblem,
  RelayCapability,
} from '@tnp/shared-types';
import type { VerifiedRelayDirectory } from './relay-directory';
import type { RelayCandidate } from './service-node';

export type { RelayCandidate } from './service-node';

export type RelaySelection =
  | {
      ok: true;
      candidates: RelayCandidate[];
      /**
       * Re-run the same selection against a fresh directory (the service node
       * calls it periodically and leaves relays no longer listed). Absent when
       * the relay did not come from the directory at all.
       */
      refresh?: () => Promise<RelayCandidate[]>;
    }
  | { ok: false; message: string };

export const NO_AUTOMATIC_RELAY_MESSAGE =
  'no Oxy-operated relay is available in the signed relay directory. Community relays are ' +
  'never selected automatically: anyone can run one, and the relay a service node uses sees ' +
  'its address, its domain and when it is reached. Choose a relay you trust with --relay wss://<relay>.';

/** Round-trip time to a relay including its identity proof (ms), or null when unusable. */
export type RelayProbe = (endpoint: string, relayKey: Uint8Array) => Promise<number | null>;

/**
 * Oxy-operated relays from a verified directory that serve service nodes,
 * fastest first; relays that failed the probe go last (in directory order),
 * still as fail-over candidates.
 */
export async function selectAutomaticRelays(
  directory: VerifiedRelayDirectory,
  probe: RelayProbe,
): Promise<RelaySelection> {
  const oxy = directory.relays.filter(
    (r) => r.operator === 'oxy' && r.capabilities.includes(RelayCapability.SERVICE),
  );
  if (oxy.length === 0) return { ok: false, message: NO_AUTOMATIC_RELAY_MESSAGE };
  const timed = await Promise.all(
    oxy.map(async (relay, index) => ({
      relay,
      index,
      ms: await probe(relay.endpoint, relay.key).catch(() => null),
    })),
  );
  timed.sort((a, b) => {
    if (a.ms !== null && b.ms !== null) return a.ms - b.ms || a.index - b.index;
    if (a.ms !== null) return -1;
    if (b.ms !== null) return 1;
    return a.index - b.index;
  });
  return {
    ok: true,
    candidates: timed.map(({ relay }) => ({ endpoint: relay.endpoint, relayKey: relay.key })),
  };
}

export type ExplicitRelay =
  | { ok: true; candidate: RelayCandidate; warning: string | null }
  | { ok: false; message: string };

/**
 * Resolve `--relay <url>` (and optional `--relay-key <base64>`) against the
 * directory, when there is one. The directory wins: a `--relay-key` that
 * disagrees with the directory's key for the same URL is refused.
 */
export function resolveExplicitRelay(
  url: string,
  directory: VerifiedRelayDirectory | null,
  relayKeyBase64: string | null,
): ExplicitRelay {
  const endpoint = normalizeRelayEndpoint(url);
  if (!endpoint) {
    return { ok: false, message: `--relay ${JSON.stringify(url)} is not a ws:// or wss:// URL` };
  }
  let given: Uint8Array | null = null;
  if (relayKeyBase64 !== null) {
    try {
      given = decodeBase64Strict(relayKeyBase64.trim(), 32);
    } catch {
      return { ok: false, message: '--relay-key must be canonical base64 of a 32-byte key' };
    }
  }
  const listed = directory?.relays.find(
    (r) => r.endpoint === endpoint && r.capabilities.includes(RelayCapability.SERVICE),
  );
  if (listed) {
    if (given && encodeBase64(given) !== listed.relayKey) {
      return {
        ok: false,
        message: `--relay-key does not match the key the signed directory lists for ${endpoint}`,
      };
    }
    return { ok: true, candidate: { endpoint, relayKey: listed.key }, warning: null };
  }
  const unlisted =
    `${endpoint} is NOT in the signed relay directory` +
    (directory ? '' : ' (no verified directory could be obtained)') +
    '. Clients only use relays the signed directory lists, so they will refuse to reach ' +
    'this service through it.';
  if (given) {
    return {
      ok: true,
      candidate: { endpoint, relayKey: given },
      warning: `${unlisted} The relay must prove the key you gave with --relay-key.`,
    };
  }
  const plaintext = publicRelayEndpointProblem(endpoint) !== null;
  return {
    ok: true,
    candidate: { endpoint, relayKey: null },
    warning:
      `${unlisted} Its identity CANNOT be verified: whoever answers at that URL receives this ` +
      'node’s connection, domain and grant chain.' +
      (plaintext ? ' It is also not a public wss:// endpoint.' : '') +
      ' Pass --relay-key <base64> to require the relay to prove a key.',
  };
}

/**
 * `tnp serve`'s choice of relays, from the flags and the signed directory.
 * Returns the candidates in preference order, or a message saying why there
 * are none. Warnings are passed to `warn` — they are the operator's to see.
 */
export async function chooseServiceRelays(params: {
  relayFlag: string | null;
  relayKeyFlag: string | null;
  /**
   * `--allow-unverified-relay`: the operator accepts a relay whose identity
   * cannot be checked at all (not in a verified directory, no `--relay-key`).
   * Without it such a relay is refused — otherwise blocking the API would
   * silently downgrade `--relay` to no relay authentication.
   */
  allowUnverified?: boolean;
  directory: () => Promise<VerifiedRelayDirectory>;
  probe: RelayProbe;
  warn: (message: string) => void;
}): Promise<RelaySelection> {
  let directory: VerifiedRelayDirectory | null = null;
  let directoryProblem: string | null = null;
  try {
    directory = await params.directory();
  } catch (err) {
    directoryProblem = err instanceof Error ? err.message : String(err);
  }

  if (params.relayFlag) {
    if (directoryProblem) params.warn(directoryProblem);
    const explicit = resolveExplicitRelay(params.relayFlag, directory, params.relayKeyFlag);
    if (!explicit.ok) return explicit;
    if (explicit.candidate.relayKey === null && !params.allowUnverified) {
      return {
        ok: false,
        message:
          `refusing ${explicit.candidate.endpoint}: its identity cannot be verified — it is not in a ` +
          'verified signed relay directory' +
          (directoryProblem ? ` (${directoryProblem})` : '') +
          ' and no --relay-key was given. Pass --relay-key <base64> to require a key, or ' +
          '--allow-unverified-relay to accept whoever answers at that URL.',
      };
    }
    if (explicit.warning) params.warn(`WARNING: ${explicit.warning}`);
    const flag = params.relayFlag;
    const fromDirectory = explicit.warning === null;
    return {
      ok: true,
      candidates: [explicit.candidate],
      ...(fromDirectory
        ? {
            refresh: async () => {
              const again = resolveExplicitRelay(
                flag,
                await params.directory(),
                params.relayKeyFlag,
              );
              return again.ok && again.warning === null ? [again.candidate] : [];
            },
          }
        : {}),
    };
  }
  if (!directory) {
    return {
      ok: false,
      message: `${directoryProblem ?? 'no verified relay directory'}. No relay is selected without a verified signed directory.`,
    };
  }
  const selected = await selectAutomaticRelays(directory, params.probe);
  if (!selected.ok) return selected;
  return {
    ...selected,
    refresh: async () => {
      const again = await selectAutomaticRelays(await params.directory(), params.probe);
      return again.ok ? again.candidates : [];
    },
  };
}
