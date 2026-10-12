import { describe, expect, test } from 'bun:test';
import { encodeBase64, generateSigningKeyPair, signDomainKeyRotation } from '@tnp/crypto';
import { makeTestCredentials } from '@tnp/crypto/testing';
import { parseDnsResolveOverlay } from './dns-resolve.js';
import { parseDomainKeyRecord, parseRegisterDomainKeyRequest } from './domain-keys.js';

const a = generateSigningKeyPair();
const b = generateSigningKeyPair();
const rotation = signDomainKeyRotation(
  {
    name: 'example.ox',
    previousKey: encodeBase64(a.publicKey),
    nextKey: encodeBase64(b.publicKey),
    issuedAt: 1_800_000_000,
  },
  a.secretKey,
);

describe('parseRegisterDomainKeyRequest', () => {
  test('accepts a first registration and a rotation', () => {
    const first = { name: 'example.ox', domainKey: encodeBase64(a.publicKey) };
    expect(parseRegisterDomainKeyRequest(first)).toEqual({ ok: true, value: first });
    const rotate = { name: 'example.ox', domainKey: encodeBase64(b.publicKey), rotation };
    expect(parseRegisterDomainKeyRequest(rotate)).toEqual({ ok: true, value: rotate });
  });

  test('names the field it rejects', () => {
    const cases: Array<[unknown, string]> = [
      [{ domainKey: 'AAAA' }, 'name must be a canonical name'],
      [{ name: 'Example.ox', domainKey: 'AAAA' }, 'name must be a canonical name'],
      [{ name: 'example.ox' }, 'domainKey must be a base64 key'],
      [
        { name: 'example.ox', domainKey: 'AAAA', rotation: {} },
        'rotation name must be a canonical name',
      ],
      [{ name: 'example.ox', domainKey: 'AAAA', reset: true }, 'unexpected field reset'],
      [[], 'request body must be an object'],
    ];
    for (const [body, error] of cases) {
      const parsed = parseRegisterDomainKeyRequest(body);
      expect(parsed.ok ? '' : parsed.error).toBe(error);
    }
  });
});

describe('parseDomainKeyRecord', () => {
  test('accepts the record and refuses an over-long history', () => {
    const record = {
      name: 'example.ox',
      domainKey: encodeBase64(b.publicKey),
      rotations: [rotation],
    };
    expect(parseDomainKeyRecord(record)).toEqual({ ok: true, value: record });
    const long = { ...record, rotations: Array.from({ length: 33 }, () => rotation) };
    expect(parseDomainKeyRecord(long).ok).toBe(false);
  });
});

describe('keyReset', () => {
  const record = { name: 'example.ox', domainKey: encodeBase64(b.publicKey), rotations: [] };
  const keyReset = { previousKeyFingerprint: 'ab'.repeat(32), since: '2026-11-20T00:00:00.000Z' };

  test('is carried by the domain-key record and the resolve overlay', () => {
    expect(parseDomainKeyRecord({ ...record, keyReset })).toEqual({
      ok: true,
      value: { ...record, keyReset },
    });
  });

  test('is shape-checked', () => {
    expect(parseDomainKeyRecord({ ...record, keyReset: { ...keyReset, extra: 1 } }).ok).toBe(false);
    expect(
      parseDomainKeyRecord({ ...record, keyReset: { ...keyReset, previousKeyFingerprint: 'zz' } })
        .ok,
    ).toBe(false);
    expect(
      parseDomainKeyRecord({ ...record, keyReset: { ...keyReset, since: 'yesterday' } }).ok,
    ).toBe(false);
  });
});

describe('parseDnsResolveOverlay', () => {
  const creds = makeTestCredentials('example.ox');
  const overlay = {
    relay: 'wss://relay.example.test',
    available: true,
    domainKey: creds.domainKeyB64,
    rotations: [],
    chain: creds.chain,
    kaCert: creds.kaCert,
  };

  test('accepts the overlay block', () => {
    expect(parseDnsResolveOverlay(overlay)).toEqual({ ok: true, value: overlay });
  });

  test('refuses the pre-v1 bare key and anything missing key material', () => {
    expect(
      parseDnsResolveOverlay({ serviceNodePubKey: 'AAAA', relay: 'wss://r', available: true }).ok,
    ).toBe(false);
    expect(parseDnsResolveOverlay({ ...overlay, chain: undefined }).ok).toBe(false);
    expect(parseDnsResolveOverlay({ ...overlay, kaCert: null }).ok).toBe(false);
    expect(parseDnsResolveOverlay({ ...overlay, relay: '' }).ok).toBe(false);
  });
});
