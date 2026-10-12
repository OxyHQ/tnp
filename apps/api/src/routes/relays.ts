import { Router } from 'express';
import { requireOxyAuth, getRequiredOxyUserId } from '@oxy.so/core/server';
import {
  parseRegisterRelayRequest,
  parseRelayHeartbeatRequest,
  type RelayDirectoryEntry,
  type RelayDirectoryResponse,
  type RelayHeartbeatResponse,
  type RelayRegistration,
} from '@tnp/shared-types';
import { config } from '../config.js';
import { getDb } from '../db/postgres.js';
import {
  type DirectorySigner,
  type OxyRelayConfig,
  RelayDirectoryService,
} from '../registry/relayDirectory.js';
import {
  listProvenCommunityRelays,
  listRelayDirectory,
  recordRelayHeartbeat,
  registerRelay,
  relayKeyProofValid,
} from '../registry/relays.js';
import { logError } from '../utils/logError.js';

export interface RelayDirectoryRouteConfig {
  signer: DirectorySigner | null;
  oxyRelays: readonly OxyRelayConfig[];
}

/**
 * `oxyOperators` and `directory` are injectable so the contract tests can run
 * the router with configuration of their choosing; production passes
 * `TNP_OXY_RELAY_OPERATORS`, `TNP_DIRECTORY_SIGNING_SEED` and `TNP_OXY_RELAYS`.
 */
export function createRelaysRouter(
  oxyOperators: ReadonlySet<string> = config.oxyRelayOperators,
  directory: RelayDirectoryRouteConfig = config.relayDirectory,
): Router {
  const router = Router();

  const directoryService = directory.signer
    ? new RelayDirectoryService({
        signer: directory.signer,
        oxyRelays: directory.oxyRelays,
        listCommunity: () => listProvenCommunityRelays(getDb()),
        onError: (err) => logError('Relay directory: community relays unavailable:', err),
      })
    : null;

  // GET /relays/directory -- the SIGNED directory clients select relays from
  // (discovery.md §2). No signing key, no directory: 503, never an unsigned
  // listing in its place.
  router.get('/directory', async (_req, res) => {
    if (!directoryService) {
      res.status(503).json({ error: 'The signed relay directory is not available' });
      return;
    }
    try {
      const body: RelayDirectoryResponse = await directoryService.current();
      // Signed and short-lived: a cache may hold it briefly. A stale copy
      // from a cache is still a valid signed document, and clients keep the
      // highest serial they have seen.
      res.set('Cache-Control', 'public, max-age=30');
      res.json(body);
    } catch (err) {
      logError('Relay directory error:', err);
      res.status(500).json({ error: 'Failed to build the relay directory' });
    }
  });

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

      // A proof that is sent must verify; one that is absent only keeps the
      // relay out of the signed directory (registry/relays.ts).
      const { proof } = parsed.value;
      const keyProven =
        proof !== undefined &&
        relayKeyProofValid({
          proof,
          purpose: 'register',
          endpoint: parsed.value.endpoint,
          publicKey: parsed.value.publicKey,
          nowSeconds: Math.floor(Date.now() / 1000),
        });
      if (proof !== undefined && !keyProven) {
        res.status(400).json({
          error: 'proof does not verify for this endpoint and publicKey (or is not fresh)',
        });
        return;
      }

      const registration: RelayRegistration | null = await registerRelay(getDb(), {
        request: parsed.value,
        operatorUserId: getRequiredOxyUserId(req),
        oxyOperators,
        keyProven,
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

      const outcome = await recordRelayHeartbeat(getDb(), {
        endpoint: parsed.value.endpoint,
        operatorUserId: getRequiredOxyUserId(req),
        proof: parsed.value.proof,
      });
      if (outcome === 'not-found') {
        res.status(404).json({ error: 'Relay not found' });
        return;
      }
      if (outcome === 'bad-proof') {
        res.status(400).json({ error: 'proof does not verify for the registered key' });
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
