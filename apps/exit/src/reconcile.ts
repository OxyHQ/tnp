/**
 * Peer reconciliation: the pure half of the exit agent.
 *
 * Desired state comes from `GET /exit/peers` (already validated by
 * `parseExitPeersResponse`); actual state from `wg show <iface> allowed-ips`.
 * The plan is the smallest set of `wg set` operations that turns one into the
 * other, and the commands are argument arrays — handed to `execFile`, never a
 * shell — built only from values that passed validation here.
 */

import type { ExitPeer } from '@tnp/shared-types';

/** A WireGuard public key as `wg` prints it. Base64 has no `-`, so none can read as an option. */
const KEY_RE = /^[A-Za-z0-9+/]{43}=$/;
const IFACE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,14}$/;
const PREFIX_RE = /^[0-9a-f.:]+\/[0-9]{1,3}$/;
/** Peers per `wg set` invocation: bounds the argument list. */
export const PEERS_PER_COMMAND = 100;

export type PeerChange =
  | { kind: 'set'; publicKey: string; allowedIps: string[] }
  | { kind: 'remove'; publicKey: string };

/** Actual peers: public key → its allowed IPs, sorted. */
export type ActualPeers = Map<string, string[]>;

export class WgOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WgOutputError';
  }
}

/**
 * Parse `wg show <iface> allowed-ips`: one line per peer, the key, a tab, then
 * space-separated prefixes or `(none)`. Anything else is an error — the agent
 * then changes nothing this round rather than acting on a misread state.
 */
export function parseWgAllowedIps(output: string): ActualPeers {
  const peers: ActualPeers = new Map();
  for (const line of output.split('\n')) {
    if (line.trim() === '') continue;
    // `wg` prints a tab after the key and spaces between prefixes; any run of
    // whitespace is accepted so a formatting change cannot stall every sync.
    const match = /^([A-Za-z0-9+/]{43}=)\s+(\S.*)$/.exec(line.trimEnd());
    if (!match || peers.has(match[1])) {
      throw new WgOutputError('unexpected line in wg allowed-ips output');
    }
    const ips = match[2] === '(none)' ? [] : match[2].split(/\s+/);
    if (!ips.every((ip) => PREFIX_RE.test(ip))) {
      throw new WgOutputError('unexpected prefix in wg allowed-ips output');
    }
    peers.set(match[1], ips.sort());
  }
  return peers;
}

/** The allowed IPs a desired peer must have: exactly its two host addresses. */
export function allowedIpsFor(peer: ExitPeer): string[] {
  return [`${peer.ipv4}/32`, `${peer.ipv6}/128`].sort();
}

/**
 * Removals first — freeing an address before another key claims it — then
 * every peer that is missing or whose allowed IPs differ. A peer already
 * right is left alone: re-setting it would be harmless but noisy.
 */
export function planPeerChanges(desired: readonly ExitPeer[], actual: ActualPeers): PeerChange[] {
  const wanted = new Map(desired.map((peer) => [peer.publicKey, allowedIpsFor(peer)]));
  const changes: PeerChange[] = [];
  for (const key of [...actual.keys()].sort()) {
    if (!wanted.has(key)) changes.push({ kind: 'remove', publicKey: key });
  }
  for (const [key, ips] of [...wanted.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const current = actual.get(key);
    if (!current || current.join(',') !== ips.join(',')) {
      changes.push({ kind: 'set', publicKey: key, allowedIps: ips });
    }
  }
  return changes;
}

/**
 * The `wg` argument lists for a plan: `set <iface> peer <key> remove|allowed-ips <list> …`,
 * at most `PEERS_PER_COMMAND` peers each. Throws on any value that is not a
 * key, an interface name or a prefix list of the expected shape.
 */
export function wgSetCommands(iface: string, changes: readonly PeerChange[]): string[][] {
  if (!IFACE_RE.test(iface)) throw new RangeError('invalid interface name');
  const commands: string[][] = [];
  for (let i = 0; i < changes.length; i += PEERS_PER_COMMAND) {
    const args = ['set', iface];
    for (const change of changes.slice(i, i + PEERS_PER_COMMAND)) {
      if (!KEY_RE.test(change.publicKey)) throw new RangeError('invalid public key');
      if (change.kind === 'remove') {
        args.push('peer', change.publicKey, 'remove');
      } else {
        if (
          change.allowedIps.length === 0 ||
          !change.allowedIps.every((ip) => PREFIX_RE.test(ip))
        ) {
          throw new RangeError('invalid allowed IPs');
        }
        args.push('peer', change.publicKey, 'allowed-ips', change.allowedIps.join(','));
      }
    }
    commands.push(args);
  }
  return commands;
}
