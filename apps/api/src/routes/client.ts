import { readFileSync } from 'node:fs';
import {
  type ClientLatestResponse,
  isStrictSemver,
  RELEASE_CHECKSUMS_ASSET,
  RELEASE_PLATFORM_ASSETS,
  RELEASE_REPOSITORY,
  RELEASE_SIGNATURE_ASSET,
  RELEASE_SIGNING_PUBLIC_KEY_PEM,
  type ReleasePlatform,
  releaseAssetUrl,
} from '@tnp/shared-types';
import { Router } from 'express';
import { config } from '../config.js';

const router = Router();

/**
 * The client release the installers install and `/client/latest` advertises.
 * Bump it with `VERSION` in packages/client/src/cli.ts, and only after that
 * release exists with its signed SHA256SUMS: the installers fail closed
 * against a release without one.
 */
export const CLIENT_VERSION = '0.5.1';
if (!isStrictSemver(CLIENT_VERSION)) {
  throw new Error(`CLIENT_VERSION must be a strict x.y.z version, got ${CLIENT_VERSION}`);
}
const DNS_HOST = 'dns.tnp.network';

// The installers are real shell and PowerShell files beside this module
// (src/installers/), filled in at load time from the release contract in
// @tnp/shared-types — so the version, repository and signing key they embed are
// the ones `tnp update` uses, and nothing the request carries reaches them.
export function renderInstallerTemplate(
  template: string,
  values: { readonly version: string; readonly repository: string; readonly publicKeyPem: string },
): string {
  if (!isStrictSemver(values.version)) throw new Error(`not a strict version: ${values.version}`);
  const rendered = template
    .replaceAll('__TNP_VERSION__', values.version)
    .replaceAll('__TNP_REPO__', values.repository)
    .replaceAll('__TNP_RELEASE_KEY_PEM__', values.publicKeyPem.trimEnd());
  const leftover = /__TNP_[A-Z_]+__/.exec(rendered);
  if (leftover) throw new Error(`unfilled installer placeholder ${leftover[0]}`);
  return rendered;
}

export function readInstallerTemplate(file: 'install.sh' | 'install.ps1'): string {
  return readFileSync(new URL(`../installers/${file}`, import.meta.url), 'utf8');
}

function renderInstaller(file: 'install.sh' | 'install.ps1'): string {
  return renderInstallerTemplate(readInstallerTemplate(file), {
    version: CLIENT_VERSION,
    repository: RELEASE_REPOSITORY,
    publicKeyPem: RELEASE_SIGNING_PUBLIC_KEY_PEM,
  });
}

export const INSTALL_SH = renderInstaller('install.sh');
export const INSTALL_PS1 = renderInstaller('install.ps1');

/**
 * Which installer a `get.tnp.network` request is for, or null for any other
 * path. `/` serves PowerShell to a PowerShell user agent so that
 * `irm https://get.tnp.network | iex` works as well as `/ps`.
 */
export function installerRoute(path: string, userAgent: string | undefined): string | null {
  if (path === '/install.sh') return '/client/install.sh';
  if (path === '/ps' || path === '/install.ps1') return '/client/install.ps1';
  if (path === '/') {
    return (userAgent ?? '').toLowerCase().includes('powershell')
      ? '/client/install.ps1'
      : '/client/install.sh';
  }
  return null;
}

function latestResponse(): ClientLatestResponse {
  const platforms = Object.fromEntries(
    Object.entries(RELEASE_PLATFORM_ASSETS).map(([platform, asset]) => [
      platform,
      releaseAssetUrl(CLIENT_VERSION, asset),
    ]),
  ) as Record<ReleasePlatform, string>;
  return {
    version: CLIENT_VERSION,
    dns: {
      ip: config.parkingIp,
      host: DNS_HOST,
    },
    platforms,
    checksums: releaseAssetUrl(CLIENT_VERSION, RELEASE_CHECKSUMS_ASSET),
    signature: releaseAssetUrl(CLIENT_VERSION, RELEASE_SIGNATURE_ASSET),
    install: {
      unix: 'curl -fsSL https://get.tnp.network | sh',
      windows: 'irm https://get.tnp.network/ps | iex',
    },
  };
}

// GET /client/latest -- the latest client version. Clients read only
// `version`; every download URL is rebuilt from the fixed release scheme and
// verified against the signed SHA256SUMS.
router.get('/latest', (_req, res) => {
  res.json(latestResponse());
});

// GET /client/install.sh -- serves the Unix installer script
router.get('/install.sh', (_req, res) => {
  res.type('text/plain').set('Cache-Control', 'no-store').send(INSTALL_SH);
});

// GET /client/install.ps1 -- serves the Windows installer script
router.get('/install.ps1', (_req, res) => {
  res.type('text/plain').set('Cache-Control', 'no-store').send(INSTALL_PS1);
});

export default router;
