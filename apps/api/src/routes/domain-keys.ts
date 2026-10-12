/**
 * `/domain-keys` — publish and rotate each native name's DOMAIN KEY.
 *
 * The rules, and why there is no reset, are in `registry/domainKeys.ts` and
 * docs/architecture/security.md §1. This file only maps HTTP onto them.
 */

import { getRequiredOxyUserId, requireOxyAuth } from '@oxy.so/core/server';
import { parseRegisterDomainKeyRequest } from '@tnp/shared-types';
import { Router } from 'express';
import { getDb } from '../db/postgres.js';
import {
  canonicalKey,
  lookupDomainKey,
  registerDomainKey,
  splitNativeName,
} from '../registry/domainKeys.js';
import { logError } from '../utils/logError.js';

const router = Router();

// GET /domain-keys/:name -- public: what relays check service nodes against and
// what a client pins on first contact.
router.get('/:name', async (req, res) => {
  try {
    const name = String(req.params.name).toLowerCase();
    // Refused before any query: a name that can never carry a key.
    if (!splitNativeName(name)) {
      res.status(404).json({ error: 'No domain key for this name' });
      return;
    }
    const record = await lookupDomainKey(getDb(), name);
    if (!record) {
      res.status(404).json({ error: 'No domain key for this name' });
      return;
    }
    res.json(record);
  } catch (err) {
    logError('Domain key lookup error:', err);
    res.status(500).json({ error: 'Failed to look up domain key' });
  }
});

// POST /domain-keys -- owner only: the first key, or a rotation signed by the current one.
router.post('/', requireOxyAuth, async (req, res) => {
  try {
    const userId = getRequiredOxyUserId(req);
    const parsed = parseRegisterDomainKeyRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    // Checks that need no database, so a malformed request never costs a query.
    if (!splitNativeName(parsed.value.name)) {
      res.status(400).json({ error: 'name must be a registered name of the form label.tld' });
      return;
    }
    if (!canonicalKey(parsed.value.domainKey)) {
      res.status(400).json({ error: 'domainKey must be canonical base64 of 32 bytes' });
      return;
    }
    const result = await registerDomainKey(getDb(), {
      userId,
      request: parsed.value,
      now: Math.floor(Date.now() / 1000),
    });
    if ('error' in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(result.status).json(result.record);
  } catch (err) {
    logError('Register domain key error:', err);
    res.status(500).json({ error: 'Failed to register domain key' });
  }
});

export default router;
