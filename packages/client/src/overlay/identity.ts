/**
 * Keys a service node and a domain owner hold, and the statements they sign.
 *
 *   domain key (Ed25519)   generated on the owner's device by the first
 *                          `tnp serve` / `tnp domain key init`; its public half
 *                          is registered with the registry once. It is the
 *                          root: there is no Oxy key above it.
 *        │ grant: purpose service-node, scope = the name, 30 days
 *        ▼
 *   node key (Ed25519)     one per service node per name, persistent
 *        │ key-agreement certificate, at most 7 days, renewed by the node
 *        ▼
 *   X25519 key             what clients run the Noise handshake against
 *
 * The registry never sees a secret and cannot mint any of these. What it can
 * still do is lie on FIRST contact (a client that has never pinned the name
 * trusts the domain key it is shown) — see threat-model.md.
 */

import {
  decodeBase64Strict,
  encodeBase64,
  type Grant,
  GrantPurpose,
  generateSigningKeyPair,
  type KeyAgreementCertificate,
  KeyAgreementRole,
  MAX_KEY_AGREEMENT_LIFETIME,
  signDomainKeyRotation,
  signGrant,
  signingKeyPairFromSecret,
  signKeyAgreementCertificate,
  type DomainKeyRotation,
  verifyChain,
} from '@tnp/crypto';
import { generateX25519KeyPair, type X25519KeyPair } from '@tnp/crypto/primitives';
import { parseChainShape } from '@tnp/shared-types';
import type { OverlayStore, StoreArea } from './store';

export interface SigningKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

const DAY = 86_400;
/** Self-issued node grants last this long and are renewed when less than RENEW_GRANT_BEFORE remains. */
export const NODE_GRANT_LIFETIME = 30 * DAY;
export const RENEW_GRANT_BEFORE = 7 * DAY;
/** A key-agreement certificate is replaced when less than this remains. */
export const RENEW_CERT_BEFORE = 4 * DAY;
/** Clock-skew allowance on notBefore. */
const SKEW = 60;

export function loadKeyPair(
  store: OverlayStore,
  area: StoreArea,
  name: string,
): SigningKeyPair | null {
  const path = store.pathFor(area, name);
  const raw = store.readPrivate(path);
  if (raw === null) {
    if (store.exists(`${path}.pending`)) {
      throw new Error(
        `a domain key rotation for ${name} was interrupted: ${path}.pending holds the key the ` +
          `registry may now have. Check \`tnp domain key show ${name}\`; if it matches, rename ` +
          `${path}.pending to ${path}.`,
      );
    }
    return null;
  }
  let parsed: { secretKey?: unknown };
  try {
    parsed = JSON.parse(raw) as { secretKey?: unknown };
  } catch {
    throw new Error(`${store.pathFor(area, name)} is not a key file`);
  }
  if (typeof parsed.secretKey !== 'string')
    throw new Error(`${store.pathFor(area, name)} is not a key file`);
  return signingKeyPairFromSecret(decodeBase64Strict(parsed.secretKey, 64));
}

export function saveKeyPair(
  store: OverlayStore,
  area: StoreArea,
  name: string,
  kp: SigningKeyPair,
): void {
  store.writePrivate(
    store.pathFor(area, name),
    `${JSON.stringify({ publicKey: encodeBase64(kp.publicKey), secretKey: encodeBase64(kp.secretKey) }, null, 2)}\n`,
  );
}

export function loadOrCreateNodeKey(store: OverlayStore, name: string): SigningKeyPair {
  const existing = loadKeyPair(store, 'node-keys', name);
  if (existing) return existing;
  const kp = generateSigningKeyPair();
  saveKeyPair(store, 'node-keys', name, kp);
  return kp;
}

/** Create the domain key for `name`. Refuses to overwrite one: that would lose the root. */
export function createDomainKey(store: OverlayStore, name: string): SigningKeyPair {
  if (store.exists(store.pathFor('domain-keys', name))) {
    throw new Error(
      `a domain key for ${name} already exists at ${store.pathFor('domain-keys', name)}`,
    );
  }
  const kp = generateSigningKeyPair();
  saveKeyPair(store, 'domain-keys', name, kp);
  return kp;
}

/** The domain key authorizes a node key for `service-node` on exactly `name`. */
export function issueNodeGrant(
  domainKey: SigningKeyPair,
  nodePublicKey: Uint8Array,
  name: string,
  now: number,
  lifetime = NODE_GRANT_LIFETIME,
): Grant {
  return signGrant(
    {
      issuer: encodeBase64(domainKey.publicKey),
      subject: encodeBase64(nodePublicKey),
      purposes: [GrantPurpose.SERVICE_NODE],
      notBefore: now - SKEW,
      notAfter: now + lifetime,
      // Increasing with time, so a verifier's rollback mark refuses an older grant.
      serial: now,
      scope: name,
    },
    domainKey.secretKey,
  );
}

/** A rotation statement: the current domain key hands `name` to `next`. */
export function signRotation(
  current: SigningKeyPair,
  next: Uint8Array,
  name: string,
  now: number,
): DomainKeyRotation {
  return signDomainKeyRotation(
    {
      name,
      previousKey: encodeBase64(current.publicKey),
      nextKey: encodeBase64(next),
      issuedAt: now,
    },
    current.secretKey,
  );
}

export function loadStoredChain(store: OverlayStore, name: string): Grant[] | null {
  const raw = store.readPrivate(store.pathFor('grants', name));
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${store.pathFor('grants', name)} is not a grant file`);
  }
  const chain = parseChainShape(Array.isArray(value) ? value : [value]);
  if (!chain.ok) throw new Error(`${store.pathFor('grants', name)}: ${chain.error}`);
  return chain.value;
}

export function saveChain(store: OverlayStore, name: string, chain: Grant[]): void {
  store.writePrivate(store.pathFor('grants', name), `${JSON.stringify(chain, null, 2)}\n`);
}

/** The chain's validity end if it authorizes `nodeKey` for `name` under `domainKey`, else null. */
export function chainValidUntil(
  chain: Grant[],
  domainKey: string | Uint8Array,
  nodeKey: Uint8Array,
  name: string,
  now: number,
): number | null {
  const verified = verifyChain(chain, {
    trustedRoots: [domainKey],
    now,
    requirePurpose: GrantPurpose.SERVICE_NODE,
    requireScope: name,
  });
  if (!verified.ok) return null;
  if (encodeBase64(verified.subject) !== encodeBase64(nodeKey)) return null;
  return verified.notAfter;
}

export interface StaticKey {
  keyPair: X25519KeyPair;
  cert: KeyAgreementCertificate;
}

/**
 * The node's X25519 keys and their certificates. A new key is certified when
 * the current one has less than RENEW_CERT_BEFORE left; the previous key stays
 * usable until its own certificate expires, so clients holding a slightly
 * stale overlay still complete their handshake.
 */
export class KeyAgreementKeys {
  private keys: StaticKey[] = [];

  constructor(
    private readonly name: string,
    private readonly nodeKey: SigningKeyPair,
    private chainNotAfter: number,
  ) {}

  /** The chain was renewed: later certificates may run to its new end. */
  setChainNotAfter(notAfter: number): void {
    this.chainNotAfter = notAfter;
  }

  get current(): StaticKey | undefined {
    return this.keys.at(-1);
  }

  /** Keys whose certificates are still valid, newest first. */
  active(now: number): StaticKey[] {
    this.keys = this.keys.filter((k) => k.cert.notAfter > now);
    return [...this.keys].reverse();
  }

  /** Certify a fresh key if needed. Returns true when the published certificate changed. */
  rotateIfNeeded(now: number): boolean {
    const current = this.current;
    if (current && current.cert.notAfter - now > RENEW_CERT_BEFORE) return false;
    const notBefore = now - SKEW;
    const notAfter = Math.min(notBefore + MAX_KEY_AGREEMENT_LIFETIME, this.chainNotAfter);
    if (notAfter <= now)
      throw new Error('the node grant has expired; cannot certify a session key');
    // Capped by a grant that is itself ending: a new key would not last longer.
    if (current && current.cert.notAfter > now && notAfter <= current.cert.notAfter) return false;
    const keyPair = generateX25519KeyPair();
    const cert = signKeyAgreementCertificate(
      {
        signer: encodeBase64(this.nodeKey.publicKey),
        key: encodeBase64(keyPair.publicKey),
        role: KeyAgreementRole.SERVICE_NODE,
        scope: this.name,
        notBefore,
        notAfter,
        serial: now,
      },
      this.nodeKey.secretKey,
    );
    this.keys.push({ keyPair, cert });
    this.active(now);
    return true;
  }
}
