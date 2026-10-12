/**
 * Which relay `tnp serve` uses when the operator did not name one.
 *
 * Only an Oxy-operated relay is ever chosen automatically. A community relay
 * can be registered by any Oxy account, and the relay a service node attaches
 * to sees the node's address, which domain it serves, and when and how much it
 * is reached — so attaching to one is a decision for the person running the
 * node, made with `--relay`, never something the directory's first entry
 * decides for them. Before this, `tnp serve` took the first listed relay,
 * which any account could arrange to be its own.
 *
 * The directory is not signed yet (docs/architecture/relays.md §7), so this
 * trusts the registry's `operator` field; the registry now decides that field
 * itself instead of believing the relay.
 */

import {
  normalizeRelayEndpoint,
  publicRelayEndpointProblem,
  type RelayDirectoryEntry,
} from '@tnp/shared-types';

export type RelaySelection = { ok: true; endpoint: string } | { ok: false; message: string };

export const NO_AUTOMATIC_RELAY_MESSAGE =
  'no Oxy-operated relay is available. Community relays are never selected automatically: ' +
  'anyone can run one, and the relay a service node uses sees its address, its domain and ' +
  'when it is reached. Choose a relay you trust with --relay wss://<relay>.';

export function selectAutomaticRelay(directory: readonly RelayDirectoryEntry[]): RelaySelection {
  for (const entry of directory) {
    if (entry.operator !== 'oxy') continue;
    const endpoint = normalizeRelayEndpoint(entry.endpoint);
    // The registry refuses these now; an older registry did not, so check here too.
    if (endpoint === null || publicRelayEndpointProblem(endpoint) !== null) continue;
    return { ok: true, endpoint };
  }
  return { ok: false, message: NO_AUTOMATIC_RELAY_MESSAGE };
}
