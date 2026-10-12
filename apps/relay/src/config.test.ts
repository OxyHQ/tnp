import { describe, expect, test } from 'bun:test';
import { encodeBase64, signingKeyPairFromSeed } from '@tnp/crypto';
import { loadRelayConfig } from './config';

const seed = crypto.getRandomValues(new Uint8Array(32));
const base = { RELAY_ENDPOINT: 'wss://relay.tnp.network', RELAY_KEY_SEED: encodeBase64(seed) };

describe('relay configuration', () => {
  test('a stable seed gives a stable relay key, the one the directory lists', () => {
    const a = loadRelayConfig(base);
    const b = loadRelayConfig({ ...base, RELAY_PORT: '9000' });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.config.relayKey).toBe(encodeBase64(signingKeyPairFromSeed(seed).publicKey));
    expect(b.config.relayKey).toBe(a.config.relayKey);
    expect(a.config).toMatchObject({
      endpoint: 'wss://relay.tnp.network',
      host: '0.0.0.0',
      port: 8080,
      apiUrl: 'https://api.tnp.network',
      trustForwardedFor: false,
    });
  });

  test('the seed is required, and never echoed when malformed', () => {
    const missing = loadRelayConfig({ RELAY_ENDPOINT: base.RELAY_ENDPOINT });
    expect(missing.ok).toBe(false);
    const secret = 'dGhpcy1pcy1ub3QtYS1zZWVk';
    const bad = loadRelayConfig({ ...base, RELAY_KEY_SEED: secret });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join('\n')).not.toContain(secret);
  });

  test('the endpoint is required, and public wss:// in production', () => {
    expect(loadRelayConfig({ RELAY_KEY_SEED: base.RELAY_KEY_SEED }).ok).toBe(false);
    expect(loadRelayConfig({ ...base, RELAY_ENDPOINT: 'ws://127.0.0.1:8080' }).ok).toBe(true);
    for (const RELAY_ENDPOINT of ['ws://relay.tnp.network', 'wss://10.0.0.1']) {
      expect(loadRelayConfig({ ...base, RELAY_ENDPOINT, NODE_ENV: 'production' }).ok).toBe(false);
    }
    expect(loadRelayConfig({ ...base, NODE_ENV: 'production' }).ok).toBe(true);
  });

  test('a bad port is refused', () => {
    expect(loadRelayConfig({ ...base, RELAY_PORT: '70000' }).ok).toBe(false);
    expect(loadRelayConfig({ ...base, RELAY_PORT: 'x' }).ok).toBe(false);
  });
});

describe('--check-config', () => {
  test('validates and prints public values only, without starting', async () => {
    const proc = Bun.spawn(['bun', `${import.meta.dir}/index.ts`, '--check-config'], {
      env: { ...process.env, ...base, RELAY_PORT: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    const parsed = JSON.parse(out) as { ok: boolean; endpoint: string; relayKey: string };
    expect(parsed).toEqual({
      ok: true,
      endpoint: 'wss://relay.tnp.network',
      relayKey: encodeBase64(signingKeyPairFromSeed(seed).publicKey),
    });
    expect(out).not.toContain(base.RELAY_KEY_SEED);
  });

  test('fails without the seed', async () => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      RELAY_ENDPOINT: base.RELAY_ENDPOINT,
    };
    delete env.RELAY_KEY_SEED;
    const proc = Bun.spawn(['bun', `${import.meta.dir}/index.ts`, '--check-config'], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await proc.exited).toBe(1);
  });
});
