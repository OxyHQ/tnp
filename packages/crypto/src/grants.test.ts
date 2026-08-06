import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import {
  canonicalGrantBytes,
  GrantPurpose,
  MAX_CHAIN_DEPTH,
  signGrant,
  verifyChain,
  type Grant,
  type GrantPurposeValue,
  type UnsignedGrant,
} from "./grants";

const NOW = 1_800_000_000;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function keypair() {
  const kp = nacl.sign.keyPair();
  return { pub: b64(kp.publicKey), secret: kp.secretKey };
}

/** Oxy identity → device → node, the hierarchy security.md §1 describes. */
function buildChain(
  overrides: {
    scope?: string;
    leafPurposes?: GrantPurposeValue[];
    devicePurposes?: GrantPurposeValue[];
    notAfter?: number;
    serial?: number;
  } = {},
) {
  const identity = keypair();
  const device = keypair();
  const node = keypair();

  const deviceGrant = signGrant(
    {
      issuer: identity.pub,
      subject: device.pub,
      purposes: overrides.devicePurposes ?? [GrantPurpose.DELEGATE],
      notBefore: NOW - 1000,
      notAfter: overrides.notAfter ?? NOW + 1000,
      serial: 1,
    },
    identity.secret,
  );

  const nodeGrant = signGrant(
    {
      issuer: device.pub,
      subject: node.pub,
      purposes: overrides.leafPurposes ?? [GrantPurpose.SERVICE_NODE],
      notBefore: NOW - 1000,
      notAfter: overrides.notAfter ?? NOW + 1000,
      serial: overrides.serial ?? 1,
      scope: overrides.scope ?? "example.ox",
    },
    device.secret,
  );

  return {
    identity,
    device,
    node,
    chain: [nodeGrant, deviceGrant] as Grant[],
    options: {
      trustedRoots: [identity.pub],
      now: NOW,
      requirePurpose: GrantPurpose.SERVICE_NODE,
      requireScope: "example.ox",
    },
  };
}

describe("a well-formed chain verifies", () => {
  test("identity -> device -> node, scoped to a domain", () => {
    const { chain, options } = buildChain();
    const result = verifyChain(chain, options);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.purposes).toContain(GrantPurpose.SERVICE_NODE);
  });
});

describe("S3: a substituted key must not verify", () => {
  // The whole point. The API used to hand clients any key it liked for any
  // domain, and the client checked nothing.
  test("a key the owner never authorized is refused", () => {
    const { chain, options } = buildChain();
    const attacker = keypair();

    // The attacker swaps in their own key as the leaf's subject. They cannot
    // re-sign it: they do not hold the device secret.
    const forged: Grant = { ...chain[0], subject: attacker.pub };
    const result = verifyChain([forged, chain[1]], options);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("bad-signature");
  });

  test("an attacker's own self-rooted chain is refused", () => {
    // A chain that verifies internally but terminates somewhere the client does
    // not trust. Signature checks alone would pass this.
    const attacker = buildChain();
    const result = verifyChain(attacker.chain, {
      ...attacker.options,
      trustedRoots: [keypair().pub],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("untrusted-root");
  });

  test("a key authorized for one domain does not verify for another", () => {
    // Without scope, "this key is valid" says nothing about "valid FOR
    // example.ox" — which is S3 wearing a signature.
    const { chain, options } = buildChain({ scope: "other.ox" });
    const result = verifyChain(chain, { ...options, requireScope: "example.ox" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("scope-mismatch");
  });

  test("a key authorized for a different purpose does not verify", () => {
    const { chain, options } = buildChain({ leafPurposes: [GrantPurpose.CLIENT] });
    const result = verifyChain(chain, options);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("purpose-not-granted");
  });
});

describe("chain structure", () => {
  test("a leaf cannot mint its own siblings", () => {
    // An intermediate that does not carry DELEGATE must not be able to sign a
    // grant that still reaches a trusted root.
    const { chain, options } = buildChain({
      devicePurposes: [GrantPurpose.SERVICE_NODE],
    });
    const result = verifyChain(chain, options);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("purpose-not-granted");
  });

  test("links must actually connect", () => {
    const { chain, options } = buildChain();
    const stranger = keypair();
    const disconnected: Grant = { ...chain[1], subject: stranger.pub };

    // Re-sign so the failure is the broken link, not the signature.
    const identity = keypair();
    const resigned = signGrant(
      { ...disconnected, issuer: identity.pub },
      identity.secret,
    );

    const result = verifyChain([chain[0], resigned], {
      ...options,
      trustedRoots: [identity.pub],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("chain-broken");
  });

  test("a self-issued grant is refused", () => {
    // A key authorizing itself proves nothing, and would let any key present
    // itself as its own root.
    const self = keypair();
    const grant = signGrant(
      {
        issuer: self.pub,
        subject: self.pub,
        purposes: [GrantPurpose.SERVICE_NODE],
        notBefore: NOW - 10,
        notAfter: NOW + 10,
        serial: 1,
        scope: "example.ox",
      },
      self.secret,
    );

    const result = verifyChain([grant], {
      trustedRoots: [self.pub],
      now: NOW,
      requirePurpose: GrantPurpose.SERVICE_NODE,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  test("an over-long chain is refused rather than walked", () => {
    // Unbounded recursion driven by remote input.
    const { chain, options } = buildChain();
    const tooLong = Array.from({ length: MAX_CHAIN_DEPTH + 1 }, () => chain[0]);
    const result = verifyChain(tooLong, options);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("chain-too-long");
  });

  test("an empty chain is refused", () => {
    const { options } = buildChain();
    expect(verifyChain([], options).ok).toBe(false);
  });
});

describe("time and revocation", () => {
  test("an expired grant is refused", () => {
    const { chain, options } = buildChain();
    const result = verifyChain(chain, { ...options, now: NOW + 5000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("expired");
  });

  test("a not-yet-valid grant is refused", () => {
    const { chain, options } = buildChain();
    const result = verifyChain(chain, { ...options, now: NOW - 5000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-yet-valid");
  });

  test("a revoked leaf is refused", () => {
    const { chain, options, node } = buildChain();
    const result = verifyChain(chain, { ...options, revoked: new Set([node.pub]) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("revoked");
  });

  test("a revoked DEVICE is refused, not just a revoked leaf", () => {
    // Losing a device must invalidate every key chained under it. Checking only
    // the leaf would let a stolen device keep minting fresh node keys.
    const { chain, options, device } = buildChain();
    const result = verifyChain(chain, { ...options, revoked: new Set([device.pub]) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("revoked");
  });

  test("a revoked ROOT IDENTITY is refused", () => {
    // The one key that appears ONLY as an issuer, never as a subject: the Oxy
    // identity at the top. A compromised Oxy account has to invalidate every
    // chain under it, and checking revocation on subjects alone cannot see it —
    // which is exactly what a surviving mutation of the issuer check revealed.
    const { chain, options, identity } = buildChain();
    const result = verifyChain(chain, { ...options, revoked: new Set([identity.pub]) });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("revoked");
  });

  test("a rolled-back serial is refused", () => {
    // Replaying an old but still-unexpired grant after a rotation would
    // re-enable a key its owner has already retired.
    const { chain, options, device, node } = buildChain({ serial: 3 });
    const result = verifyChain(chain, {
      ...options,
      knownSerials: new Map([[`${device.pub}|${node.pub}`, 7]]),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("rolled-back");
  });

  test("an equal or higher serial is accepted", () => {
    const { chain, options, device, node } = buildChain({ serial: 7 });
    expect(
      verifyChain(chain, {
        ...options,
        knownSerials: new Map([[`${device.pub}|${node.pub}`, 7]]),
      }).ok,
    ).toBe(true);
  });
});

describe("canonical encoding", () => {
  test("field boundaries cannot be moved", () => {
    // Without length prefixes, issuer "ab" + subject "c" and issuer "a" +
    // subject "bc" serialize identically, so a signature over one verifies the
    // other.
    const base: UnsignedGrant = {
      issuer: "ab",
      subject: "c",
      purposes: [GrantPurpose.CLIENT],
      notBefore: 0,
      notAfter: 1,
      serial: 0,
    };
    const shifted: UnsignedGrant = { ...base, issuer: "a", subject: "bc" };

    expect(Buffer.from(canonicalGrantBytes(base)).toString("hex")).not.toBe(
      Buffer.from(canonicalGrantBytes(shifted)).toString("hex"),
    );
  });

  test("purpose order does not change the bytes", () => {
    const a: UnsignedGrant = {
      issuer: "i",
      subject: "s",
      purposes: [GrantPurpose.DELEGATE, GrantPurpose.CLIENT],
      notBefore: 0,
      notAfter: 1,
      serial: 0,
    };
    const b: UnsignedGrant = { ...a, purposes: [GrantPurpose.CLIENT, GrantPurpose.DELEGATE] };

    expect(Buffer.from(canonicalGrantBytes(a)).toString("hex")).toBe(
      Buffer.from(canonicalGrantBytes(b)).toString("hex"),
    );
  });

  test("changing any signed field breaks the signature", () => {
    const { chain, options } = buildChain();
    const fields: Array<Partial<Grant>> = [
      { notAfter: NOW + 999_999 },
      { serial: 99 },
      { scope: "attacker.ox" },
      { purposes: [GrantPurpose.DELEGATE] },
      { notBefore: NOW - 999_999 },
    ];

    for (const patch of fields) {
      const tampered: Grant = { ...chain[0], ...patch };
      const result = verifyChain([tampered, chain[1]], {
        ...options,
        requireScope: undefined,
        requirePurpose: tampered.purposes[0],
      });
      expect(result.ok).toBe(false);
    }
  });

  test("a malformed signature is refused, not thrown on", () => {
    const { chain, options } = buildChain();
    for (const signature of ["", "!!!not base64!!!", "AAAA"]) {
      const result = verifyChain([{ ...chain[0], signature }, chain[1]], options);
      expect(result.ok).toBe(false);
    }
  });
});

describe("malformed grants", () => {
  test("an inverted or empty validity window is refused", () => {
    const { chain, options } = buildChain();
    const inverted: Grant = { ...chain[0], notBefore: NOW + 100, notAfter: NOW - 100 };
    const result = verifyChain([inverted, chain[1]], options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  test("an unknown purpose is refused rather than ignored", () => {
    const { chain, options } = buildChain();
    const bogus = { ...chain[0], purposes: ["root" as GrantPurposeValue] };
    const result = verifyChain([bogus, chain[1]], { ...options, requirePurpose: "root" as GrantPurposeValue });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });

  test("no purposes at all is refused", () => {
    const { chain, options } = buildChain();
    const result = verifyChain([{ ...chain[0], purposes: [] }, chain[1]], options);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });
});
