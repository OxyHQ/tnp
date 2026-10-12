import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeBase64,
  generateSigningKeyPair,
  type SignedRelayDirectory,
  signRelayDirectory,
  toHex,
} from '@tnp/crypto';
import { OverlayStore } from './overlay/store';
import {
  type DirectoryStateStore,
  FileDirectoryStateStore,
  MemoryDirectoryStateStore,
  RelayDirectoryClient,
  RelayDirectoryError,
} from './relay-directory';

const signer = generateSigningKeyPair();
const relayKey = generateSigningKeyPair().publicKey;
const T0 = 1_800_000_000;
const MARK = toHex(signer.publicKey);

function doc(
  serial: number,
  opts: { issuedAt?: number; lifetime?: number; secretKey?: Uint8Array } = {},
) {
  const issuedAt = opts.issuedAt ?? serial;
  return signRelayDirectory(
    {
      v: 1,
      serial,
      issuedAt,
      expiresAt: issuedAt + (opts.lifetime ?? 6 * 3600),
      relays: [
        {
          endpoint: 'wss://relay.tnp.network',
          relayKey: encodeBase64(relayKey),
          operator: 'oxy',
          capabilities: ['service', 'tunnel'],
          region: '',
        },
      ],
    },
    opts.secretKey ?? signer.secretKey,
  );
}

function client(
  fetchDocument: () => Promise<unknown>,
  store: DirectoryStateStore = new MemoryDirectoryStateStore(),
  now = () => T0 + 10,
  trustedKeys: Uint8Array[] = [signer.publicKey],
) {
  const logs: string[] = [];
  const c = new RelayDirectoryClient({
    fetchDocument,
    store,
    trustedKeys,
    now,
    refreshAfterSeconds: 0,
    log: (m) => logs.push(m),
  });
  return { c, logs, store };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function overlayStore(): OverlayStore {
  const dir = mkdtempSync(join(tmpdir(), 'tnp-dir-test-'));
  dirs.push(dir);
  return new OverlayStore(join(dir, 'overlay'), null);
}

describe('RelayDirectoryClient', () => {
  test('a valid directory is used; entryFor and relayKeyFor read it', async () => {
    const { c } = client(async () => doc(T0));
    expect((await c.get()).serial).toBe(T0);
    expect(await c.relayKeyFor('wss://Relay.TNP.network/')).toEqual(relayKey);
    expect(await c.entryFor('wss://relay.tnp.network')).toEqual({ key: relayKey, operator: 'oxy' });
    expect(await c.relayKeyFor('wss://unlisted.example.org')).toBeNull();
    expect(await c.relayKeyFor('not a url')).toBeNull();
  });

  test('no directory at all: an error, and relayKeyFor throws rather than answering null', async () => {
    for (const body of [
      { not: 'a directory' },
      doc(T0, { secretKey: generateSigningKeyPair().secretKey }), // wrong key
      { ...doc(T0), signature: doc(T0 - 1).signature }, // bad signature
      doc(T0 - 90_000), // expired
    ]) {
      const { c } = client(async () => body);
      await expect(c.get()).rejects.toBeInstanceOf(RelayDirectoryError);
      await expect(c.relayKeyFor('wss://relay.tnp.network')).rejects.toBeInstanceOf(
        RelayDirectoryError,
      );
    }
    const { c } = client(async () => {
      throw new Error('the API serves no signed relay directory (503)');
    });
    await expect(c.get()).rejects.toThrow('503');
  });

  test('rollback is refused across restarts: the mark is persisted', async () => {
    const store = new MemoryDirectoryStateStore();
    await client(async () => doc(T0 + 5), store).c.get();
    // A new process, sharing the state, is served an older (still unexpired) document.
    const { c, logs } = client(async () => doc(T0), store);
    const d = await c.get();
    // It keeps the newer one it already holds, and says why.
    expect(d.serial).toBe(T0 + 5);
    expect(logs.join('\n')).toContain('rollback refused');
    expect(store.load()?.marks[MARK]).toBe(T0 + 5);
  });

  test('rollback with no usable cached copy is an error, not an acceptance', async () => {
    const store = new MemoryDirectoryStateStore();
    store.merge({ marks: { [MARK]: T0 + 5 }, document: null });
    await expect(client(async () => doc(T0), store).c.get()).rejects.toThrow('rollback');
  });

  test('marks are per signing key: a rotation is not held hostage by the old key', async () => {
    // The old key signed a document dated a little ahead (within the allowed
    // skew), raising its own mark. The next key's honest, earlier-dated
    // documents are judged against the next key's mark only.
    const next = generateSigningKeyPair();
    const store = new MemoryDirectoryStateStore();
    const ahead = T0 + 500;
    await client(
      async () => doc(ahead),
      store,
      () => T0,
    ).c.get();
    const rotated = doc(T0 + 10, { secretKey: next.secretKey });
    const { c } = client(
      async () => rotated,
      store,
      () => T0 + 20,
      [signer.publicKey, next.publicKey],
    );
    expect((await c.get()).serial).toBe(T0 + 10);
    // The old key still cannot roll itself back.
    const back = client(
      async () => doc(T0 + 30),
      store,
      () => T0 + 40,
      [signer.publicKey],
    );
    await expect(back.c.get()).resolves.toMatchObject({ serial: ahead });
  });

  test('when the API is unreachable, the cached signed copy is used until it expires', async () => {
    const store = new MemoryDirectoryStateStore();
    await client(async () => doc(T0, { lifetime: 3600 }), store).c.get();
    let now = T0 + 100;
    const offline = client(
      async () => {
        throw new Error('network down');
      },
      store,
      () => now,
    );
    expect((await offline.c.get()).serial).toBe(T0);
    expect(offline.logs.join('\n')).toContain('using the cached signed directory');
    now = T0 + 3600;
    await expect(offline.c.get()).rejects.toThrow('network down');
  });

  test('a tampered cached document is not used', async () => {
    const store = new MemoryDirectoryStateStore();
    const good = doc(T0);
    const tampered: SignedRelayDirectory = {
      ...good,
      relays: [{ ...good.relays[0], endpoint: 'wss://evil.example.org' }],
    };
    store.merge({ marks: { [MARK]: T0 }, document: tampered });
    await expect(
      client(async () => {
        throw new Error('offline');
      }, store).c.get(),
    ).rejects.toThrow('offline');
  });
});

describe('FileDirectoryStateStore', () => {
  test('private, merged under a lock, and never lowers a mark another process raised', async () => {
    const overlay = overlayStore();
    const a = new FileDirectoryStateStore(overlay);
    const b = new FileDirectoryStateStore(overlay);
    await client(async () => doc(T0 + 9), a).c.get();
    b.merge({ marks: { [MARK]: T0 }, document: doc(T0) });
    expect(a.load()?.marks[MARK]).toBe(T0 + 9);
    expect(a.load()?.document?.serial).toBe(T0 + 9);
    if (process.platform !== 'win32') expect(statSync(a.path).mode & 0o077).toBe(0);
  });

  test('a corrupt, unknown or non-regular state file fails closed instead of resetting the marks', async () => {
    const overlay = overlayStore();
    const store = new FileDirectoryStateStore(overlay);
    mkdirSync(overlay.root, { recursive: true, mode: 0o700 });
    for (const content of [
      '{not json',
      '{"version":1,"highestSerial":5}',
      '{"version":2,"marks":{"x":1}}',
    ]) {
      writeFileSync(store.path, content, { mode: 0o600 });
      expect(() => store.load()).toThrow(RelayDirectoryError);
      await expect(client(async () => doc(T0), store).c.get()).rejects.toThrow('refusing');
    }
    rmSync(store.path);
    symlinkSync('/dev/null', store.path);
    expect(() => store.load()).toThrow('not a regular file');
    await expect(client(async () => doc(T0), store).c.get()).rejects.toThrow(RelayDirectoryError);
  });
});
