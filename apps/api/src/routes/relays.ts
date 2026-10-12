import { Router } from 'express';
import { requireOxyAuth, getRequiredOxyUserId } from '@oxy.so/core/server';
import {
  parseRegisterRelayRequest,
  parseRelayHeartbeatRequest,
  type RelayDirectoryEntry,
  type RelayHeartbeatResponse,
  type RelayRegistration,
} from '@tnp/shared-types';
import { config } from '../config.js';
import { getDb } from '../db/postgres.js';
import { listRelayDirectory, recordRelayHeartbeat, registerRelay } from '../registry/relays.js';
import { logError } from '../utils/logError.js';

/**
 * `oxyOperators` is injectable so the contract tests can run the router with
 * an allowlist of their choosing; production passes `TNP_OXY_RELAY_OPERATORS`.
 */
export function createRelaysRouter(
  oxyOperators: ReadonlySet<string> = config.oxyRelayOperators,
): Router {
  const router = Router();

  // GET /relays -- list live relays (public). Rules: registry/relays.ts.
  router.get('/', async (req, res) => {
    try {
      const operatorFilter = req.query.operator;
      const operator =
        operatorFilter === 'oxy' || operatorFilter === 'community' ? operatorFilter : null;

      // Annotated rather than merely returned: the directory listing is a
      // contract the CLI and the web dashboard both read.
      const directory: RelayDirectoryEntry[] = await listRelayDirectory(getDb(), {
        oxyOperators,
        operator,
      });
      res.json(directory);
    } catch (err) {
      logError('List relays error:', err);
      res.status(500).json({ error: 'Failed to list relays' });
    }
  });

  // POST /relays/register -- register a relay node (auth required)
  router.post('/register', requireOxyAuth, async (req, res) => {
    try {
      // The one definition of what this endpoint accepts lives in
      // @tnp/shared-types, and the relay builds its request from that same
      // declaration — see audit finding B2. It has no `operator`: that is
      // decided here, from the authenticated account, never by the caller.
      const parsed = parseRegisterRelayRequest(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }

      const registration: RelayRegistration | null = await registerRelay(getDb(), {
        request: parsed.value,
        operatorUserId: getRequiredOxyUserId(req),
        oxyOperators,
      });

      if (!registration) {
        res.status(403).json({ error: 'This endpoint is registered to another operator' });
        return;
      }
      res.status(201).json(registration);
    } catch (err) {
      logError('Register relay error:', err);
      res.status(500).json({ error: 'Failed to register relay' });
    }
  });

  // POST /relays/heartbeat -- update relay status (auth required)
  router.post('/heartbeat', requireOxyAuth, async (req, res) => {
    try {
      const parsed = parseRelayHeartbeatRequest(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }

      const found = await recordRelayHeartbeat(getDb(), {
        endpoint: parsed.value.endpoint,
        operatorUserId: getRequiredOxyUserId(req),
      });
      if (!found) {
        res.status(404).json({ error: 'Relay not found' });
        return;
      }

      const response: RelayHeartbeatResponse = { status: 'ok' };
      res.json(response);
    } catch (err) {
      logError('Relay heartbeat error:', err);
      res.status(500).json({ error: 'Failed to update heartbeat' });
    }
  });

  return router;
}

export default createRelaysRouter();
