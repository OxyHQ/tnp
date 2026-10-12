/**
 * Turning an untrusted overlay block from the registry into a key the session
 * handshake will accept — or a refusal that says why.
 *
 * Audit S3: the client derived its session key from whatever `serviceNodePubKey`
 * the API returned, so the API (or anyone who could change one JSON field) read
 * every tunnel. Now, for the name the CLIENT derived from what it was asked to
 * reach:
 *
 *  1. the domain key must equal this client's pin for the name, or be reached
 *     from the pin through rotation statements signed by the pinned key; a
 *     name with no pin is pinned on first successful use (TOFU);
 *  2. the key-agreement certificate must verify against the grant chain rooted
 *     at that domain key, for exactly this name and the service-node role,
 *     within its validity window, not rolled back;
 *  3. a relay binding, when present, must be signed by the node key that
 *     chain authorizes, for this name, and be fresh. The tunnel then uses
 *     only the relay it names (tunnel.ts).
 *
 * Only then does the pin store learn anything, and only then is a
 * `VerifiedKeyAgreementKey` — the only key `ClientHandshake` accepts — returned.
 */

import {
  domainKeyFingerprint,
  followDomainKeyRotations,
  KeyAgreementRole,
  type VerifiedKeyAgreementKey,
  verifyKeyAgreementCertificate,
  verifyServiceRelayBinding,
} from '@tnp/crypto';
import {
  type DnsResolveOverlay,
  type DomainKeyReset,
  isCanonicalName,
  parseDnsResolveOverlay,
} from '@tnp/shared-types';
import { PinStore } from './pins';

export type OverlayRefusal =
  | 'not-native'
  | 'no-overlay'
  | 'malformed'
  | 'pin-mismatch'
  | 'bad-chain'
  | 'bad-binding';

export class OverlayVerificationError extends Error {
  constructor(
    readonly reason: OverlayRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'OverlayVerificationError';
  }
}

/**
 * The name a service node is registered under for a destination: the last two
 * labels (`www.example.ox` → `example.ox`). Grants, certificates and pins are
 * all for this name; the client derives it itself and never takes it from the
 * registry, so the registry cannot answer for `victim.ox` with a perfectly
 * valid chain for `attacker.ox`.
 */
export function serviceNameFor(destination: string): string {
  const name = destination.trim().toLowerCase().replace(/\.$/, '');
  const labels = name.split('.');
  const service = labels.slice(-2).join('.');
  if (labels.length < 2 || !isCanonicalName(service)) {
    throw new OverlayVerificationError('not-native', 'not a TNP service name');
  }
  return service;
}

export interface VerifiedOverlay {
  name: string;
  relay: string;
  /**
   * The relay the service node itself signed that it is attached to (node
   * key, verified), or null when the node published no binding.
   */
  relayBinding: { endpoint: string; relayKey: Uint8Array } | null;
  key: VerifiedKeyAgreementKey;
  /** True when this verification created the pin (first contact). */
  firstContact: boolean;
  /** The registry marks this name's current key as a reset after a release. */
  keyReset?: DomainKeyReset;
}

export function verifyOverlay(
  name: string,
  overlayInput: unknown,
  pins: PinStore,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifiedOverlay {
  const parsed = parseDnsResolveOverlay(overlayInput);
  if (!parsed.ok) throw new OverlayVerificationError('malformed', `overlay: ${parsed.error}`);
  const overlay: DnsResolveOverlay = parsed.value;
  if (!overlay.available) {
    throw new OverlayVerificationError('no-overlay', `${name} has no service node online`);
  }

  // The whole decision runs against the pin as it is on disk now, under the
  // pin store's lock, so a concurrent `tnp pins forget` or another process's
  // pin is never overwritten by a decision made on a stale read.
  return pins.update(name, (pin) => {
    if (pin && pin.domainKey !== overlay.domainKey) {
      const followed = followDomainKeyRotations({
        name,
        pinned: pin.domainKey,
        current: overlay.domainKey,
        rotations: overlay.rotations,
      });
      if (!followed.ok) {
        const reset =
          overlay.keyReset &&
          overlay.keyReset.previousKeyFingerprint === domainKeyFingerprint(pin.domainKey)
            ? ` The registry says ${name} was released and registered again with a new key on ` +
              `${overlay.keyReset.since}, without a signature from the key you pinned: it may now ` +
              'belong to someone else.'
            : '';
        throw new OverlayVerificationError(
          'pin-mismatch',
          `REFUSING ${name}: its domain key changed since you pinned it on ${pin.pinnedAt}, and the ` +
            `change is not signed by the key you pinned.${reset} Someone — the registry, or ` +
            'whoever can alter its answers — may be impersonating this name to read your ' +
            'traffic. Do not override this unless the owner confirms, through a channel you ' +
            `trust, that the change is theirs; then run \`tnp pins forget ${name}\`.`,
        );
      }
    }

    const verified = verifyKeyAgreementCertificate(overlay.kaCert, overlay.chain, {
      trustedRoots: [overlay.domainKey],
      role: KeyAgreementRole.SERVICE_NODE,
      name,
      now: nowSeconds,
      knownSerials: new Map(Object.entries(pin?.serials ?? {})),
    });
    if (!verified.ok) {
      throw new OverlayVerificationError(
        'bad-chain',
        `REFUSING ${name}: the service node's key does not verify against the domain key ` +
          `(${verified.reason}). The registry may be serving a substituted key.`,
      );
    }

    let relayBinding: VerifiedOverlay['relayBinding'] = null;
    if (overlay.relayBinding) {
      const bound = verifyServiceRelayBinding(
        name,
        overlay.relayBinding,
        verified.chain.subject,
        nowSeconds,
      );
      if (!bound.ok) {
        throw new OverlayVerificationError(
          'bad-binding',
          `REFUSING ${name}: the relay binding in the registry's answer is not a fresh statement ` +
            `by the service node's key (${bound.reason}). The registry may be routing you elsewhere.`,
        );
      }
      relayBinding = { endpoint: bound.endpoint, relayKey: bound.relayKey };
    }

    return {
      pin: PinStore.next(pin, overlay.domainKey, [
        ...verified.chain.serials,
        { key: verified.serialKey, serial: verified.serial },
      ]),
      result: {
        name,
        relay: overlay.relay,
        relayBinding,
        key: verified.key,
        firstContact: !pin,
        ...(overlay.keyReset ? { keyReset: overlay.keyReset } : {}),
      },
    };
  });
}
