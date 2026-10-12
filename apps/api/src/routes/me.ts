import express, { type RequestHandler, Router } from 'express';
import { getRequiredOxyUserId, requireOxyAuth } from '@oxy.so/core/server';
import {
  DNS_RULES_MAX_CIPHERTEXT_BYTES,
  type DnsRulesConflict,
  parsePutDnsRulesRequest,
} from '@tnp/shared-types';
import { getDb } from '../db/postgres.js';
import type { Executor } from '../registry/db.js';
import { deleteDnsRuleSet, getDnsRuleSet, putDnsRuleSet } from '../registry/dnsRules.js';
import { logError } from '../utils/logError.js';
import { config } from '../config.js';
import type { VpnConfig } from '../vpn.js';
import { createVpnRouter } from './vpn.js';

/**
 * Body limit for `PUT /me/dns-rules`: the largest ciphertext as base64
 * (4/3 of 256 KiB) plus room for the other fields. The app-wide JSON parser
 * keeps Express's 100 KB default, so `app.ts` mounts this parser on the path
 * before it; a body past this limit is a 413 before any parsing work.
 */
export const DNS_RULES_BODY_LIMIT = Math.ceil((DNS_RULES_MAX_CIPHERTEXT_BYTES * 4) / 3) + 4096;

export const dnsRulesBodyParser: RequestHandler = express.json({ limit: DNS_RULES_BODY_LIMIT });

/**
 * `/me` — the caller's own resources. Every route requires auth and acts on
 * `getRequiredOxyUserId(req)` alone: there is no id in the path to get wrong,
 * so owner-only is a property of the construction, not a check.
 *
 * The personal DNS rules stored here are an end-to-end encrypted envelope
 * (docs/architecture/naming.md §3). Bodies are never logged; errors go
 * through `logError`, which drops query parameters.
 *
 * `db` is injectable so the real-PostgreSQL tests run this router against
 * their own database.
 */
export function createMeRouter(
  db: () => Executor = getDb,
  vpn: () => VpnConfig | null = () => config.vpn,
): Router {
  const router = Router();

  // Private, per-user data: no shared cache may keep it.
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // WireGuard devices (docs/architecture/vpn.md §10).
  router.use('/vpn', createVpnRouter({ db, vpn }));

  router.get('/dns-rules', requireOxyAuth, async (req, res) => {
    try {
      const record = await getDnsRuleSet(db(), getRequiredOxyUserId(req));
      if (!record) {
        res.status(404).json({ error: 'No personal DNS rules are stored for this account' });
        return;
      }
      res.json(record);
    } catch (err) {
      logError('Get DNS rules error:', err);
      res.status(500).json({ error: 'Failed to load DNS rules' });
    }
  });

  router.put('/dns-rules', requireOxyAuth, async (req, res) => {
    try {
      const parsed = parsePutDnsRulesRequest(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error });
        return;
      }

      const result = await putDnsRuleSet(db(), getRequiredOxyUserId(req), parsed.value);
      if (!result.ok) {
        const conflict: DnsRulesConflict = {
          error: `version must be ${result.currentVersion + 1}: the stored rule set is version ${result.currentVersion}`,
          code: 'version_conflict',
          currentVersion: result.currentVersion,
        };
        res.status(409).json(conflict);
        return;
      }
      res.status(parsed.value.version === 1 ? 201 : 200).json(result.record);
    } catch (err) {
      logError('Put DNS rules error:', err);
      res.status(500).json({ error: 'Failed to save DNS rules' });
    }
  });

  router.delete('/dns-rules', requireOxyAuth, async (req, res) => {
    try {
      const deleted = await deleteDnsRuleSet(db(), getRequiredOxyUserId(req));
      if (!deleted) {
        res.status(404).json({ error: 'No personal DNS rules are stored for this account' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      logError('Delete DNS rules error:', err);
      res.status(500).json({ error: 'Failed to delete DNS rules' });
    }
  });

  return router;
}

export default createMeRouter();
