import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { encodeBase64, followDomainKeyRotations } from '@tnp/crypto';
import type { DomainKeyRecord, RegisterDomainKeyRequest } from '@tnp/shared-types';
import type { TnpApiClient } from '../api';
import { cmdDomain } from './commands';
import { createDomainKey, loadKeyPair } from './identity';
import { OverlayStore } from './store';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function store(): OverlayStore {
  const dir = mkdtempSync(join(tmpdir(), 'tnp-commands-'));
  dirs.push(dir);
  return new OverlayStore(join(dir, 'overlay'), null);
}

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  return fn().finally(() => {
    console.log = log;
  });
}

describe('tnp domain key rotate', () => {
  test('leaves only the new key on disk: no .previous, no .pending', async () => {
    const s = store();
    const old = createDomainKey(s, 'example.ox');
    const sent: RegisterDomainKeyRequest[] = [];
    const api = {
      async registerDomainKey(req: RegisterDomainKeyRequest): Promise<DomainKeyRecord> {
        sent.push(req);
        return { name: req.name, domainKey: req.domainKey, rotations: [] };
      },
    } as unknown as TnpApiClient;
    await quiet(() => cmdDomain(['key', 'rotate', 'example.ox'], api, async () => 'token', s));

    const current = loadKeyPair(s, 'domain-keys', 'example.ox');
    expect(current && encodeBase64(current.publicKey)).toBe(sent[0].domainKey);
    const path = s.pathFor('domain-keys', 'example.ox');
    expect(readdirSync(dirname(path))).toEqual(['example.ox.json']);
    // And the statement the registry got really links old → new.
    const rotation = sent[0].rotation;
    if (!rotation) throw new Error('no rotation sent');
    expect(
      followDomainKeyRotations({
        name: 'example.ox',
        pinned: old.publicKey,
        current: sent[0].domainKey,
        rotations: [rotation],
      }).ok,
    ).toBe(true);
  });

  test('a refused rotation keeps the current key and leaves nothing behind', async () => {
    const s = store();
    const old = createDomainKey(s, 'example.ox');
    const api = {
      async registerDomainKey(): Promise<DomainKeyRecord> {
        throw new Error('403');
      },
    } as unknown as TnpApiClient;
    await expect(
      quiet(() => cmdDomain(['key', 'rotate', 'example.ox'], api, async () => 'token', s)),
    ).rejects.toThrow('403');
    const path = s.pathFor('domain-keys', 'example.ox');
    expect(encodeBase64(loadKeyPair(s, 'domain-keys', 'example.ox')?.publicKey as Uint8Array)).toBe(
      encodeBase64(old.publicKey),
    );
    expect(existsSync(`${path}.pending`)).toBe(false);
  });

  test('an interrupted rotation is reported, not mistaken for "no key"', () => {
    const s = store();
    const path = s.pathFor('domain-keys', 'example.ox');
    s.writePrivate(`${path}.pending`, '{}');
    expect(() => loadKeyPair(s, 'domain-keys', 'example.ox')).toThrow('interrupted');
  });
});
