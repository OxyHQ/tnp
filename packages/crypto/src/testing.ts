/**
 * Test fixtures: a complete, genuinely signed credential set for one name —
 * domain key → (grant) → node key → (certificate) → X25519 key.
 *
 * For tests only (`@tnp/crypto/testing`). Production code builds the same
 * chain from keys it stores (packages/client/src/overlay/identity.ts).
 */

import { generateSigningKeyPair } from './domain-key.js';
import { encodeBase64 } from './encoding.js';
import { type Grant, GrantPurpose, signGrant } from './grants.js';
import {
  type KeyAgreementCertificate,
  KeyAgreementRole,
  signKeyAgreementCertificate,
} from './key-agreement.js';
import { generateX25519KeyPair, type X25519KeyPair } from './primitives.js';

export interface SigningKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface TestServiceCredentials {
  name: string;
  domainKey: SigningKeyPair;
  domainKeyB64: string;
  nodeKey: SigningKeyPair;
  chain: Grant[];
  staticKey: X25519KeyPair;
  kaCert: KeyAgreementCertificate;
}

export interface TestCredentialOptions {
  now?: number;
  domainKey?: SigningKeyPair;
  nodeKey?: SigningKeyPair;
  /** Scope the grant to another name than `name` (to build a wrong chain). */
  grantScope?: string;
  certLifetime?: number;
  grantSerial?: number;
}

export function makeTestCredentials(
  name: string,
  options: TestCredentialOptions = {},
): TestServiceCredentials {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const domainKey = options.domainKey ?? generateSigningKeyPair();
  const nodeKey = options.nodeKey ?? generateSigningKeyPair();
  const staticKey = generateX25519KeyPair();
  const grant = signGrant(
    {
      issuer: encodeBase64(domainKey.publicKey),
      subject: encodeBase64(nodeKey.publicKey),
      purposes: [GrantPurpose.SERVICE_NODE],
      notBefore: now - 3600,
      notAfter: now + 30 * 86_400,
      serial: options.grantSerial ?? 1,
      scope: options.grantScope ?? name,
    },
    domainKey.secretKey,
  );
  const kaCert = signKeyAgreementCertificate(
    {
      signer: encodeBase64(nodeKey.publicKey),
      key: encodeBase64(staticKey.publicKey),
      role: KeyAgreementRole.SERVICE_NODE,
      scope: options.grantScope ?? name,
      notBefore: now - 60,
      notAfter: now - 60 + (options.certLifetime ?? 7 * 86_400 - 120),
      serial: 1,
    },
    nodeKey.secretKey,
  );
  return {
    name,
    domainKey,
    domainKeyB64: encodeBase64(domainKey.publicKey),
    nodeKey,
    chain: [grant],
    staticKey,
    kaCert,
  };
}
