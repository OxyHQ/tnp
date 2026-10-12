import { describe, expect, test } from 'bun:test';
import { x25519KeyPairFromSecret } from '@tnp/crypto/primitives';
import { decryptWithAd, encryptWithAd, NkInitiator, NkResponder, rekey } from './noise';

const hex = (s: string) =>
  Uint8Array.from(s.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? []);
const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/**
 * The published Noise_NK_25519_ChaChaPoly_SHA256 vector from the cacophony
 * test suite (haskell-cryptography/cacophony, vectors/cacophony.txt). Matching
 * it byte for byte is what lets transport.md say "Noise NK" rather than
 * "something Noise-like": the handshake, the HKDF chaining, Split() and the
 * transport nonce encoding are all exercised.
 */
const VECTOR = {
  prologue: '4a6f686e2047616c74',
  initEphemeral: '893e28b9dc6ca8d611ab664754b8ceb7bac5117349a4439a6b0569da977c464a',
  respStatic: '4a3acbfdb163dec651dfa3194dece676d437029c62a408b4c5ea9114246e4893',
  respEphemeral: 'bbdb4cdbd309f1a1f2e1456967fe288cadd6f712d65dc7b7793d5e63da6b375b',
  handshakeHash: '2efa38a9c7c93ac98f3a097af25c2f58b9e7673787717bc27e98827118c2c1a5',
  messages: [
    {
      payload: '4c756477696720766f6e204d69736573',
      ciphertext:
        'ca35def5ae56cec33dc2036731ab14896bc4c75dbb07a61f879f8e3afa4c79448134d00711fdb390a0d178fa008f6d47d2891e5ea18ae136c3b4c23ac384efb0',
    },
    {
      payload: '4d757272617920526f746862617264',
      ciphertext:
        '95ebc60d2b1fa672c1f46a8aa265ef51bfe38e7ccb39ec5be34069f1448088438ea16e3701bc0d77744f117bee22451c9afa7f4cdbbcff00c04a8ee0913c88',
    },
    {
      payload: '462e20412e20486179656b',
      ciphertext: 'a62de29ce27cb80245d440d986ed816c156e9d757d7008df2198b0',
    },
    {
      payload: '4361726c204d656e676572',
      ciphertext: '174a35f11c689f4530d7208618e0564ae12f2f50ba8eb4df5382ff',
    },
    {
      payload: '4a65616e2d426170746973746520536179',
      ciphertext: '337e475ebb8eae60f91974c4e455a5af38d1d8628d1803b160d60442874b0a1777',
    },
    {
      payload: '457567656e2042f6686d20766f6e2042617765726b',
      ciphertext: '047e80e060b7bb08b53c5a23dfe9920cae135b9d1dc6302fc475003062723700366346ac9d',
    },
  ],
};

describe('Noise NK matches the published test vector', () => {
  test('handshake messages, handshake hash and transport messages', () => {
    const responderStatic = x25519KeyPairFromSecret(hex(VECTOR.respStatic));
    const initiator = new NkInitiator(
      hex(VECTOR.prologue),
      responderStatic.publicKey,
      x25519KeyPairFromSecret(hex(VECTOR.initEphemeral)),
    );
    const responder = new NkResponder(
      hex(VECTOR.prologue),
      responderStatic,
      x25519KeyPairFromSecret(hex(VECTOR.respEphemeral)),
    );

    const [m1, m2, ...transport] = VECTOR.messages;

    const msg1 = initiator.writeMessage1(hex(m1.payload));
    expect(toHex(msg1)).toBe(m1.ciphertext);
    expect(toHex(responder.readMessage1(msg1))).toBe(m1.payload);

    const { message: msg2, split: respSplit } = responder.writeMessage2(hex(m2.payload));
    expect(toHex(msg2)).toBe(m2.ciphertext);
    const { payload, split: initSplit } = initiator.readMessage2(msg2);
    expect(toHex(payload)).toBe(m2.payload);

    expect(toHex(initSplit.handshakeHash)).toBe(VECTOR.handshakeHash);
    expect(toHex(respSplit.handshakeHash)).toBe(VECTOR.handshakeHash);

    // Split(): the initiator's send key is the responder's receive key, and
    // the two directions differ.
    expect(toHex(initSplit.sendKey)).toBe(toHex(respSplit.receiveKey));
    expect(toHex(initSplit.receiveKey)).toBe(toHex(respSplit.sendKey));
    expect(toHex(initSplit.sendKey)).not.toBe(toHex(initSplit.receiveKey));

    // Transport messages alternate, initiator first, each direction counting from 0.
    transport.forEach((m, i) => {
      const fromInitiator = i % 2 === 0;
      const key = fromInitiator ? initSplit.sendKey : respSplit.sendKey;
      const n = BigInt(Math.floor(i / 2));
      const ct = encryptWithAd(key, n, new Uint8Array(0), hex(m.payload));
      expect(toHex(ct)).toBe(m.ciphertext);
      const peerKey = fromInitiator ? respSplit.receiveKey : initSplit.receiveKey;
      expect(toHex(decryptWithAd(peerKey, n, new Uint8Array(0), ct) ?? new Uint8Array())).toBe(
        m.payload,
      );
    });
  });

  test('a prologue mismatch fails the handshake', () => {
    const responderStatic = x25519KeyPairFromSecret(hex(VECTOR.respStatic));
    const initiator = new NkInitiator(
      hex('00'),
      responderStatic.publicKey,
      x25519KeyPairFromSecret(hex(VECTOR.initEphemeral)),
    );
    const responder = new NkResponder(
      hex(VECTOR.prologue),
      responderStatic,
      x25519KeyPairFromSecret(hex(VECTOR.respEphemeral)),
    );
    expect(() => responder.readMessage1(initiator.writeMessage1(new Uint8Array(0)))).toThrow(
      /authentication/,
    );
  });

  test('REKEY is deterministic, one-way and changes the key', () => {
    const k = new Uint8Array(32).fill(7);
    const k1 = rekey(k);
    expect(k1.length).toBe(32);
    expect(toHex(k1)).not.toBe(toHex(k));
    expect(toHex(rekey(k))).toBe(toHex(k1));
  });
});
