import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeBase64,
  generateSigningKeyPair,
  KeyAgreementRole,
  MAX_KEY_AGREEMENT_LIFETIME,
  verifyKeyAgreementCertificate,
} from '@tnp/crypto';
import type { DomainKeyRecord, RegisterDomainKeyRequest } from '@tnp/shared-types';
import { prepareNodeCredentials } from '../service-node';
import {
  chainValidUntil,
  issueNodeGrant,
  KeyAgreementKeys,
  loadKeyPair,
  RENEW_CERT_BEFORE,
  saveChain,
} from './identity';
import { OverlayStore } from './store';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function store(): OverlayStore {
  const dir = mkdtempSync(join(tmpdir(), 'tnp-identity-'));
  dirs.push(dir);
  return new OverlayStore(join(dir, 'overlay'));
}

function fakeApi(initial: DomainKeyRecord | null = null) {
  let record = initial;
  const registered: RegisterDomainKeyRequest[] = [];
  return {
    registered,
    api: {
      async getDomainKey() {
        return record;
      },
      async registerDomainKey(req: RegisterDomainKeyRequest) {
        registered.push(req);
        record = { name: req.name, domainKey: req.domainKey, rotations: [] };
        return record;
      },
    },
  };
}

const NOW = Math.floor(Date.now() / 1000);
const silence = () => {
  const log = console.log;
  console.log = () => {};
  return () => {
    console.log = log;
  };
};

describe('prepareNodeCredentials', () => {
  test('first run on the owner device creates and registers the domain key, 0600', async () => {
    const s = store();
    const { api, registered } = fakeApi();
    const restore = silence();
    const creds = await prepareNodeCredentials('example.ox', s, api, 'token', NOW).finally(restore);
    expect(registered).toHaveLength(1);
    expect(registered[0].domainKey).toBe(creds.domainKey);
    expect(creds.renewChain).not.toBeNull();
    expect(
      chainValidUntil(creds.chain, creds.domainKey, creds.nodeKey.publicKey, 'example.ox', NOW),
    ).not.toBeNull();
    if (process.platform !== 'win32') {
      expect(statSync(s.pathFor('domain-keys', 'example.ox')).mode & 0o777).toBe(0o600);
      expect(statSync(s.pathFor('node-keys', 'example.ox')).mode & 0o777).toBe(0o600);
    }
    // A second run reuses everything and registers nothing new.
    const again = await prepareNodeCredentials('example.ox', s, api, 'token', NOW);
    expect(again.domainKey).toBe(creds.domainKey);
    expect(encodeBase64(again.nodeKey.publicKey)).toBe(encodeBase64(creds.nodeKey.publicKey));
    expect(registered).toHaveLength(1);
  });

  test('a registry holding a different key than this device is refused', async () => {
    const s = store();
    const restore = silence();
    await prepareNodeCredentials('example.ox', s, fakeApi().api, 'token', NOW).finally(restore);
    const other = encodeBase64(generateSigningKeyPair().publicKey);
    const { api } = fakeApi({ name: 'example.ox', domainKey: other, rotations: [] });
    await expect(prepareNodeCredentials('example.ox', s, api, 'token', NOW)).rejects.toThrow(
      'different domain key',
    );
  });

  test('a node without the domain key needs a grant, and says how to get one', async () => {
    const owner = generateSigningKeyPair();
    const { api } = fakeApi({
      name: 'example.ox',
      domainKey: encodeBase64(owner.publicKey),
      rotations: [],
    });
    const s = store();
    const err = await prepareNodeCredentials('example.ox', s, api, 'token', NOW).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('tnp domain grant example.ox --node-key');
    // The owner issues the grant; the node then starts without the domain key.
    const nodeKey = loadKeyPair(s, 'node-keys', 'example.ox');
    if (!nodeKey) throw new Error('node key was not created');
    saveChain(s, 'example.ox', [issueNodeGrant(owner, nodeKey.publicKey, 'example.ox', NOW)]);
    const creds = await prepareNodeCredentials('example.ox', s, api, 'token', NOW);
    expect(creds.renewChain).toBeNull();
    expect(creds.domainKey).toBe(encodeBase64(owner.publicKey));
  });
});

describe('KeyAgreementKeys', () => {
  test('certificates verify, last at most 7 days, and rotate with overlap', () => {
    const domainKey = generateSigningKeyPair();
    const nodeKey = generateSigningKeyPair();
    const chain = [issueNodeGrant(domainKey, nodeKey.publicKey, 'example.ox', NOW)];
    const keys = new KeyAgreementKeys('example.ox', nodeKey, chain[0].notAfter);
    expect(keys.rotateIfNeeded(NOW)).toBe(true);
    const first = keys.current;
    if (!first) throw new Error('no key');
    expect(first.cert.notAfter - first.cert.notBefore).toBeLessThanOrEqual(
      MAX_KEY_AGREEMENT_LIFETIME,
    );
    const verified = verifyKeyAgreementCertificate(first.cert, chain, {
      trustedRoots: [domainKey.publicKey],
      role: KeyAgreementRole.SERVICE_NODE,
      name: 'example.ox',
      now: NOW,
    });
    expect(verified.ok).toBe(true);
    expect(keys.rotateIfNeeded(NOW + 60)).toBe(false);
    const later = first.cert.notAfter - RENEW_CERT_BEFORE + 1;
    expect(keys.rotateIfNeeded(later)).toBe(true);
    // Both keys accept handshakes until the old certificate expires.
    expect(keys.active(later)).toHaveLength(2);
    expect(keys.active(first.cert.notAfter)).toHaveLength(1);
  });

  test('a certificate never outlives the grant', () => {
    const domainKey = generateSigningKeyPair();
    const nodeKey = generateSigningKeyPair();
    const grant = issueNodeGrant(domainKey, nodeKey.publicKey, 'example.ox', NOW, 3600);
    const keys = new KeyAgreementKeys('example.ox', nodeKey, grant.notAfter);
    keys.rotateIfNeeded(NOW);
    expect(keys.current?.cert.notAfter).toBe(grant.notAfter);
    // And it does not churn while the grant is ending.
    expect(keys.rotateIfNeeded(NOW + 60)).toBe(false);
    expect(() => keys.rotateIfNeeded(grant.notAfter + 1)).toThrow('expired');
  });
});
