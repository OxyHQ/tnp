import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { encodeBase64, generateSigningKeyPair } from '@tnp/crypto';
import { MAX_SERIALS_PER_PIN, PinStore, raiseSerials } from './pins';
import { invokingUser, OverlayStore, systemPasswd } from './store';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tnp-pinstore-'));
  dirs.push(dir);
  return join(dir, 'overlay');
}

const key = () => encodeBase64(generateSigningKeyPair().publicKey);

describe('PinStore across processes', () => {
  test("two stores on one file never lose each other's pins", () => {
    const r = root();
    const a = new PinStore(new OverlayStore(r));
    const b = new PinStore(new OverlayStore(r));
    a.get('one.ox'); // a stale reader in the old design
    b.record('two.ox', key(), []);
    a.record('one.ox', key(), []);
    expect(new PinStore(new OverlayStore(r)).list().map((p) => p.name)).toEqual([
      'one.ox',
      'two.ox',
    ]);
  });

  test('a forgotten pin is not resurrected by another running process', () => {
    const r = root();
    const daemon = new PinStore(new OverlayStore(r));
    daemon.record('gone.ox', key(), []);
    daemon.record('kept.ox', key(), []);
    new PinStore(new OverlayStore(r)).forget('gone.ox');
    daemon.record('other.ox', key(), []);
    expect(daemon.get('gone.ox')).toBeUndefined();
    expect(daemon.list().map((p) => p.name)).toEqual(['kept.ox', 'other.ox']);
  });

  // On Windows each write also sets and verifies an ACL (icacls and Windows
  // PowerShell, about a second), so fewer pins per process keep it in bounds.
  const perWorker = process.platform === 'win32' ? 3 : 15;
  test('concurrent processes recording at once all land', async () => {
    const r = root();
    const script = join(import.meta.dir, 'pins.worker.ts');
    const procs = [0, 1, 2, 3].map((n) =>
      Bun.spawn(['bun', script, r, String(n), String(perWorker)], {
        stdout: 'ignore',
        stderr: 'inherit',
      }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    expect(codes).toEqual([0, 0, 0, 0]);
    expect(new PinStore(new OverlayStore(r)).list()).toHaveLength(4 * perWorker);
  }, 120_000);

  test('a stale lock left by a crashed process is broken', () => {
    const r = root();
    const store = new OverlayStore(r);
    store.ensureDir(r);
    const lock = `${store.pinsPath}.lock`;
    writeFileSync(lock, '12345\n');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    new PinStore(store).record('after.ox', key(), []);
    expect(new PinStore(store).get('after.ox')).toBeDefined();
  });
});

describe('rollback marks', () => {
  test('a raised mark moves to the most recent end; the least recently raised go first', () => {
    let marks = raiseSerials({}, [
      { key: 'a', serial: 1 },
      { key: 'b', serial: 1 },
    ]);
    marks = raiseSerials(marks, [{ key: 'a', serial: 5 }]);
    expect(Object.keys(marks)).toEqual(['b', 'a']);
    expect(marks.a).toBe(5);
    // A lower serial never lowers the mark.
    expect(raiseSerials(marks, [{ key: 'a', serial: 2 }]).a).toBe(5);
    const many = Array.from({ length: MAX_SERIALS_PER_PIN + 10 }, (_, i) => ({
      key: `k${i}`,
      serial: i,
    }));
    const capped = raiseSerials(raiseSerials({}, [{ key: 'hot', serial: 9 }]), many);
    expect(Object.keys(capped)).toHaveLength(MAX_SERIALS_PER_PIN);
    expect(capped.hot).toBeUndefined();
    // Refreshing keeps a mark alive.
    const refreshed = raiseSerials(capped, [{ key: 'k0', serial: 0 }]);
    expect(Object.keys(refreshed).at(-1)).toBe('k0');
  });
});

describe('the invoking user under sudo', () => {
  // Real account databases: /etc/passwd on Linux, Directory Services (dscl)
  // on macOS, where /etc/passwd lists no ordinary users.
  test.skipIf(process.platform === 'win32')(
    'systemPasswd finds this account where the OS keeps it',
    () => {
      const me = userInfo();
      const line = systemPasswd(me.username)
        .split('\n')
        .find((l) => l.split(':')[0] === me.username);
      expect(line).toBeDefined();
      const fields = (line as string).split(':');
      expect(Number(fields[2])).toBe(me.uid);
      expect(fields[5]).toBe(me.homedir);
    },
  );

  const passwd = () => 'root:x:0:0:root:/root:/bin/sh\nalice:x:1000:1000::/home/alice:/bin/sh\n';

  test("root under sudo stores in the invoking user's home", () => {
    expect(
      invokingUser({ SUDO_USER: 'alice', SUDO_UID: '1000', SUDO_GID: '1000' }, 0, passwd),
    ).toEqual({ uid: 1000, gid: 1000, home: '/home/alice' });
  });

  test('not root, no sudo, or a mismatched uid: no substitution', () => {
    expect(
      invokingUser({ SUDO_USER: 'alice', SUDO_UID: '1000', SUDO_GID: '1000' }, 1000, passwd),
    ).toBeNull();
    expect(invokingUser({}, 0, passwd)).toBeNull();
    expect(
      invokingUser({ SUDO_USER: 'alice', SUDO_UID: '1001', SUDO_GID: '1000' }, 0, passwd),
    ).toBeNull();
    expect(invokingUser({ SUDO_USER: 'root', SUDO_UID: '0', SUDO_GID: '0' }, 0, passwd)).toBeNull();
  });
});
