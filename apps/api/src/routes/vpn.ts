import { type Response, Router } from 'express';
import { getRequiredOxyUserId, requireOxyAuth } from '@oxy.so/core/server';
import {
  parseCreateVpnDeviceRequest,
  parseRenameVpnDeviceRequest,
  type VpnDeviceList,
  type VpnDeviceResponse,
  type VpnErrorBody,
  type VpnErrorCode,
} from '@tnp/shared-types';
import { getDb } from '../db/postgres.js';
import type { Executor } from '../registry/db.js';
import {
  createVpnDevice,
  deleteVpnDevice,
  isDeviceId,
  listVpnDevices,
  renameVpnDevice,
} from '../registry/vpnDevices.js';
import { logError } from '../utils/logError.js';
import { type VpnConfig, vpnNetwork } from '../vpn.js';

export interface VpnRouterOptions {
  db?: () => Executor;
  /** Null when the feature is off. A function so tests can flip it. */
  vpn: () => VpnConfig | null;
}

function fail(res: Response, status: number, error: string, code?: VpnErrorCode): void {
  const body: VpnErrorBody = code ? { error, code } : { error };
  res.status(status).json(body);
}

const NOT_CONFIGURED = 'The VPN is not available yet: no exit is configured.';

/**
 * `/me/vpn` — the caller's WireGuard devices (docs/architecture/vpn.md §10).
 *
 * Mounted inside the `/me` router, so every response is `no-store` and every
 * route acts on `getRequiredOxyUserId(req)` alone. Bodies are validated by the
 * `@tnp/shared-types` contract before anything else; a private key in a body
 * is refused, never stored or logged.
 *
 * While the feature is off, every route answers 503 `vpn_not_configured`
 * except DELETE: removing your own data is never switched off.
 */
export function createVpnRouter({ db = getDb, vpn }: VpnRouterOptions): Router {
  const router = Router();

  router.get('/devices', requireOxyAuth, async (req, res) => {
    const config = vpn();
    if (!config) return fail(res, 503, NOT_CONFIGURED, 'vpn_not_configured');
    try {
      const body: VpnDeviceList = {
        devices: await listVpnDevices(db(), getRequiredOxyUserId(req)),
        network: vpnNetwork(config),
      };
      res.json(body);
    } catch (err) {
      logError('List VPN devices error:', err);
      fail(res, 500, 'Failed to load VPN devices');
    }
  });

  router.post('/devices', requireOxyAuth, async (req, res) => {
    const config = vpn();
    if (!config) return fail(res, 503, NOT_CONFIGURED, 'vpn_not_configured');
    const parsed = parseCreateVpnDeviceRequest(req.body);
    if (!parsed.ok) return fail(res, 400, parsed.error);
    try {
      const result = await createVpnDevice(db(), getRequiredOxyUserId(req), parsed.value, {
        maxDevices: config.maxDevices,
      });
      if (!result.ok) {
        switch (result.code) {
          case 'device_limit':
            return fail(
              res,
              409,
              `An account can have at most ${config.maxDevices} VPN devices. Revoke one first.`,
              'device_limit',
            );
          case 'public_key_in_use':
            return fail(
              res,
              409,
              'This public key is already registered. Generate a new key pair for each device.',
              'public_key_in_use',
            );
          default:
            return fail(res, 503, 'No tunnel address is free right now.', 'address_pool_exhausted');
        }
      }
      const body: VpnDeviceResponse = { device: result.device, network: vpnNetwork(config) };
      res.status(201).json(body);
    } catch (err) {
      logError('Create VPN device error:', err);
      fail(res, 500, 'Failed to add the VPN device');
    }
  });

  router.patch('/devices/:id', requireOxyAuth, async (req, res) => {
    const config = vpn();
    if (!config) return fail(res, 503, NOT_CONFIGURED, 'vpn_not_configured');
    const parsed = parseRenameVpnDeviceRequest(req.body);
    if (!parsed.ok) return fail(res, 400, parsed.error);
    const id = req.params.id;
    if (!isDeviceId(id)) return fail(res, 404, 'VPN device not found');
    try {
      const device = await renameVpnDevice(db(), getRequiredOxyUserId(req), id, parsed.value.name);
      if (!device) return fail(res, 404, 'VPN device not found');
      const body: VpnDeviceResponse = { device, network: vpnNetwork(config) };
      res.json(body);
    } catch (err) {
      logError('Rename VPN device error:', err);
      fail(res, 500, 'Failed to rename the VPN device');
    }
  });

  router.delete('/devices/:id', requireOxyAuth, async (req, res) => {
    const id = req.params.id;
    if (!isDeviceId(id)) return fail(res, 404, 'VPN device not found');
    try {
      const deleted = await deleteVpnDevice(db(), getRequiredOxyUserId(req), id);
      if (!deleted) return fail(res, 404, 'VPN device not found');
      res.status(204).end();
    } catch (err) {
      logError('Delete VPN device error:', err);
      fail(res, 500, 'Failed to revoke the VPN device');
    }
  });

  return router;
}
