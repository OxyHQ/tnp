import { describe, expect, test } from 'bun:test';
import {
  assertRulesKdfParams,
  createRulesEnvelope,
  DEFAULT_RULES_KDF,
  openRulesEnvelope,
  paddedPlaintextLength,
  RULES_MAX_CIPHERTEXT_BYTES,
  type RulesEnvelope,
  RulesEnvelopeError,
  type RulesKdfParams,
  resealRulesEnvelope,
  rulesCiphertextDigest,
  unlockRulesKey,
} from './dns-rules';
import { decodeBase64Strict, encodeBase64 } from './encoding';

/** The cheapest parameters the module accepts, so the suite stays fast. */
const FAST: RulesKdfParams = { alg: 'argon2id', m: 19_456, t: 2, p: 1 };
const ALICE = 'oxy-user-alice';
const BOB = 'oxy-user-bob';
const enc = new TextEncoder();
const dec = new TextDecoder();
const body = (s: string) => enc.encode(s);

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof RulesEnvelopeError) return err.code;
    throw err;
  }
  throw new Error('expected a RulesEnvelopeError');
}

function flipByte(b64: string, index: number): string {
  const bytes = decodeBase64Strict(b64);
  bytes[index] ^= 0x01;
  return encodeBase64(bytes);
}

describe('round trip', () => {
  test('a passphrase-created rule set unlocks and opens with the same passphrase', () => {
    const { envelope, rulesKey } = createRulesEnvelope({
      passphrase: 'correct horse battery staple',
      userId: ALICE,
      body: body('{"rules":[]}'),
      kdfParams: FAST,
    });
    expect(envelope.v).toBe(1);
    expect(envelope.version).toBe(1);
    expect(envelope.kdfParams).toEqual(FAST);

    const unlocked = unlockRulesKey({
      passphrase: 'correct horse battery staple',
      userId: ALICE,
      envelope,
    });
    expect(unlocked).toEqual(rulesKey);
    expect(dec.decode(openRulesEnvelope({ rulesKey: unlocked, userId: ALICE, envelope }))).toBe(
      '{"rules":[]}',
    );
  });

  test('the passphrase is NFC-normalized: composed and decomposed accents unlock alike', () => {
    const { envelope } = createRulesEnvelope({
      passphrase: 'café au lait',
      userId: ALICE,
      body: body('x'),
      kdfParams: FAST,
    });
    expect(() =>
      unlockRulesKey({ passphrase: 'café au lait', userId: ALICE, envelope }),
    ).not.toThrow();
  });

  test('a reseal keeps the wrap, bumps the version and opens to the new body', () => {
    const { envelope, rulesKey } = createRulesEnvelope({
      passphrase: 'pass phrase one',
      userId: ALICE,
      body: body('v1'),
      kdfParams: FAST,
    });
    const next = resealRulesEnvelope({
      rulesKey,
      userId: ALICE,
      previous: envelope,
      body: body('v2'),
    });
    expect(next.version).toBe(2);
    expect(next.wrappedKey).toBe(envelope.wrappedKey);
    expect(next.salt).toBe(envelope.salt);
    expect(next.nonce).not.toBe(envelope.nonce);
    expect(dec.decode(openRulesEnvelope({ rulesKey, userId: ALICE, envelope: next }))).toBe('v2');
    // The wrap still opens with the passphrase after any number of reseals.
    expect(
      unlockRulesKey({ passphrase: 'pass phrase one', userId: ALICE, envelope: next }),
    ).toEqual(rulesKey);
  });

  test('the default parameters are RFC 9106 second recommendation and pass the bounds', () => {
    expect(DEFAULT_RULES_KDF).toEqual({ alg: 'argon2id', m: 65_536, t: 3, p: 1 });
    expect(() => assertRulesKdfParams(DEFAULT_RULES_KDF)).not.toThrow();
  });
});

describe('refusals', () => {
  const made = createRulesEnvelope({
    passphrase: 'the right passphrase',
    userId: ALICE,
    body: body('{"rules":[{"type":"block","name":"example.com"}]}'),
    kdfParams: FAST,
  });

  test('a wrong passphrase fails', () => {
    expect(
      codeOf(() =>
        unlockRulesKey({
          passphrase: 'the wrong passphrase',
          userId: ALICE,
          envelope: made.envelope,
        }),
      ),
    ).toBe('wrong-passphrase');
  });

  test('tampered ciphertext fails', () => {
    const tampered = { ...made.envelope, ciphertext: flipByte(made.envelope.ciphertext, 40) };
    expect(
      codeOf(() =>
        openRulesEnvelope({ rulesKey: made.rulesKey, userId: ALICE, envelope: tampered }),
      ),
    ).toBe('tampered');
  });

  test('a tampered nonce or wrapped key fails', () => {
    const badNonce = { ...made.envelope, nonce: flipByte(made.envelope.nonce, 3) };
    expect(
      codeOf(() =>
        openRulesEnvelope({ rulesKey: made.rulesKey, userId: ALICE, envelope: badNonce }),
      ),
    ).toBe('tampered');
    const badWrap = { ...made.envelope, wrappedKey: flipByte(made.envelope.wrappedKey, 30) };
    expect(
      codeOf(() =>
        unlockRulesKey({ passphrase: 'the right passphrase', userId: ALICE, envelope: badWrap }),
      ),
    ).toBe('wrong-passphrase');
  });

  test('a blob moved to another account fails, with the key or the passphrase', () => {
    // Bob's server row holding Alice's blob: Alice's key, Bob's user id in the AAD.
    expect(
      codeOf(() =>
        openRulesEnvelope({ rulesKey: made.rulesKey, userId: BOB, envelope: made.envelope }),
      ),
    ).toBe('tampered');
    expect(
      codeOf(() =>
        unlockRulesKey({
          passphrase: 'the right passphrase',
          userId: BOB,
          envelope: made.envelope,
        }),
      ),
    ).toBe('wrong-passphrase');
  });

  test('downgraded KDF parameters break the wrap rather than weakening it', () => {
    const weakened = { ...made.envelope, kdfParams: { ...FAST, t: 3 } };
    expect(
      codeOf(() =>
        unlockRulesKey({ passphrase: 'the right passphrase', userId: ALICE, envelope: weakened }),
      ),
    ).toBe('wrong-passphrase');
  });

  test('parameters outside the bounds are refused before any work', () => {
    for (const kdfParams of [
      { ...FAST, m: 1024 },
      { ...FAST, t: 1 },
      { ...FAST, m: 4_000_000 },
      { alg: 'scrypt', m: 65_536, t: 3, p: 1 },
    ]) {
      const envelope = { ...made.envelope, kdfParams } as RulesEnvelope;
      expect(codeOf(() => unlockRulesKey({ passphrase: 'x', userId: ALICE, envelope }))).toBe(
        'malformed',
      );
    }
  });

  test('an edited version field fails the tag: the version is in the AAD', () => {
    const edited = { ...made.envelope, version: 7 };
    expect(
      codeOf(() => openRulesEnvelope({ rulesKey: made.rulesKey, userId: ALICE, envelope: edited })),
    ).toBe('tampered');
  });

  test('an older version than one already seen is refused as a rollback', () => {
    const v2 = resealRulesEnvelope({
      rulesKey: made.rulesKey,
      userId: ALICE,
      previous: made.envelope,
      body: body('{"rules":[]}'),
    });
    // The reader accepted v2; the server now serves v1 again (validly encrypted).
    expect(
      codeOf(() =>
        openRulesEnvelope({
          rulesKey: made.rulesKey,
          userId: ALICE,
          envelope: made.envelope,
          minVersion: v2.version,
        }),
      ),
    ).toBe('rollback');
    // The same version again is fine: it is the blob already accepted.
    expect(() =>
      openRulesEnvelope({ rulesKey: made.rulesKey, userId: ALICE, envelope: v2, minVersion: 2 }),
    ).not.toThrow();
  });

  test('a different version is a different digest, so a forked history is detectable', () => {
    const again = resealRulesEnvelope({
      rulesKey: made.rulesKey,
      userId: ALICE,
      previous: made.envelope,
      body: body('a'),
    });
    expect(rulesCiphertextDigest(again)).not.toBe(rulesCiphertextDigest(made.envelope));
    expect(rulesCiphertextDigest(made.envelope)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('non-canonical base64 and wrong lengths are malformed', () => {
    expect(
      codeOf(() =>
        openRulesEnvelope({
          rulesKey: made.rulesKey,
          userId: ALICE,
          envelope: { ...made.envelope, nonce: `-${made.envelope.nonce.slice(1)}` },
        }),
      ),
    ).toBe('malformed');
    expect(
      codeOf(() =>
        openRulesEnvelope({
          rulesKey: made.rulesKey,
          userId: ALICE,
          envelope: { ...made.envelope, salt: encodeBase64(new Uint8Array(8)) },
        }),
      ),
    ).toBe('malformed');
  });
});

describe('size', () => {
  test('ciphertext length reveals only a power-of-two bucket', () => {
    const small = createRulesEnvelope({
      passphrase: 'p p p p',
      userId: ALICE,
      body: body('a'),
      kdfParams: FAST,
    });
    const medium = createRulesEnvelope({
      passphrase: 'p p p p',
      userId: ALICE,
      body: body('a'.repeat(3000)),
      kdfParams: FAST,
    });
    const len = (e: RulesEnvelope) => decodeBase64Strict(e.ciphertext).length;
    expect(len(small.envelope)).toBe(4096 + 16);
    expect(len(medium.envelope)).toBe(len(small.envelope));
    expect(paddedPlaintextLength(5000)).toBe(8192);
  });

  test('a rule set that would exceed the cap is refused at seal time', () => {
    expect(
      codeOf(() =>
        createRulesEnvelope({
          passphrase: 'p p p p',
          userId: ALICE,
          body: new Uint8Array(RULES_MAX_CIPHERTEXT_BYTES),
          kdfParams: FAST,
        }),
      ),
    ).toBe('too-large');
  });
});
