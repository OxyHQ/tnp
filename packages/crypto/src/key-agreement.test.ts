import { describe, expect, test } from 'bun:test';
import nacl from 'tweetnacl';
import { encodeBase64 } from './encoding';
import {
  type Grant,
  GrantPurpose,
  type GrantPurposeValue,
  serialKey,
  signGrant,
  type VerifyFailure,
} from './grants';
import {
  canonicalKeyAgreementBytes,
  isVerifiedKeyAgreementKey,
  type KeyAgreementCertificate,
  KeyAgreementRole,
  type KeyAgreementVerifyOptions,
  MAX_KEY_AGREEMENT_LIFETIME,
  signKeyAgreementCertificate,
  type UnsignedKeyAgreementCertificate,
  verifyKeyAgreementCertificate,
} from './key-agreement';
import { generateX25519KeyPair } from './primitives';

const NOW = 1_800_000_000;
const DAY = 86_400;

function signing() {
  const kp = nacl.sign.keyPair();
  return { pub: encodeBase64(kp.publicKey), secret: kp.secretKey };
}

interface Setup {
  nodePurposes?: GrantPurposeValue[];
  nodeScope?: string;
  nodeNotAfter?: number;
  cert?: Partial<UnsignedKeyAgreementCertificate>;
}

/** identity → device → node (Ed25519) → key-agreement key (X25519). */
function setup(overrides: Setup = {}) {
  const identity = signing();
  const device = signing();
  const node = signing();
  const x = generateX25519KeyPair();

  const deviceGrant = signGrant(
    {
      issuer: identity.pub,
      subject: device.pub,
      purposes: [
        GrantPurpose.DELEGATE,
        GrantPurpose.SERVICE_NODE,
        GrantPurpose.RELAY,
        GrantPurpose.DOMAIN_RECORDS,
      ],
      notBefore: NOW - 30 * DAY,
      notAfter: NOW + 365 * DAY,
      serial: 1,
    },
    identity.secret,
  );
  const nodeGrant = signGrant(
    {
      issuer: device.pub,
      subject: node.pub,
      purposes: overrides.nodePurposes ?? [GrantPurpose.SERVICE_NODE],
      notBefore: NOW - 10 * DAY,
      notAfter: overrides.nodeNotAfter ?? NOW + 90 * DAY,
      serial: 1,
      scope: overrides.nodeScope ?? 'example.ox',
    },
    device.secret,
  );

  const unsigned: UnsignedKeyAgreementCertificate = {
    signer: node.pub,
    key: encodeBase64(x.publicKey),
    role: KeyAgreementRole.SERVICE_NODE,
    scope: 'example.ox',
    notBefore: NOW - DAY,
    notAfter: NOW + 6 * DAY,
    serial: 4,
    ...overrides.cert,
  };
  const cert = signKeyAgreementCertificate(unsigned, node.secret);
  const options: KeyAgreementVerifyOptions = {
    trustedRoots: [identity.pub],
    now: NOW,
    role: KeyAgreementRole.SERVICE_NODE,
    name: 'example.ox',
  };
  return {
    identity,
    device,
    node,
    x,
    cert,
    unsigned,
    chain: [nodeGrant, deviceGrant] as Grant[],
    options,
  };
}

function expectReason(
  result: ReturnType<typeof verifyKeyAgreementCertificate>,
  reason: VerifyFailure,
) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
}

describe('a key-agreement certificate binds an X25519 key to the chain', () => {
  test('verifies, and yields the exact X25519 key', () => {
    const { cert, chain, options, x } = setup();
    const result = verifyKeyAgreementCertificate(cert, chain, options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.key.publicKey]).toEqual([...x.publicKey]);
    expect(result.key.scope).toBe('example.ox');
    expect(result.key.role).toBe(KeyAgreementRole.SERVICE_NODE);
    expect(isVerifiedKeyAgreementKey(result.key)).toBe(true);
  });

  test('the verified key cannot be mutated after verification', () => {
    const { cert, chain, options, x } = setup();
    const result = verifyKeyAgreementCertificate(cert, chain, options);
    if (!result.ok) throw new Error('expected ok');
    result.key.publicKey.fill(0);
    expect([...result.key.publicKey]).toEqual([...x.publicKey]);
    expect(Object.isFrozen(result.key)).toBe(true);
  });

  test('a look-alike object is not a verified key', () => {
    const { x } = setup();
    const fake = {
      publicKey: x.publicKey,
      role: 'service-node',
      scope: 'example.ox',
      notAfter: NOW + 1,
    };
    expect(isVerifiedKeyAgreementKey(fake)).toBe(false);
  });

  test('a cert for a subdomain of the signer scope verifies for that subdomain only', () => {
    const { cert, chain, options } = setup({ cert: { scope: 'api.example.ox' } });
    expect(
      verifyKeyAgreementCertificate(cert, chain, { ...options, name: 'api.example.ox' }).ok,
    ).toBe(true);
    expectReason(verifyKeyAgreementCertificate(cert, chain, options), 'scope-mismatch');
  });

  test('records the serial key so the caller can raise its high-water mark', () => {
    const { cert, chain, options, node, x } = setup();
    const result = verifyKeyAgreementCertificate(cert, chain, options);
    if (!result.ok) throw new Error('expected ok');
    expect(result.serialKey).toBe(serialKey(node.pub, x.publicKey));
    expect(result.serial).toBe(4);
  });
});

describe('substitution and escalation are refused', () => {
  test('a key the node never certified (relay or API swaps the X25519 key)', () => {
    const { cert, chain, options } = setup();
    const swapped = { ...cert, key: encodeBase64(generateX25519KeyPair().publicKey) };
    expectReason(verifyKeyAgreementCertificate(swapped, chain, options), 'bad-signature');
  });

  test('a cert signed by a key that is not the chain leaf', () => {
    const { unsigned, chain, options } = setup();
    const stranger = signing();
    const cert = signKeyAgreementCertificate(
      { ...unsigned, signer: stranger.pub },
      stranger.secret,
    );
    expectReason(verifyKeyAgreementCertificate(cert, chain, options), 'chain-broken');
  });

  test('a signer without the service-node purpose', () => {
    const { cert, chain, options } = setup({ nodePurposes: [GrantPurpose.DOMAIN_RECORDS] });
    expectReason(verifyKeyAgreementCertificate(cert, chain, options), 'purpose-not-granted');
  });

  test('a relay cert presented for a service-node session, and vice versa', () => {
    const relay = setup({
      nodePurposes: [GrantPurpose.RELAY, GrantPurpose.SERVICE_NODE],
      cert: { role: KeyAgreementRole.RELAY },
    });
    expectReason(
      verifyKeyAgreementCertificate(relay.cert, relay.chain, relay.options),
      'purpose-not-granted',
    );
    expect(
      verifyKeyAgreementCertificate(relay.cert, relay.chain, {
        ...relay.options,
        role: KeyAgreementRole.RELAY,
      }).ok,
    ).toBe(true);
  });

  test('a cert for another name', () => {
    const { cert, chain, options } = setup({ cert: { scope: 'other.ox' } });
    expectReason(
      verifyKeyAgreementCertificate(cert, chain, { ...options, name: 'other.ox' }),
      'scope-mismatch',
    );
    expectReason(verifyKeyAgreementCertificate(cert, chain, options), 'scope-mismatch');
  });

  test('the name being connected to is mandatory and canonical', () => {
    const { cert, chain, options } = setup();
    for (const name of ['', 'Example.ox', undefined]) {
      expectReason(
        verifyKeyAgreementCertificate(cert, chain, { ...options, name: name as string }),
        'scope-required',
      );
    }
  });
});

describe('time, revocation and rollback', () => {
  test('a cert that outlives its signer grant', () => {
    const { cert, chain, options } = setup({ nodeNotAfter: NOW + 2 * DAY });
    expectReason(verifyKeyAgreementCertificate(cert, chain, options), 'window-not-nested');
  });

  test('a lifetime above the cap cannot be signed or verified', () => {
    const { unsigned, node, cert, chain, options } = setup();
    const tooLong = { ...unsigned, notAfter: unsigned.notBefore + MAX_KEY_AGREEMENT_LIFETIME + 1 };
    expect(() => signKeyAgreementCertificate(tooLong, node.secret)).toThrow(/LIFETIME/);
    expectReason(
      verifyKeyAgreementCertificate({ ...tooLong, signature: cert.signature }, chain, options),
      'malformed',
    );
  });

  test('expired and not-yet-valid', () => {
    const { cert, chain, options } = setup();
    expectReason(
      verifyKeyAgreementCertificate(cert, chain, { ...options, now: NOW + 6 * DAY }),
      'expired',
    );
    expectReason(
      verifyKeyAgreementCertificate(cert, chain, { ...options, now: NOW - 2 * DAY }),
      'not-yet-valid',
    );
  });

  test('a revoked X25519 key or a revoked signer', () => {
    const { cert, chain, options, x, node } = setup();
    expectReason(
      verifyKeyAgreementCertificate(cert, chain, { ...options, revoked: [x.publicKey] }),
      'revoked',
    );
    expectReason(
      verifyKeyAgreementCertificate(cert, chain, { ...options, revoked: [node.pub] }),
      'revoked',
    );
  });

  test('a rolled-back serial', () => {
    const { cert, chain, options, node, x } = setup();
    const knownSerials = new Map([[serialKey(node.pub, x.publicKey), 5]]);
    expectReason(
      verifyKeyAgreementCertificate(cert, chain, { ...options, knownSerials }),
      'rolled-back',
    );
  });
});

describe('the certified key itself', () => {
  test('all-zero, small-order and non-canonical X25519 keys cannot be certified', () => {
    const { unsigned, node, cert, chain, options } = setup();
    const bad = [
      new Uint8Array(32),
      Uint8Array.from([1, ...new Array(31).fill(0)]),
      Uint8Array.from([0xed, ...new Array(30).fill(0xff), 0x7f]),
    ];
    for (const key of bad) {
      const forged = { ...unsigned, key: encodeBase64(key) };
      expect(() => signKeyAgreementCertificate(forged, node.secret)).toThrow(/X25519/);
      expectReason(
        verifyKeyAgreementCertificate({ ...forged, signature: cert.signature }, chain, options),
        'malformed',
      );
    }
  });

  test('any signed field changed breaks the signature', () => {
    const { cert, chain, options } = setup();
    const patches: Array<Partial<KeyAgreementCertificate>> = [
      { notAfter: NOW + 5 * DAY },
      { notBefore: NOW - DAY + 100 },
      { serial: 9 },
    ];
    for (const patch of patches) {
      expectReason(
        verifyKeyAgreementCertificate({ ...cert, ...patch }, chain, options),
        'bad-signature',
      );
    }
  });

  test('the signature is domain-separated from grant signatures', () => {
    const { unsigned } = setup();
    const text = new TextDecoder().decode(canonicalKeyAgreementBytes(unsigned).subarray(4, 24));
    expect(text).toBe('tnp-key-agreement-v1');
  });
});
