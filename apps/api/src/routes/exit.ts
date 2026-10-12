import { Router } from 'express';
import type { ExitPeersResponse, VpnErrorBody } from '@tnp/shared-types';
import { getDb } from '../db/postgres.js';
import type { Executor } from '../registry/db.js';
import { listExitPeers } from '../registry/vpnDevices.js';
import { logError } from '../utils/logError.js';
import { exitTokenMatches, type VpnConfig } from '../vpn.js';

export interface ExitRouterOptions {
  db?: () => Executor;
  vpn: () => VpnConfig | null;
}

/**
 * `/exit` — what TNP's WireGuard exits poll (apps/exit).
 *
 * Authenticated by a per-exit bearer secret (`TNP_EXIT_TOKENS`), never by an
 * Oxy session: an exit is a machine, not an account. The answer is the peer
 * set and nothing else — keys and tunnel addresses, no account ids, no names —
 * so an exit (or anyone who steals its token) learns how many devices exist
 * and their public keys, not whose they are. Devices of accounts outside
 * `TNP_VPN_ALLOWED_USERS` are left out.
 */
export function createExitRouter({ db = getDb, vpn }: ExitRouterOptions): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/peers', async (req, res) => {
    const config = vpn();
    if (!config) {
      const body: VpnErrorBody = { error: 'The VPN is not configured', code: 'vpn_not_configured' };
      res.status(503).json(body);
      return;
    }
    if (!exitTokenMatches(req.get('authorization'), config.exitTokenDigests)) {
      res.set('WWW-Authenticate', 'Bearer');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      // Only allowlisted accounts' devices: no exit carries anyone else's traffic.
      const body: ExitPeersResponse = { peers: await listExitPeers(db(), config.allowedUsers) };
      res.json(body);
    } catch (err) {
      logError('List exit peers error:', err);
      res.status(500).json({ error: 'Failed to load peers' });
    }
  });

  return router;
}
