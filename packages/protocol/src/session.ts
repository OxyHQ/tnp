/**
 * TNP wire protocol v1 — end-to-end session cryptography.
 *
 * Normative spec: docs/architecture/transport.md §9.
 *
 * A client and a service node agree on keys through Noise NK (noise.ts): the
 * client knows the service node's static X25519 key from a verified
 * key-agreement certificate (`@tnp/crypto`), and has no static key of its own,
 * so it can stay anonymous to the service node. The relay in between carries
 * the two handshake messages and every sealed record, and can do nothing with
 * any of them except drop them:
 *
 *  - It cannot impersonate the service node: message 1 is encrypted to the
 *    certified static key, and message 2's tag can only be produced by someone
 *    who could read message 1 (key confirmation).
 *  - It cannot read past traffic even if the static key later leaks: the
 *    session keys also depend on both ephemerals (`ee`).
 *  - It cannot replay, reorder, reflect, splice, truncate or tamper with
 *    records without the receiving end noticing (see SessionCipher).
 *
 * What it CAN still see is in threat-model.md §2: who is talking to which
 * service, when, and how much. Nothing here hides metadata.
 */

import {
  bytesEqual,
  CanonicalWriter,
  isVerifiedKeyAgreementKey,
  KeyAgreementRole,
  type KeyAgreementRoleValue,
  type VerifiedKeyAgreementKey,
} from '@tnp/crypto';
import {
  assertValidX25519PublicKey,
  generateX25519KeyPair,
  wipe,
  x25519KeyPairFromSecret,
  type X25519KeyPair,
} from '@tnp/crypto/primitives';
import {
  ErrorCode,
  type ErrorCodeValue,
  type FrameTypeValue,
  HANDSHAKE_MESSAGE_SIZE,
  isFrameType,
  KEY_UPDATE_INTERVAL,
  KNOWN_FLAGS,
  MAX_FRAME_PAYLOAD,
  MAX_RECORDS_PER_KEY,
  MAX_SEALED_PLAINTEXT,
  PROTOCOL_VERSION,
  SEALED_RECORD_OVERHEAD,
} from './constants.js';
import {
  decryptWithAd,
  encryptWithAd,
  NkInitiator,
  NkResponder,
  NoiseError,
  rekey,
} from './noise.js';

const EMPTY = new Uint8Array(0);

/** Prologue context label. Bumped if the prologue layout ever changes. */
const SESSION_CONTEXT = 'tnp-session-v1';

/**
 * A session failed. `code` is what to send the peer (in a CIRCUIT_DESTROY or
 * ERROR); a session that threw one of these is dead in both directions.
 */
export class SessionError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCodeValue,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

/**
 * The sender has used its key for as many records as it may. Not a protocol
 * failure: call `updateKey()`, send the record it returns, and carry on.
 */
export class RekeyRequiredError extends Error {
  constructor() {
    super('record limit for this key reached; call updateKey() first');
    this.name = 'RekeyRequiredError';
  }
}

/** Per-session record limits. Can only be LOWERED from the protocol constants (tests do). */
export interface SessionLimits {
  /** Records per direction per key, last one reserved for KEY_UPDATE/CLOSE. Default MAX_RECORDS_PER_KEY. */
  maxRecordsPerKey?: number;
  /** Records after which `needsKeyUpdate` turns true. Default KEY_UPDATE_INTERVAL. */
  keyUpdateInterval?: number;
}

interface ResolvedLimits {
  maxRecordsPerKey: number;
  keyUpdateInterval: number;
}

function resolveLimits(limits: SessionLimits | undefined): ResolvedLimits {
  const maxRecordsPerKey = limits?.maxRecordsPerKey ?? MAX_RECORDS_PER_KEY;
  if (
    !Number.isSafeInteger(maxRecordsPerKey) ||
    maxRecordsPerKey < 2 ||
    maxRecordsPerKey > MAX_RECORDS_PER_KEY
  ) {
    throw new RangeError(`maxRecordsPerKey must be an integer in [2, ${MAX_RECORDS_PER_KEY}]`);
  }
  const keyUpdateInterval =
    limits?.keyUpdateInterval ?? Math.min(KEY_UPDATE_INTERVAL, maxRecordsPerKey - 1);
  if (
    !Number.isSafeInteger(keyUpdateInterval) ||
    keyUpdateInterval < 1 ||
    keyUpdateInterval > maxRecordsPerKey - 1
  ) {
    throw new RangeError('keyUpdateInterval must be an integer in [1, maxRecordsPerKey - 1]');
  }
  return { maxRecordsPerKey, keyUpdateInterval };
}

/**
 * The Noise prologue: context label, protocol major version, key role and the
 * exact name being connected to. Both sides must compute identical bytes or
 * the handshake fails — which is what binds the session to "TNP v1, service
 * node, example.ox" rather than to any session the same static key could
 * terminate. A relay that routes a client's handshake to a different name, or
 * strips the version, produces a mismatch and a failed handshake rather than a
 * silent downgrade.
 */
function sessionPrologue(role: KeyAgreementRoleValue, name: string): Uint8Array {
  return new CanonicalWriter()
    .string(SESSION_CONTEXT)
    .fixed(Uint8Array.of(PROTOCOL_VERSION), 1)
    .string(role)
    .string(name)
    .finish();
}

function toSessionError(err: unknown, fallback: string): SessionError {
  if (err instanceof SessionError) return err;
  if (err instanceof NoiseError && err.kind === 'dh') {
    return new SessionError(`handshake refused: ${err.message}`, ErrorCode.PROTOCOL_VIOLATION);
  }
  if (err instanceof NoiseError && err.kind === 'state') {
    return new SessionError(err.message, ErrorCode.PROTOCOL_VIOLATION);
  }
  return new SessionError(fallback, ErrorCode.AUTH_FAILED);
}

export interface ClientHandshakeOptions {
  /** The service node's key, as returned by `verifyKeyAgreementCertificate`. Nothing else is accepted. */
  serverKey: VerifiedKeyAgreementKey;
  /** The exact name being connected to. Must equal the key's certified scope. */
  name: string;
  /** Unix seconds, integer. A key whose certificate has expired is refused here too. */
  now: number;
  limits?: SessionLimits;
}

/**
 * The client (Noise initiator) side.
 *
 *   const hs = new ClientHandshake({ serverKey, name: 'example.ox', now });
 *   send(CIRCUIT_CREATE, hs.start());
 *   const session = hs.finish(await receive(CIRCUIT_CREATED));
 *
 * Single use: `start` once, then `finish` once. Any failure leaves it unusable.
 */
export class ClientHandshake {
  private readonly noise: NkInitiator;
  private readonly limits: ResolvedLimits;
  private state: 'new' | 'started' | 'done' = 'new';

  constructor(options: ClientHandshakeOptions) {
    if (!isVerifiedKeyAgreementKey(options.serverKey)) {
      // Security.md §5: an unchained key is not usable. A look-alike object
      // with the right fields is still an unchained key.
      throw new SessionError('server key was not produced by verification', ErrorCode.AUTH_FAILED);
    }
    if (options.name !== options.serverKey.scope) {
      throw new SessionError('server key is certified for another name', ErrorCode.AUTH_FAILED);
    }
    if (!Number.isSafeInteger(options.now) || options.now >= options.serverKey.notAfter) {
      throw new SessionError('server key certificate has expired', ErrorCode.AUTH_EXPIRED);
    }
    this.limits = resolveLimits(options.limits);
    const ephemeral = generateX25519KeyPair();
    this.noise = new NkInitiator(
      sessionPrologue(options.serverKey.role, options.name),
      options.serverKey.publicKey,
      ephemeral,
    );
    wipe(ephemeral.secretKey); // NkInitiator holds its own copy
  }

  /** Handshake message 1 — the payload of CIRCUIT_CREATE. Exactly HANDSHAKE_MESSAGE_SIZE bytes. */
  start(): Uint8Array {
    if (this.state !== 'new')
      throw new SessionError('handshake already started', ErrorCode.PROTOCOL_VIOLATION);
    this.state = 'started';
    // Empty payload: data in message 1 would be replayable and, being
    // encrypted only to the static key, not forward-secret.
    return this.noise.writeMessage1(EMPTY);
  }

  /**
   * Consume handshake message 2 (the CIRCUIT_CREATED payload) and return the
   * established session. Throws `SessionError` — AUTH_FAILED when the tag does
   * not verify, meaning whoever answered does not hold the certified key.
   */
  finish(message2: Uint8Array): SessionCipher {
    if (this.state !== 'started') {
      throw new SessionError('handshake not awaiting message 2', ErrorCode.PROTOCOL_VIOLATION);
    }
    this.state = 'done';
    if (!(message2 instanceof Uint8Array) || message2.length !== HANDSHAKE_MESSAGE_SIZE) {
      throw new SessionError(
        'handshake message 2 has the wrong size',
        ErrorCode.PROTOCOL_VIOLATION,
      );
    }
    try {
      const { split } = this.noise.readMessage2(message2);
      return new SessionCipher(
        SESSION_TOKEN,
        split.sendKey,
        split.receiveKey,
        split.handshakeHash,
        this.limits,
      );
    } catch (err) {
      throw toSessionError(
        err,
        'key confirmation failed: the responder does not hold the certified key',
      );
    }
  }
}

export interface ServerHandshakeOptions {
  /** The service node's certified X25519 key pair. */
  staticKey: X25519KeyPair;
  /** The name this session is for — the name the client is expected to have bound. */
  name: string;
  /** Defaults to service-node. */
  role?: KeyAgreementRoleValue;
  limits?: SessionLimits;
}

/**
 * The service node (Noise responder) side.
 *
 *   const hs = new ServerHandshake({ staticKey, name: 'example.ox' });
 *   const { message, session } = hs.respond(circuitCreatePayload);
 *   send(CIRCUIT_CREATED, message);
 *
 * Single use. A replayed message 1 produces a session nobody else can use —
 * the replayer never learns the client's ephemeral secret — so replay costs
 * the node one DH, which the relay-side handshake rate limit bounds.
 */
export class ServerHandshake {
  private readonly noise: NkResponder;
  private readonly limits: ResolvedLimits;
  private used = false;

  constructor(options: ServerHandshakeOptions) {
    const derived = x25519KeyPairFromSecret(options.staticKey.secretKey);
    if (!bytesEqual(derived.publicKey, options.staticKey.publicKey)) {
      throw new RangeError('staticKey.publicKey does not match staticKey.secretKey');
    }
    assertValidX25519PublicKey(derived.publicKey);
    this.limits = resolveLimits(options.limits);
    const ephemeral = generateX25519KeyPair();
    this.noise = new NkResponder(
      sessionPrologue(options.role ?? KeyAgreementRole.SERVICE_NODE, options.name),
      derived,
      ephemeral,
    );
    wipe(ephemeral.secretKey);
  }

  /**
   * Consume handshake message 1 and produce message 2 plus the session.
   * Throws `SessionError` — AUTH_FAILED when the client did not encrypt to
   * this node's static key, or bound a different name, role or version.
   */
  respond(message1: Uint8Array): { message: Uint8Array; session: SessionCipher } {
    if (this.used) throw new SessionError('handshake already used', ErrorCode.PROTOCOL_VIOLATION);
    this.used = true;
    if (!(message1 instanceof Uint8Array) || message1.length !== HANDSHAKE_MESSAGE_SIZE) {
      throw new SessionError(
        'handshake message 1 has the wrong size',
        ErrorCode.PROTOCOL_VIOLATION,
      );
    }
    try {
      this.noise.readMessage1(message1);
      const { message, split } = this.noise.writeMessage2(EMPTY);
      return {
        message,
        session: new SessionCipher(
          SESSION_TOKEN,
          split.sendKey,
          split.receiveKey,
          split.handshakeHash,
          this.limits,
        ),
      };
    } catch (err) {
      throw toSessionError(
        err,
        'handshake refused: not encrypted to this key, name, role or version',
      );
    }
  }
}

/** Record types, inside the encryption so a relay cannot tell a close from data by its type. */
export const RecordType = {
  DATA: 0x00,
  /** Authenticated close: the sender will send nothing more. Empty body. */
  CLOSE: 0x01,
  /** The sender switches to REKEY(k) and counter 0 for every later record. Empty body. */
  KEY_UPDATE: 0x02,
} as const;

export type OpenedRecord =
  | { type: 'data'; plaintext: Uint8Array }
  | { type: 'close' }
  | { type: 'key-update' };

/** Only the handshakes construct sessions; a hand-built one could reuse a key for both directions. */
const SESSION_TOKEN = Symbol('SessionCipher');

/**
 * An established session: one key and one counter per direction.
 *
 * Sealed record (the payload of the frame carrying it):
 *
 *   counter (u64, big-endian) ‖ ChaCha20-Poly1305(k, nonce(counter), ad, type(1) ‖ body)
 *
 * The counter is the AEAD nonce, so it is authenticated. It is sent in the
 * clear so that a receiver can tell a replay (counter below expected:
 * REPLAY_DETECTED) from a gap or reordering (counter above expected:
 * PROTOCOL_VIOLATION) from tampering (tag fails: DECRYPT_FAILED); acceptance is
 * strictly in order regardless. A reflected record fails because each
 * direction has its own key. A truncated stream is detected because a clean
 * end requires an authenticated CLOSE record.
 *
 * Every SessionError poisons the session in both directions: there is no
 * "skip the bad record and continue".
 */
export class SessionCipher {
  private sendKey: Uint8Array;
  private receiveKey: Uint8Array;
  private sendCounter = 0;
  private receiveCounter = 0;
  private sentClose = false;
  private receivedClose = false;
  private failed: SessionError | null = null;
  private readonly hash: Uint8Array;
  private readonly limits: ResolvedLimits;

  /** @internal Use ClientHandshake or ServerHandshake. */
  constructor(
    token: typeof SESSION_TOKEN,
    sendKey: Uint8Array,
    receiveKey: Uint8Array,
    handshakeHash: Uint8Array,
    limits: ResolvedLimits,
  ) {
    if (token !== SESSION_TOKEN) throw new TypeError('SessionCipher is created by a handshake');
    this.sendKey = sendKey;
    this.receiveKey = receiveKey;
    this.hash = handshakeHash;
    this.limits = limits;
  }

  /**
   * The Noise handshake hash: identical on both ends of this session and on
   * no other session. Public; usable as channel binding for application-layer
   * authentication run inside the session.
   */
  get handshakeHash(): Uint8Array {
    return this.hash.slice();
  }

  /** True once the sender should call `updateKey()` (KEY_UPDATE_INTERVAL records under this key). */
  get needsKeyUpdate(): boolean {
    return this.sendCounter >= this.limits.keyUpdateInterval;
  }

  /** Whether the peer's authenticated close has arrived. */
  get peerClosed(): boolean {
    return this.receivedClose;
  }

  /**
   * Seal `plaintext` (at most MAX_SEALED_PLAINTEXT bytes) into one record.
   * `associatedData` is authenticated but not sent — pass
   * `frameAssociatedData(...)` for the frame that will carry the record.
   */
  seal(plaintext: Uint8Array, associatedData: Uint8Array = EMPTY): Uint8Array {
    if (plaintext.length > MAX_SEALED_PLAINTEXT) {
      throw new RangeError(`plaintext of ${plaintext.length} bytes exceeds MAX_SEALED_PLAINTEXT`);
    }
    this.assertCanSend();
    // The last counter value is reserved for KEY_UPDATE / CLOSE.
    if (this.sendCounter >= this.limits.maxRecordsPerKey - 1) throw new RekeyRequiredError();
    return this.sealRecord(RecordType.DATA, plaintext, associatedData);
  }

  /** The authenticated close record. After it, `seal` and `updateKey` throw. */
  close(associatedData: Uint8Array = EMPTY): Uint8Array {
    this.assertCanSend();
    const record = this.sealRecord(RecordType.CLOSE, EMPTY, associatedData);
    this.sentClose = true;
    wipe(this.sendKey);
    return record;
  }

  /**
   * A KEY_UPDATE record, sent under the current key; every later record uses
   * REKEY(k) from counter 0. The old key is wiped, so it cannot be recovered
   * from this object afterwards.
   */
  updateKey(associatedData: Uint8Array = EMPTY): Uint8Array {
    this.assertCanSend();
    const record = this.sealRecord(RecordType.KEY_UPDATE, EMPTY, associatedData);
    const next = rekey(this.sendKey);
    wipe(this.sendKey);
    this.sendKey = next;
    this.sendCounter = 0;
    return record;
  }

  /**
   * Open one record. Throws `SessionError` on anything but the exact next
   * record, authentic, under the current key — and the session is dead after.
   */
  open(record: Uint8Array, associatedData: Uint8Array = EMPTY): OpenedRecord {
    if (this.failed) throw this.failed;
    try {
      return this.openRecord(record, associatedData);
    } catch (err) {
      if (err instanceof SessionError) this.poison(err);
      throw err;
    }
  }

  /**
   * Call when the underlying transport or circuit ends. Throws
   * SessionError(TRUNCATED) unless the peer's authenticated close arrived
   * first: without that check, a relay that cuts the stream after a partial
   * response is indistinguishable from the service finishing.
   */
  transportEnded(): void {
    if (this.failed) throw this.failed;
    if (!this.receivedClose) {
      this.poison(
        new SessionError('stream ended without an authenticated close', ErrorCode.TRUNCATED),
      );
      throw this.failed;
    }
  }

  private assertCanSend(): void {
    if (this.failed) throw this.failed;
    if (this.sentClose)
      throw new SessionError('session already closed for sending', ErrorCode.PROTOCOL_VIOLATION);
    // Reachable only by sending KEY_UPDATE/CLOSE at the reserved last slot and
    // then trying again without a new key — a caller bug, never wraparound.
    if (this.sendCounter >= this.limits.maxRecordsPerKey) throw new RekeyRequiredError();
  }

  private sealRecord(type: number, body: Uint8Array, ad: Uint8Array): Uint8Array {
    const inner = new Uint8Array(1 + body.length);
    inner[0] = type;
    inner.set(body, 1);
    const counter = this.sendCounter++;
    const sealed = encryptWithAd(this.sendKey, BigInt(counter), ad, inner);
    const record = new Uint8Array(8 + sealed.length);
    new DataView(record.buffer).setBigUint64(0, BigInt(counter), false);
    record.set(sealed, 8);
    return record;
  }

  private openRecord(record: Uint8Array, ad: Uint8Array): OpenedRecord {
    if (this.receivedClose) {
      throw new SessionError('record after authenticated close', ErrorCode.PROTOCOL_VIOLATION);
    }
    if (record.length < SEALED_RECORD_OVERHEAD || record.length > MAX_FRAME_PAYLOAD) {
      throw new SessionError('sealed record has an impossible size', ErrorCode.PROTOCOL_VIOLATION);
    }
    const counter = new DataView(record.buffer, record.byteOffset, 8).getBigUint64(0, false);
    const expected = BigInt(this.receiveCounter);
    if (counter < expected) {
      throw new SessionError('record counter already used', ErrorCode.REPLAY_DETECTED);
    }
    if (counter > expected) {
      throw new SessionError('record out of order', ErrorCode.PROTOCOL_VIOLATION);
    }
    if (this.receiveCounter >= this.limits.maxRecordsPerKey) {
      throw new SessionError(
        'peer exceeded the record limit without a key update',
        ErrorCode.PROTOCOL_VIOLATION,
      );
    }

    const inner = decryptWithAd(this.receiveKey, counter, ad, record.subarray(8));
    if (!inner) throw new SessionError('record failed authentication', ErrorCode.DECRYPT_FAILED);
    this.receiveCounter++;

    const type = inner[0];
    if (type === RecordType.DATA) {
      // The sender reserves the last slot; data in it means the peer ignored the limit.
      if (this.receiveCounter >= this.limits.maxRecordsPerKey) {
        throw new SessionError('data record in the reserved slot', ErrorCode.PROTOCOL_VIOLATION);
      }
      return { type: 'data', plaintext: inner.subarray(1) };
    }
    if (inner.length !== 1) {
      throw new SessionError('control record with a body', ErrorCode.PROTOCOL_VIOLATION);
    }
    if (type === RecordType.CLOSE) {
      this.receivedClose = true;
      wipe(this.receiveKey);
      return { type: 'close' };
    }
    if (type === RecordType.KEY_UPDATE) {
      const next = rekey(this.receiveKey);
      wipe(this.receiveKey);
      this.receiveKey = next;
      this.receiveCounter = 0;
      return { type: 'key-update' };
    }
    throw new SessionError('unknown record type', ErrorCode.PROTOCOL_VIOLATION);
  }

  private poison(error: SessionError): void {
    if (this.failed) return;
    this.failed = error;
    wipe(this.sendKey);
    wipe(this.receiveKey);
  }
}

/**
 * Associated data for a sealed record carried in a frame: version(1) type(1)
 * flags(2) streamId(4), big-endian — the header minus `circuitId` and
 * `payloadLength`.
 *
 * Binding these means a relay cannot move a record to another stream, turn a
 * STREAM_DATA into a STREAM_CLOSE, or flip a half-close flag. `circuitId` is
 * left out because it is connection-scoped: it legitimately differs on each
 * side of a relay. `payloadLength` is implied by the record itself.
 */
export function frameAssociatedData(
  type: FrameTypeValue,
  flags: number,
  streamId: number,
): Uint8Array {
  if (!isFrameType(type)) throw new RangeError(`Unknown frame type: ${type}`);
  if (!Number.isInteger(flags) || flags < 0 || (flags & ~KNOWN_FLAGS) !== 0) {
    throw new RangeError(`Invalid flags: ${flags}`);
  }
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) {
    throw new RangeError(`streamId out of range: ${streamId}`);
  }
  const ad = new Uint8Array(8);
  const view = new DataView(ad.buffer);
  ad[0] = PROTOCOL_VERSION;
  ad[1] = type;
  view.setUint16(2, flags, false);
  view.setUint32(4, streamId, false);
  return ad;
}
