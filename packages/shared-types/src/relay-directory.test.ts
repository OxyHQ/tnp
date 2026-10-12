import { describe, expect, test } from 'bun:test';
import {
  encodeBase64,
  generateSigningKeyPair,
  signRelayDirectory,
  type UnsignedRelayDirectory,
} from '@tnp/crypto';
import {
  describeDirectoryRejection,
  RELAY_DIRECTORY_SIGNING_KEYS_BASE64,
  relayDirectorySigningKeys,
  verifySignedRelayDirectory,
} from './relay-directory';
import { parseRegisterRelayRequest, parseRelayHeartbeatRequest } from './relays';

const NOW = 1_800_000_000;
const signer = generateSigningKeyPair();
const relayKey = encodeBase64(generateSigningKeyPair().publicKey);

function doc(endpoint: string): UnsignedRelayDirectory {
  return {
    v: 1,
    serial: NOW,
    issuedAt: NOW,
    expiresAt: NOW + 3600,
    relays: [{ endpoint, relayKey, operator: 'oxy', capabilities: ['tunnel'], region: '' }],
  };
}

const opts = { now: NOW + 1, trustedKeys: [signer.publicKey] };

describe('pinned directory signing keys', () => {
  test('one or two canonical 32-byte keys, no duplicates', () => {
    const keys = relayDirectorySigningKeys();
    expect(keys.length).toBeGreaterThanOrEqual(1);
    expect(keys.length).toBeLessThanOrEqual(2);
    for (const k of keys) expect(k.length).toBe(32);
    expect(new Set(RELAY_DIRECTORY_SIGNING_KEYS_BASE64).size).toBe(keys.length);
  });

  test('a directory signed by anything else is refused by default', () => {
    const signed = signRelayDirectory(doc('wss://relay.tnp.network'), signer.secretKey);
    expect(verifySignedRelayDirectory(signed, { now: NOW + 1 })).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });
});

describe('endpoint policy', () => {
  test('a canonical public wss:// endpoint verifies', () => {
    const signed = signRelayDirectory(doc('wss://relay.tnp.network'), signer.secretKey);
    expect(verifySignedRelayDirectory(signed, opts).ok).toBe(true);
  });

  test('ws://, private hosts and non-canonical spellings are refused whole', () => {
    for (const endpoint of [
      'ws://relay.tnp.network',
      'wss://127.0.0.1:8443',
      'wss://relay.local',
      'wss://Relay.TNP.network',
      'wss://relay.tnp.network/',
    ]) {
      const signed = signRelayDirectory(doc(endpoint), signer.secretKey);
      expect(verifySignedRelayDirectory(signed, opts)).toEqual({
        ok: false,
        reason: 'bad-endpoint',
      });
    }
  });

  test('loopback ws:// only when a test asks for it', () => {
    const signed = signRelayDirectory(doc('ws://127.0.0.1:9000'), signer.secretKey);
    expect(verifySignedRelayDirectory(signed, { ...opts, allowNonPublicEndpoints: true }).ok).toBe(
      true,
    );
  });

  test('every rejection has wording', () => {
    for (const reason of [
      'malformed',
      'oversized',
      'bad-signature',
      'not-yet-valid',
      'expired',
      'rolled-back',
      'bad-endpoint',
    ] as const) {
      expect(describeDirectoryRejection(reason).length).toBeGreaterThan(10);
    }
  });
});

describe('relay key proof on register and heartbeat', () => {
  const base = {
    endpoint: 'wss://relay.example.org',
    publicKey: relayKey,
    capacity: { maxConnections: 10, bandwidth: 0 },
  };
  const proof = { issuedAt: NOW, signature: `${'A'.repeat(86)}==` };

  test('absent is accepted (relays released before it), present is carried through', () => {
    const without = parseRegisterRelayRequest(base);
    expect(without.ok && without.value.proof).toBeUndefined();
    const withProof = parseRegisterRelayRequest({ ...base, proof });
    expect(withProof.ok && withProof.value.proof).toEqual(proof);
    const beat = parseRelayHeartbeatRequest({ endpoint: base.endpoint, proof });
    expect(beat.ok && beat.value.proof).toEqual(proof);
  });

  test('a present but malformed proof is refused', () => {
    for (const bad of [
      'x',
      { issuedAt: -1, signature: proof.signature },
      { issuedAt: 1.5, signature: proof.signature },
      { issuedAt: NOW, signature: 'short' },
      { ...proof, extra: 1 },
    ]) {
      expect(parseRegisterRelayRequest({ ...base, proof: bad }).ok).toBe(false);
      expect(parseRelayHeartbeatRequest({ endpoint: base.endpoint, proof: bad }).ok).toBe(false);
    }
  });
});
