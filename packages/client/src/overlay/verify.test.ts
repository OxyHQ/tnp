/**
 * The client's trust decisions (security.md §1, "Domain keys and pinning"):
 * what a compelled or compromised registry can and cannot make it accept.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeBase64, generateSigningKeyPair, isVerifiedKeyAgreementKey } from '@tnp/crypto';
import { makeTestCredentials, type TestServiceCredentials } from '@tnp/crypto/testing';
import type { DnsResolveOverlay } from '@tnp/shared-types';
import { signRotation } from './identity';
import { PinStore } from './pins';
import { OverlayStore } from './store';
import { OverlayVerificationError, serviceNameFor, verifyOverlay } from './verify';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function store(): OverlayStore {
  const dir = mkdtempSync(join(tmpdir(), 'tnp-pins-'));
  dirs.push(dir);
  return new OverlayStore(join(dir, 'overlay'));
}

function overlayFor(
  creds: TestServiceCredentials,
  extra: Partial<DnsResolveOverlay> = {},
): DnsResolveOverlay {
  return {
    relay: 'wss://relay.example.test',
    available: true,
    domainKey: creds.domainKeyB64,
    rotations: [],
    chain: creds.chain,
    kaCert: creds.kaCert,
    ...extra,
  };
}

function refusal(fn: () => unknown): OverlayVerificationError {
  try {
    fn();
  } catch (err) {
    if (err instanceof OverlayVerificationError) return err;
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('first contact', () => {
  test('a valid chain is accepted and pinned; only a verified key comes out', () => {
    const pins = new PinStore(store());
    const creds = makeTestCredentials('example.ox');
    const result = verifyOverlay('example.ox', overlayFor(creds), pins);
    expect(result.firstContact).toBe(true);
    expect(isVerifiedKeyAgreementKey(result.key)).toBe(true);
    expect(pins.get('example.ox')?.domainKey).toBe(creds.domainKeyB64);
  });

  test('a chain that does not root at the presented domain key is refused and NOT pinned', () => {
    const pins = new PinStore(store());
    const creds = makeTestCredentials('example.ox');
    const other = generateSigningKeyPair();
    const err = refusal(() =>
      verifyOverlay(
        'example.ox',
        overlayFor(creds, { domainKey: encodeBase64(other.publicKey) }),
        pins,
      ),
    );
    expect(err.reason).toBe('bad-chain');
    expect(pins.get('example.ox')).toBeUndefined();
  });

  test("another name's perfectly valid chain cannot answer for this name", () => {
    const pins = new PinStore(store());
    const attacker = makeTestCredentials('attacker.ox');
    expect(refusal(() => verifyOverlay('victim.ox', overlayFor(attacker), pins)).reason).toBe(
      'bad-chain',
    );
  });

  test('an expired certificate is refused', () => {
    const pins = new PinStore(store());
    const creds = makeTestCredentials('example.ox');
    const later = creds.kaCert.notAfter + 1;
    expect(refusal(() => verifyOverlay('example.ox', overlayFor(creds), pins, later)).reason).toBe(
      'bad-chain',
    );
  });

  test('the pre-v1 bare key is malformed, not trusted', () => {
    const pins = new PinStore(store());
    const err = refusal(() =>
      verifyOverlay(
        'example.ox',
        { serviceNodePubKey: 'AAAA', relay: 'wss://r', available: true },
        pins,
      ),
    );
    expect(err.reason).toBe('malformed');
  });
});

describe('a pinned name', () => {
  test('a different domain key without a rotation statement is refused, naming the risk', () => {
    const pins = new PinStore(store());
    const genuine = makeTestCredentials('example.ox');
    verifyOverlay('example.ox', overlayFor(genuine), pins);
    // The registry now serves a consistent, fully valid chain under ITS key.
    const substitute = makeTestCredentials('example.ox');
    const err = refusal(() => verifyOverlay('example.ox', overlayFor(substitute), pins));
    expect(err.reason).toBe('pin-mismatch');
    expect(err.message).toContain('impersonating');
    expect(err.message).toContain('tnp pins forget example.ox');
    expect(pins.get('example.ox')?.domainKey).toBe(genuine.domainKeyB64);
  });

  test('a rotation signed by the pinned key is accepted and moves the pin', () => {
    const pins = new PinStore(store());
    const genuine = makeTestCredentials('example.ox');
    verifyOverlay('example.ox', overlayFor(genuine), pins);
    const nextKey = generateSigningKeyPair();
    const rotated = makeTestCredentials('example.ox', { domainKey: nextKey });
    const rotation = signRotation(
      genuine.domainKey,
      nextKey.publicKey,
      'example.ox',
      1_800_000_000,
    );
    const result = verifyOverlay(
      'example.ox',
      overlayFor(rotated, { rotations: [rotation] }),
      pins,
    );
    expect(result.firstContact).toBe(false);
    expect(pins.get('example.ox')?.domainKey).toBe(rotated.domainKeyB64);
  });

  test('a rotation signed by anyone else is refused', () => {
    const pins = new PinStore(store());
    const genuine = makeTestCredentials('example.ox');
    verifyOverlay('example.ox', overlayFor(genuine), pins);
    const attackerKey = generateSigningKeyPair();
    const attacker = makeTestCredentials('example.ox', { domainKey: attackerKey });
    // A statement claiming to come from the pinned key, signed by the attacker.
    const forged = {
      ...signRotation(attackerKey, generateSigningKeyPair().publicKey, 'example.ox', 1),
      previousKey: genuine.domainKeyB64,
      nextKey: attacker.domainKeyB64,
    };
    const err = refusal(() =>
      verifyOverlay('example.ox', overlayFor(attacker, { rotations: [forged] }), pins),
    );
    expect(err.reason).toBe('pin-mismatch');
  });

  test('forgetting the pin makes the next contact a first contact again', () => {
    const pins = new PinStore(store());
    const genuine = makeTestCredentials('example.ox');
    verifyOverlay('example.ox', overlayFor(genuine), pins);
    expect(pins.forget('example.ox')).toBe(true);
    const fresh = makeTestCredentials('example.ox');
    expect(verifyOverlay('example.ox', overlayFor(fresh), pins).firstContact).toBe(true);
  });

  test('an older grant is refused once a newer one was seen (rollback)', () => {
    const pins = new PinStore(store());
    const domainKey = generateSigningKeyPair();
    const nodeKey = generateSigningKeyPair();
    const newer = makeTestCredentials('example.ox', { domainKey, nodeKey, grantSerial: 5 });
    const older = makeTestCredentials('example.ox', { domainKey, nodeKey, grantSerial: 1 });
    verifyOverlay('example.ox', overlayFor(newer), pins);
    const err = refusal(() => verifyOverlay('example.ox', overlayFor(older), pins));
    expect(err.reason).toBe('bad-chain');
    expect(err.message).toContain('rolled-back');
  });
});

describe('pin storage', () => {
  test('the pin file is private and survives a reload', () => {
    const s = store();
    const creds = makeTestCredentials('example.ox');
    verifyOverlay('example.ox', overlayFor(creds), new PinStore(s));
    if (process.platform !== 'win32') expect(statSync(s.pinsPath).mode & 0o777).toBe(0o600);
    expect(new PinStore(s).get('example.ox')?.domainKey).toBe(creds.domainKeyB64);
    expect(JSON.parse(readFileSync(s.pinsPath, 'utf-8')).version).toBe(1);
  });

  test('a corrupt pin file fails closed instead of forgetting every pin', () => {
    const s = store();
    verifyOverlay('example.ox', overlayFor(makeTestCredentials('example.ox')), new PinStore(s));
    writeFileSync(s.pinsPath, '{not json', { mode: 0o600 });
    expect(() => new PinStore(s).get('example.ox')).toThrow('corrupt');
  });
});

describe('serviceNameFor', () => {
  test('derives the registered name locally', () => {
    expect(serviceNameFor('www.Example.ox.')).toBe('example.ox');
    expect(serviceNameFor('example.ox')).toBe('example.ox');
    expect(() => serviceNameFor('localhost')).toThrow();
    expect(() => serviceNameFor('bad_name.ox')).toThrow();
  });
});
