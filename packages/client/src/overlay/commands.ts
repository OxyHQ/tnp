/**
 * `tnp domain …` and `tnp pins …`: managing domain keys, node grants and
 * the client's pinned domain keys (docs/architecture/security.md §1).
 */

import { writeFileSync } from 'node:fs';
import { decodeBase64Strict, encodeBase64, generateSigningKeyPair } from '@tnp/crypto';
import { isCanonicalName } from '@tnp/shared-types';
import type { TnpApiClient } from '../api';
import {
  createDomainKey,
  issueNodeGrant,
  loadKeyPair,
  NODE_GRANT_LIFETIME,
  signRotation,
} from './identity';
import { PinStore } from './pins';
import { OverlayStore } from './store';

const nowSeconds = () => Math.floor(Date.now() / 1000);

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 || i + 1 >= argv.length ? undefined : argv[i + 1];
}

function requireName(value: string | undefined, usage: string): string {
  const name = value?.trim().toLowerCase().replace(/\.$/, '');
  if (!name || !isCanonicalName(name) || name.split('.').length !== 2) {
    throw new Error(`usage: ${usage}`);
  }
  return name;
}

export const DOMAIN_USAGE = `
  tnp domain key init <name>      Create the domain key on this device and register it
  tnp domain key show <name>      Print the domain key this device holds and the registry's
  tnp domain key rotate <name>    Replace the domain key; the old key signs the change
  tnp domain grant <name> --node-key <base64> [--days N] [--out file]
                                  Authorize a service node on another device
  (init and rotate need TNP_TOKEN or --token-stdin)`;

/** `tnp domain …`. `token` is read by the caller (TNP_TOKEN / --token-stdin). */
export async function cmdDomain(
  argv: string[],
  api: TnpApiClient,
  token: () => Promise<string | null>,
  store = new OverlayStore(),
): Promise<void> {
  const [sub, action, rawName] = argv;
  if (sub === 'key' && action === 'init') {
    const name = requireName(rawName, 'tnp domain key init <name>');
    const auth = await token();
    if (!auth) throw new Error('an Oxy auth token is required: set TNP_TOKEN or use --token-stdin');
    const registered = await api.getDomainKey(name);
    const existing = loadKeyPair(store, 'domain-keys', name);
    if (registered && (!existing || encodeBase64(existing.publicKey) !== registered.domainKey)) {
      throw new Error(
        `${name} already has a different domain key registered. Use \`tnp domain key rotate\` on the device that holds it.`,
      );
    }
    const kp = existing ?? createDomainKey(store, name);
    if (!registered)
      await api.registerDomainKey({ name, domainKey: encodeBase64(kp.publicKey) }, auth);
    console.log(`domain key for ${name}: ${encodeBase64(kp.publicKey)}`);
    console.log(
      `stored at ${store.pathFor('domain-keys', name)} — back it up; it is the root of trust for ${name}`,
    );
    return;
  }
  if (sub === 'key' && action === 'show') {
    const name = requireName(rawName, 'tnp domain key show <name>');
    const local = loadKeyPair(store, 'domain-keys', name);
    const registered = await api.getDomainKey(name).catch(() => null);
    console.log(`this device: ${local ? encodeBase64(local.publicKey) : '(none)'}`);
    console.log(`registry:    ${registered ? registered.domainKey : '(none)'}`);
    if (local && registered && encodeBase64(local.publicKey) !== registered.domainKey) {
      console.log("WARNING: they differ. Clients that pinned your key will refuse the registry's.");
    }
    return;
  }
  if (sub === 'key' && action === 'rotate') {
    const name = requireName(rawName, 'tnp domain key rotate <name>');
    const auth = await token();
    if (!auth) throw new Error('an Oxy auth token is required: set TNP_TOKEN or use --token-stdin');
    const current = loadKeyPair(store, 'domain-keys', name);
    if (!current) throw new Error(`this device does not hold the domain key for ${name}`);
    const next = generateSigningKeyPair();
    const rotation = signRotation(current, next.publicKey, name, nowSeconds());
    // The new key is on disk BEFORE the registry hears of it: a crash between
    // the two must never leave a registered key nobody holds.
    const path = store.pathFor('domain-keys', name);
    const keyJson = (kp: { publicKey: Uint8Array; secretKey: Uint8Array }) =>
      `${JSON.stringify({ publicKey: encodeBase64(kp.publicKey), secretKey: encodeBase64(kp.secretKey) }, null, 2)}\n`;
    const pending = `${path}.pending`;
    store.writePrivate(pending, keyJson(next));
    try {
      await api.registerDomainKey(
        { name, domainKey: encodeBase64(next.publicKey), rotation },
        auth,
      );
    } catch (err) {
      // Not accepted: the current key stays the root; the unused one goes.
      store.shred(pending);
      throw err;
    }
    // Accepted. The retired secret is overwritten and removed — never kept:
    // whoever holds it can sign a rotation that clients still pinned to it
    // would follow. Then the pending key takes its place, atomically.
    store.shred(path);
    store.promote(pending, path);
    console.log(`rotated the domain key for ${name} to ${encodeBase64(next.publicKey)}`);
    console.log('The retired key was overwritten and deleted on this device.');
    console.log(
      'Destroy every other copy of it (backups, other devices): it can still sign a rotation that ' +
        'clients pinned to it would follow. Back up the NEW key offline.',
    );
    console.log(
      "Every node granted by the old key is now refused; restart `tnp serve` to re-grant this device's node.",
    );
    return;
  }
  if (sub === 'grant') {
    const name = requireName(action, 'tnp domain grant <name> --node-key <base64>');
    const nodeKeyB64 = flag(argv, '--node-key');
    if (!nodeKeyB64) throw new Error('--node-key <base64> is required');
    const nodeKey = decodeBase64Strict(nodeKeyB64, 32);
    const days = Number(flag(argv, '--days') ?? NODE_GRANT_LIFETIME / 86_400);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('--days must be 1–365');
    const domainKey = loadKeyPair(store, 'domain-keys', name);
    if (!domainKey) throw new Error(`this device does not hold the domain key for ${name}`);
    const grant = issueNodeGrant(domainKey, nodeKey, name, nowSeconds(), days * 86_400);
    const json = `${JSON.stringify([grant], null, 2)}\n`;
    const out = flag(argv, '--out');
    if (out) {
      writeFileSync(out, json, { mode: 0o600, flag: 'wx' });
      console.log(`wrote the grant to ${out}`);
    } else {
      process.stdout.write(json);
    }
    return;
  }
  throw new Error(`usage:${DOMAIN_USAGE}`);
}

export const PINS_USAGE = `
  tnp pins                        List the domain keys this client has pinned
  tnp pins forget <name>          Forget a pin (the next contact trusts the registry again)`;

export function cmdPins(argv: string[], store = new OverlayStore()): void {
  const pins = new PinStore(store);
  const [sub, rawName] = argv;
  if (!sub || sub === 'list') {
    const list = pins.list();
    if (list.length === 0) {
      console.log('no pinned domain keys');
      return;
    }
    for (const pin of list) console.log(`${pin.name}\t${pin.domainKey}\tpinned ${pin.pinnedAt}`);
    return;
  }
  if (sub === 'forget') {
    const name = requireName(rawName, 'tnp pins forget <name>');
    console.log(pins.forget(name) ? `forgot the pin for ${name}` : `no pin for ${name}`);
    return;
  }
  throw new Error(`usage:${PINS_USAGE}`);
}

/** One line for `tnp status`. */
export function pinsSummary(store = new OverlayStore()): string {
  try {
    const count = new PinStore(store).list().length;
    return `${count} pinned domain key${count === 1 ? '' : 's'} (${store.pinsPath}); \`tnp pins\` lists them`;
  } catch (err) {
    return `pin file unreadable: ${err instanceof Error ? err.message : 'error'}`;
  }
}
