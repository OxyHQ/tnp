import { describe, expect, test } from 'bun:test';
import nacl from 'tweetnacl';
import { encodeBase64 } from './encoding';
import {
  canonicalGrantBytes,
  type Grant,
  GrantPurpose,
  type GrantPurposeValue,
  MAX_CHAIN_DEPTH,
  serialKey,
  signGrant,
  type UnsignedGrant,
  type VerifyFailure,
  type VerifyOptions,
  verifyChain,
} from './grants';

const NOW = 1_800_000_000;

function keypair() {
  const kp = nacl.sign.keyPair();
  return { pub: encodeBase64(kp.publicKey), raw: kp.publicKey, secret: kp.secretKey };
}

/** Same bytes, URL-safe alphabet: a spelling Node's lenient decoder accepts. */
const urlSafe = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_');

/** A key whose canonical base64 contains `+` or `/`, so `urlSafe` actually changes it. */
function keypairWithSymbols() {
  for (;;) {
    const kp = keypair();
    if (/[+/]/.test(kp.pub)) return kp;
  }
}

interface ChainOverrides {
  leafScope?: string | null;
  deviceScope?: string;
  leafPurposes?: GrantPurposeValue[];
  devicePurposes?: GrantPurposeValue[];
  notAfter?: number;
  leafNotAfter?: number;
  serial?: number;
}

/** Oxy identity → device → node, the hierarchy security.md §1 describes. */
function buildChain(overrides: ChainOverrides = {}) {
  const identity = keypair();
  const device = keypairWithSymbols();
  const node = keypair();

  const deviceGrant = signGrant(
    {
      issuer: identity.pub,
      subject: device.pub,
      purposes: overrides.devicePurposes ?? [GrantPurpose.DELEGATE, GrantPurpose.SERVICE_NODE],
      notBefore: NOW - 1000,
      notAfter: overrides.notAfter ?? NOW + 1000,
      serial: 1,
      ...(overrides.deviceScope ? { scope: overrides.deviceScope } : {}),
    },
    identity.secret,
  );

  const leafScope = overrides.leafScope === undefined ? 'example.ox' : overrides.leafScope;
  const nodeGrant = signGrant(
    {
      issuer: device.pub,
      subject: node.pub,
      purposes: overrides.leafPurposes ?? [GrantPurpose.SERVICE_NODE],
      notBefore: NOW - 1000,
      notAfter: overrides.leafNotAfter ?? overrides.notAfter ?? NOW + 1000,
      serial: overrides.serial ?? 1,
      ...(leafScope === null ? {} : { scope: leafScope }),
    },
    device.secret,
  );

  const options: VerifyOptions = {
    trustedRoots: [identity.pub],
    now: NOW,
    requirePurpose: GrantPurpose.SERVICE_NODE,
    requireScope: 'example.ox',
  };
  return { identity, device, node, chain: [nodeGrant, deviceGrant] as Grant[], options };
}

function expectFailure(result: ReturnType<typeof verifyChain>, reason: VerifyFailure) {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe(reason);
}

describe('a well-formed chain verifies', () => {
  test('identity -> device -> node, scoped to a domain', () => {
    const { chain, options, node } = buildChain();
    const result = verifyChain(chain, options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.purposes).toContain(GrantPurpose.SERVICE_NODE);
    // The verified key comes back as bytes, so the caller never re-parses a string.
    expect([...result.subject]).toEqual([...node.raw]);
    expect(result.scope).toBe('example.ox');
    expect(result.serials).toHaveLength(2);
  });
});

describe('S3: a substituted key must not verify', () => {
  test('a key the owner never authorized is refused', () => {
    const { chain, options } = buildChain();
    const forged: Grant = { ...chain[0], subject: keypair().pub };
    expectFailure(verifyChain([forged, chain[1]], options), 'bad-signature');
  });

  test("an attacker's own self-rooted chain is refused", () => {
    const attacker = buildChain();
    expectFailure(
      verifyChain(attacker.chain, { ...attacker.options, trustedRoots: [keypair().pub] }),
      'untrusted-root',
    );
  });

  test('a key authorized for one domain does not verify for another', () => {
    const { chain, options } = buildChain({ leafScope: 'other.ox' });
    expectFailure(verifyChain(chain, options), 'scope-mismatch');
  });

  test('a leaf scoped to a parent domain does not verify for a subdomain', () => {
    // Covering-by-suffix is for intermediates. The key actually used must be
    // bound to exactly the name being connected to.
    const { chain, options } = buildChain();
    expectFailure(
      verifyChain(chain, { ...options, requireScope: 'www.example.ox' }),
      'scope-mismatch',
    );
  });

  test('a key authorized for a different purpose does not verify', () => {
    const { chain, options } = buildChain({
      leafPurposes: [GrantPurpose.CLIENT],
      devicePurposes: [GrantPurpose.DELEGATE, GrantPurpose.CLIENT],
      leafScope: null,
    });
    expectFailure(verifyChain(chain, options), 'purpose-not-granted');
  });
});

describe('scope is mandatory for domain-bound and relay purposes', () => {
  test('the type system refuses verifying a scoped purpose without a scope', () => {
    const { chain, identity } = buildChain();
    const run = () =>
      // @ts-expect-error requireScope is required for service-node
      verifyChain(chain, {
        trustedRoots: [identity.pub],
        now: NOW,
        requirePurpose: GrantPurpose.SERVICE_NODE,
      });
    // ...and the run time refuses it too, for callers that cast around the type.
    expectFailure(run(), 'scope-required');
  });

  for (const purpose of [
    GrantPurpose.SERVICE_NODE,
    GrantPurpose.DOMAIN_RECORDS,
    GrantPurpose.RELAY,
  ]) {
    test(`${purpose}: a missing or non-canonical requireScope is refused at run time`, () => {
      const { chain, identity } = buildChain();
      for (const requireScope of [undefined, '', 'Example.OX', 'example.ox.', ' example.ox']) {
        const result = verifyChain(chain, {
          trustedRoots: [identity.pub],
          now: NOW,
          requirePurpose: purpose,
          requireScope,
        } as unknown as VerifyOptions);
        expectFailure(result, 'scope-required');
      }
    });
  }

  test('a non-delegating grant carrying a scoped purpose but no scope is malformed', () => {
    const { chain, options, device } = buildChain();
    const { signature: _omit, scope: _scope, ...unscoped } = chain[0];
    expect(() => signGrant(unscoped, device.secret)).toThrow(/requires a scope/);
    // Hand-built, since signGrant refuses: still refused at verification.
    expectFailure(
      verifyChain([{ ...unscoped, signature: chain[0].signature }, chain[1]], options),
      'malformed',
    );
  });
});

describe('narrowing down the chain', () => {
  test('an intermediate scoped to a.ox cannot authorize a key for b.ox', () => {
    // The verified defect: only the leaf scope used to be checked.
    const { chain, options } = buildChain({ deviceScope: 'a.ox', leafScope: 'b.ox' });
    expectFailure(verifyChain(chain, { ...options, requireScope: 'b.ox' }), 'scope-mismatch');
  });

  test('an intermediate scoped to a.ox may authorize a.ox and its subdomains', () => {
    for (const leafScope of ['a.ox', 'www.a.ox', 'deep.www.a.ox']) {
      const { chain, options } = buildChain({ deviceScope: 'a.ox', leafScope });
      expect(verifyChain(chain, { ...options, requireScope: leafScope }).ok).toBe(true);
    }
  });

  test('a subdomain match is at a label boundary, not a string suffix', () => {
    const { chain, options } = buildChain({
      deviceScope: 'example.ox',
      leafScope: 'badexample.ox',
    });
    expectFailure(
      verifyChain(chain, { ...options, requireScope: 'badexample.ox' }),
      'scope-mismatch',
    );
  });

  test('an unscoped child of a scoped issuer is broader than its issuer, and refused', () => {
    const { chain, options } = buildChain({
      deviceScope: 'a.ox',
      devicePurposes: [GrantPurpose.DELEGATE, GrantPurpose.CLIENT],
      leafPurposes: [GrantPurpose.CLIENT],
      leafScope: null,
    });
    expectFailure(
      verifyChain(chain, {
        ...options,
        requirePurpose: GrantPurpose.CLIENT,
        requireScope: undefined,
      }),
      'scope-mismatch',
    );
  });

  test('a child cannot claim a purpose its issuer lacks', () => {
    // A device delegated for client use must not be able to mint a service-node key.
    const { chain, options } = buildChain({
      devicePurposes: [GrantPurpose.DELEGATE, GrantPurpose.CLIENT],
    });
    expectFailure(verifyChain(chain, options), 'purpose-not-granted');
  });

  test('a child cannot outlive its issuer', () => {
    const { chain, options } = buildChain({ notAfter: NOW + 1000, leafNotAfter: NOW + 5000 });
    expectFailure(verifyChain(chain, options), 'window-not-nested');
  });

  test('a child cannot start before its issuer', () => {
    const { chain, options, device, identity } = buildChain();
    const lateDevice = signGrant(
      {
        issuer: identity.pub,
        subject: device.pub,
        purposes: [GrantPurpose.DELEGATE, GrantPurpose.SERVICE_NODE],
        notBefore: NOW - 500,
        notAfter: NOW + 1000,
        serial: 1,
      },
      identity.secret,
    );
    expectFailure(verifyChain([chain[0], lateDevice], options), 'window-not-nested');
  });
});

describe('chain structure', () => {
  test('a leaf cannot mint its own siblings', () => {
    const { chain, options } = buildChain({
      devicePurposes: [GrantPurpose.SERVICE_NODE],
      deviceScope: 'example.ox',
    });
    expectFailure(verifyChain(chain, options), 'purpose-not-granted');
  });

  test('links must actually connect', () => {
    const { chain, options } = buildChain();
    const identity = keypair();
    const { signature: _omit, ...deviceUnsigned } = chain[1];
    // Re-signed so the failure is the broken link, not the signature.
    const resigned = signGrant(
      { ...deviceUnsigned, issuer: identity.pub, subject: keypair().pub },
      identity.secret,
    );
    expectFailure(
      verifyChain([chain[0], resigned], { ...options, trustedRoots: [identity.pub] }),
      'chain-broken',
    );
  });

  test('a self-issued grant is refused', () => {
    const self = keypair();
    const unsigned: UnsignedGrant = {
      issuer: self.pub,
      subject: self.pub,
      purposes: [GrantPurpose.SERVICE_NODE],
      notBefore: NOW - 10,
      notAfter: NOW + 10,
      serial: 1,
      scope: 'example.ox',
    };
    expect(() => signGrant(unsigned, self.secret)).toThrow(/self-issued/);
    const forged = { ...unsigned, signature: encodeBase64(new Uint8Array(64)) };
    expectFailure(
      verifyChain([forged], {
        trustedRoots: [self.pub],
        now: NOW,
        requirePurpose: GrantPurpose.SERVICE_NODE,
        requireScope: 'example.ox',
      }),
      'malformed',
    );
  });

  test('a cycle (a key appearing twice) is refused', () => {
    const a = keypair();
    const b = keypair();
    const window = { notBefore: NOW - 10, notAfter: NOW + 10, serial: 1 };
    const purposes = [GrantPurpose.DELEGATE, GrantPurpose.SERVICE_NODE];
    // a -> b -> a -> b: every link connects and every signature is real.
    const ab = signGrant({ issuer: a.pub, subject: b.pub, purposes, ...window }, a.secret);
    const ba = signGrant({ issuer: b.pub, subject: a.pub, purposes, ...window }, b.secret);
    const leaf = signGrant(
      { issuer: b.pub, subject: a.pub, purposes, scope: 'example.ox', ...window },
      b.secret,
    );
    expectFailure(
      verifyChain([leaf, ab, ba], {
        trustedRoots: [b.pub],
        now: NOW,
        requirePurpose: GrantPurpose.SERVICE_NODE,
        requireScope: 'example.ox',
      }),
      'malformed',
    );
  });

  test('an over-long chain is refused rather than walked', () => {
    const { chain, options } = buildChain();
    const tooLong = Array.from({ length: MAX_CHAIN_DEPTH + 1 }, () => chain[0]);
    expectFailure(verifyChain(tooLong, options), 'chain-too-long');
  });

  test('an empty chain is refused', () => {
    expectFailure(verifyChain([], buildChain().options), 'malformed');
  });
});

describe('time and revocation', () => {
  test('an expired grant is refused', () => {
    const { chain, options } = buildChain();
    expectFailure(verifyChain(chain, { ...options, now: NOW + 5000 }), 'expired');
  });

  test('a not-yet-valid grant is refused', () => {
    const { chain, options } = buildChain();
    expectFailure(verifyChain(chain, { ...options, now: NOW - 5000 }), 'not-yet-valid');
  });

  test('a non-integer `now` is a caller bug and throws', () => {
    const { chain, options } = buildChain();
    expect(() => verifyChain(chain, { ...options, now: NOW + 0.5 })).toThrow();
    expect(() => verifyChain(chain, { ...options, now: Number.NaN })).toThrow();
  });

  test('a revoked leaf, device or root is refused', () => {
    const { chain, options, node, device, identity } = buildChain();
    for (const key of [node.pub, device.pub, identity.pub]) {
      expectFailure(verifyChain(chain, { ...options, revoked: new Set([key]) }), 'revoked');
    }
  });

  test('revocation compares key bytes: a raw-bytes entry revokes the base64 key', () => {
    const { chain, options, node } = buildChain();
    expectFailure(verifyChain(chain, { ...options, revoked: [node.raw] }), 'revoked');
  });

  test('a non-canonical spelling in the revocation list throws instead of failing open', () => {
    // As strings, the URL-safe spelling would simply not match the grant's
    // spelling and the revoked device would verify. It is refused loudly.
    const { chain, options, device } = buildChain();
    expect(() =>
      verifyChain(chain, { ...options, revoked: new Set([urlSafe(device.pub)]) }),
    ).toThrow();
  });

  test('a rolled-back serial is refused; equal or higher is accepted', () => {
    const { chain, options, device, node } = buildChain({ serial: 3 });
    const key = serialKey(device.pub, node.pub);
    expectFailure(
      verifyChain(chain, { ...options, knownSerials: new Map([[key, 7]]) }),
      'rolled-back',
    );
    expect(verifyChain(chain, { ...options, knownSerials: new Map([[key, 3]]) }).ok).toBe(true);
  });

  test('serialKey is canonical: raw bytes and base64 give the same key', () => {
    const { device, node } = buildChain();
    expect(serialKey(device.raw, node.raw)).toBe(serialKey(device.pub, node.pub));
  });
});

describe('keys are bytes, at exactly 32', () => {
  test('a URL-safe spelling of a real key is refused in a grant', () => {
    const { chain, options, device } = buildChain();
    const respelled: Grant = { ...chain[1], subject: urlSafe(device.pub) };
    expectFailure(verifyChain([chain[0], respelled], options), 'malformed');
  });

  test('a URL-safe spelling of the root is refused in the trusted-root list', () => {
    const { chain, options, identity } = buildChain();
    if (urlSafe(identity.pub) === identity.pub) return; // no symbol to respell
    expect(() =>
      verifyChain(chain, { ...options, trustedRoots: [urlSafe(identity.pub)] }),
    ).toThrow();
  });

  test('a subject of the wrong length is refused', () => {
    const { chain, options } = buildChain();
    for (const length of [0, 31, 33, 64]) {
      const subject = encodeBase64(new Uint8Array(length).fill(7));
      expectFailure(verifyChain([{ ...chain[0], subject }, chain[1]], options), 'malformed');
    }
  });

  test('non-zero trailing bits, missing padding and whitespace are refused', () => {
    const { chain, options } = buildChain();
    // 32 bytes -> 44 chars: 42 full sextets, one carrying 2 data bits and 4
    // zero bits, then '='. Setting the lowest of those zero bits keeps the
    // decoded bytes identical under a lenient decoder.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const pub = chain[0].subject;
    const trailing = alphabet[alphabet.indexOf(pub[42]) + 1];
    expect(
      Buffer.from(`${pub.slice(0, 42)}${trailing}=`, 'base64').equals(Buffer.from(pub, 'base64')),
    ).toBe(true);
    for (const subject of [
      `${pub.slice(0, 42)}${trailing}=`, // non-zero trailing bits
      pub.slice(0, 43), // no padding
      ` ${pub}`,
      `${pub}\n`,
    ]) {
      expectFailure(verifyChain([{ ...chain[0], subject }, chain[1]], options), 'malformed');
    }
  });

  test('signGrant refuses a secret key that does not belong to the issuer', () => {
    const { chain, node } = buildChain();
    const { signature: _s, ...unsigned } = chain[0];
    expect(() => signGrant(unsigned, node.secret)).toThrow(/does not belong/);
  });
});

describe('canonical encoding', () => {
  const base = (): UnsignedGrant => ({
    issuer: keypair().pub,
    subject: keypair().pub,
    purposes: [GrantPurpose.DELEGATE, GrantPurpose.CLIENT],
    notBefore: 0,
    notAfter: 1,
    serial: 0,
  });

  test('swapping issuer and subject changes the bytes', () => {
    const a = base();
    const b = { ...a, issuer: a.subject, subject: a.issuer };
    expect(encodeBase64(canonicalGrantBytes(a))).not.toBe(encodeBase64(canonicalGrantBytes(b)));
  });

  test('purpose order does not change the bytes', () => {
    const a = base();
    const b = { ...a, purposes: [GrantPurpose.CLIENT, GrantPurpose.DELEGATE] };
    expect(encodeBase64(canonicalGrantBytes(a))).toBe(encodeBase64(canonicalGrantBytes(b)));
  });

  test('a duplicated purpose is refused', () => {
    expect(() =>
      canonicalGrantBytes({ ...base(), purposes: [GrantPurpose.CLIENT, GrantPurpose.CLIENT] }),
    ).toThrow(/twice/);
  });

  test('non-integer, negative, unsafe and non-finite times are refused, not truncated', () => {
    // The old encoder ran times through Math.trunc, so 1800000000.9 signed the
    // same bytes as 1800000000.
    for (const bad of [0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => canonicalGrantBytes({ ...base(), notAfter: bad })).toThrow();
      expect(() => canonicalGrantBytes({ ...base(), notBefore: bad, notAfter: 2 ** 40 })).toThrow();
      expect(() => canonicalGrantBytes({ ...base(), serial: bad })).toThrow();
    }
  });

  test('a fractional time on a signed grant is refused at verification', () => {
    const { chain, options } = buildChain();
    expectFailure(
      verifyChain([{ ...chain[0], notAfter: chain[0].notAfter + 0.9 }, chain[1]], options),
      'malformed',
    );
  });

  test('an unknown field is refused rather than carried along unsigned', () => {
    const { chain, options } = buildChain();
    const extra = { ...chain[0], admin: true } as unknown as Grant;
    expectFailure(verifyChain([extra, chain[1]], options), 'malformed');
  });

  test('changing any signed field breaks the signature', () => {
    const { chain, options } = buildChain({
      devicePurposes: [
        GrantPurpose.DELEGATE,
        GrantPurpose.SERVICE_NODE,
        GrantPurpose.CLIENT,
        GrantPurpose.DOMAIN_RECORDS,
      ],
    });
    const patches: Array<Partial<Grant>> = [
      { notAfter: NOW + 999 },
      { serial: 99 },
      { scope: 'attacker.ox' },
      { purposes: [GrantPurpose.SERVICE_NODE, GrantPurpose.DOMAIN_RECORDS] },
      { notBefore: NOW - 999 },
    ];
    for (const patch of patches) {
      const tampered: Grant = { ...chain[0], ...patch };
      const result = verifyChain([tampered, chain[1]], {
        ...options,
        requireScope: tampered.scope ?? 'example.ox',
      });
      expectFailure(result, 'bad-signature');
    }
  });

  test('a malformed signature is refused, not thrown on', () => {
    const { chain, options } = buildChain();
    for (const signature of ['', '!!!not base64!!!', 'AAAA', encodeBase64(new Uint8Array(63))]) {
      expectFailure(verifyChain([{ ...chain[0], signature }, chain[1]], options), 'malformed');
    }
  });
});

describe('malformed grants', () => {
  test('an inverted or empty validity window is refused', () => {
    const { chain, options } = buildChain();
    const inverted: Grant = { ...chain[0], notBefore: NOW + 100, notAfter: NOW - 100 };
    expectFailure(verifyChain([inverted, chain[1]], options), 'malformed');
  });

  test('an unknown purpose is refused rather than ignored', () => {
    const { chain, options } = buildChain();
    const bogus = { ...chain[0], purposes: ['root' as GrantPurposeValue] };
    expectFailure(verifyChain([bogus, chain[1]], options), 'malformed');
  });

  test('no purposes at all is refused', () => {
    const { chain, options } = buildChain();
    expectFailure(verifyChain([{ ...chain[0], purposes: [] }, chain[1]], options), 'malformed');
  });

  test('a non-canonical scope is refused', () => {
    const { chain, options } = buildChain();
    for (const scope of ['', 'Example.ox', 'example..ox', '-a.ox', 'a_b.ox', 'example.ox.']) {
      expectFailure(verifyChain([{ ...chain[0], scope }, chain[1]], options), 'malformed');
    }
  });
});
