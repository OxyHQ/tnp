import { describe, expect, test } from 'bun:test';
import nacl from 'tweetnacl';
import {
  type DomainKeyRotation,
  followDomainKeyRotations,
  generateSigningKeyPair,
  MAX_DOMAIN_KEY_ROTATIONS,
  signDomainKeyRotation,
  signingKeyPairFromSecret,
  verifyDomainKeyRotation,
} from './domain-key';
import { encodeBase64 } from './encoding';
import { signServiceAuth, verifyServiceAuth } from './service-auth';

const NAME = 'example.ox';
const T = 1_800_000_000;

function key() {
  const kp = generateSigningKeyPair();
  return { ...kp, pub: encodeBase64(kp.publicKey) };
}

function rotate(
  from: ReturnType<typeof key>,
  to: ReturnType<typeof key>,
  issuedAt: number,
  name = NAME,
): DomainKeyRotation {
  return signDomainKeyRotation(
    { name, previousKey: from.pub, nextKey: to.pub, issuedAt },
    from.secretKey,
  );
}

describe('domain key rotation statements', () => {
  test('a statement signed by the retiring key verifies for its name only', () => {
    const a = key();
    const b = key();
    const statement = rotate(a, b, T);
    expect(verifyDomainKeyRotation(statement, NAME).ok).toBe(true);
    expect(verifyDomainKeyRotation(statement, 'other.ox')).toEqual({
      ok: false,
      detail: 'rotation is for another name',
    });
  });

  test('signing with any key but the retiring one is refused locally', () => {
    const a = key();
    const b = key();
    expect(() =>
      signDomainKeyRotation(
        { name: NAME, previousKey: a.pub, nextKey: b.pub, issuedAt: T },
        b.secretKey,
      ),
    ).toThrow();
  });

  test('tampering with any field breaks the signature', () => {
    const a = key();
    const b = key();
    const c = key();
    const statement = rotate(a, b, T);
    expect(verifyDomainKeyRotation({ ...statement, nextKey: c.pub }, NAME).ok).toBe(false);
    expect(verifyDomainKeyRotation({ ...statement, issuedAt: T + 1 }, NAME).ok).toBe(false);
    expect(verifyDomainKeyRotation({ ...statement, extra: 1 } as never, NAME).ok).toBe(false);
  });

  test('a rotation to the same key is malformed', () => {
    const a = key();
    expect(() =>
      signDomainKeyRotation(
        { name: NAME, previousKey: a.pub, nextKey: a.pub, issuedAt: T },
        a.secretKey,
      ),
    ).toThrow();
  });
});

describe('followDomainKeyRotations', () => {
  test('same key needs no rotation', () => {
    const a = key();
    expect(
      followDomainKeyRotations({ name: NAME, pinned: a.pub, current: a.pub, rotations: [] }),
    ).toEqual({ ok: true, steps: 0 });
  });

  test('a multi-step history signed in succession is followed', () => {
    const [a, b, c] = [key(), key(), key()];
    const rotations = [rotate(a, b, T), rotate(b, c, T + 10)];
    expect(
      followDomainKeyRotations({ name: NAME, pinned: a.pub, current: c.pub, rotations }),
    ).toEqual({ ok: true, steps: 2 });
    // A client pinned midway follows from where it is.
    expect(
      followDomainKeyRotations({ name: NAME, pinned: b.pub, current: c.pub, rotations }),
    ).toEqual({ ok: true, steps: 1 });
  });

  test('a new key without a statement from the pinned key fails closed', () => {
    const [a, b, attacker] = [key(), key(), key()];
    const rotations = [rotate(a, b, T)];
    expect(
      followDomainKeyRotations({ name: NAME, pinned: a.pub, current: attacker.pub, rotations }).ok,
    ).toBe(false);
    // A statement the attacker signs for itself does not help.
    const selfSigned = rotate(attacker, key(), T);
    expect(
      followDomainKeyRotations({
        name: NAME,
        pinned: a.pub,
        current: attacker.pub,
        rotations: [selfSigned],
      }).ok,
    ).toBe(false);
  });

  test('a gap in the history fails closed', () => {
    const [a, b, c] = [key(), key(), key()];
    expect(
      followDomainKeyRotations({
        name: NAME,
        pinned: a.pub,
        current: c.pub,
        rotations: [rotate(b, c, T)],
      }).ok,
    ).toBe(false);
  });

  test('statements for another name are ignored', () => {
    const [a, b] = [key(), key()];
    expect(
      followDomainKeyRotations({
        name: NAME,
        pinned: a.pub,
        current: b.pub,
        rotations: [rotate(a, b, T, 'other.ox')],
      }).ok,
    ).toBe(false);
  });

  test('issuedAt must increase along the walk', () => {
    const [a, b, c] = [key(), key(), key()];
    expect(
      followDomainKeyRotations({
        name: NAME,
        pinned: a.pub,
        current: c.pub,
        rotations: [rotate(a, b, T + 10), rotate(b, c, T)],
      }).ok,
    ).toBe(false);
  });

  test('an over-long history is refused', () => {
    const [a, b] = [key(), key()];
    const one = rotate(a, b, T);
    const rotations = Array.from({ length: MAX_DOMAIN_KEY_ROTATIONS + 1 }, () => one);
    expect(
      followDomainKeyRotations({ name: NAME, pinned: a.pub, current: b.pub, rotations }).ok,
    ).toBe(false);
  });
});

describe('signing key pairs', () => {
  test('a stored secret round-trips and an edited public half is caught', () => {
    const kp = generateSigningKeyPair();
    expect(signingKeyPairFromSecret(kp.secretKey).publicKey).toEqual(kp.publicKey);
    const tampered = kp.secretKey.slice();
    tampered[40] ^= 1;
    expect(() => signingKeyPairFromSecret(tampered)).toThrow();
    expect(() => signingKeyPairFromSecret(new Uint8Array(32))).toThrow();
  });
});

describe('service-node relay authentication', () => {
  const node = nacl.sign.keyPair();
  const statement = {
    name: NAME,
    endpoint: 'wss://relay.example.test',
    challenge: nacl.randomBytes(32),
    nodeKey: node.publicKey,
  };

  test('a proof verifies for exactly the statement signed', () => {
    const sig = signServiceAuth(statement, node.secretKey);
    expect(verifyServiceAuth(statement, sig)).toBe(true);
    expect(verifyServiceAuth({ ...statement, name: 'other.ox' }, sig)).toBe(false);
    expect(verifyServiceAuth({ ...statement, endpoint: 'wss://other.test' }, sig)).toBe(false);
    expect(verifyServiceAuth({ ...statement, challenge: nacl.randomBytes(32) }, sig)).toBe(false);
    expect(verifyServiceAuth({ ...statement, nodeKey: nacl.sign.keyPair().publicKey }, sig)).toBe(
      false,
    );
  });

  test('malformed input is a refusal, never a throw', () => {
    expect(verifyServiceAuth(statement, 'not base64')).toBe(false);
    expect(verifyServiceAuth({ ...statement, challenge: new Uint8Array(3) }, 'AAAA')).toBe(false);
    expect(verifyServiceAuth({ ...statement, name: 'UPPER.ox' }, 'AAAA')).toBe(false);
  });

  test('signing with a secret that is not the node key is refused', () => {
    expect(() => signServiceAuth(statement, nacl.sign.keyPair().secretKey)).toThrow();
  });
});
