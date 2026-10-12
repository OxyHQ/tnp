import { Router } from 'express';
import { and, eq, sql } from 'drizzle-orm';
import { requireOxyAuth, getRequiredOxyUserId } from '@oxy.so/core/server';
import { isReservedTld } from '@tnp/namespace';
import {
  parseRegisterServiceNodeRequest,
  parseServiceNodeHeartbeatRequest,
  type ServiceNodeHeartbeatResponse,
  type ServiceNodeLookup,
  type ServiceNodeRegistration,
} from '@tnp/shared-types';
import { getDb } from '../db/postgres.js';
import { domains, serviceNodes, tlds } from '../db/schema/index.js';
import { registerServiceNode, toServiceNodeLookup } from '../registry/nodes.js';
import { logError } from '../utils/logError.js';

const router = Router();

// POST /nodes/register -- register a service node for a domain (auth required)
//
// The body carries the node's grant chain and key-agreement certificate. They
// are verified here against the domain key the owner registered — defence in
// depth only: clients verify the same material themselves against the key
// they pinned, so a registry that skipped this check (or lied about it) still
// could not make a client accept a key the domain key never authorized.
router.post('/register', requireOxyAuth, async (req, res) => {
  try {
    const userId = getRequiredOxyUserId(req);

    const parsed = parseRegisterServiceNodeRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { domainId, chain, kaCert } = parsed.value;

    // Verified against the CURRENT domain key, in one transaction with the
    // domain row locked (registry/nodes.ts, registerServiceNode).
    const outcome = await registerServiceNode(getDb(), {
      userId,
      domainId,
      chain,
      kaCert,
      now: Math.floor(Date.now() / 1000),
    });

    if ('error' in outcome) {
      res.status(outcome.status).json({ error: outcome.error });
      return;
    }
    const node = outcome.node;
    if (!node) {
      res.status(500).json({ error: 'Failed to register service node' });
      return;
    }

    // Projected, not returned whole: the row also carries `oxyUserId`, which is
    // not part of the contract.
    const registration: ServiceNodeRegistration = {
      domainId: node.domainId,
      publicKey: node.publicKey,
      connectedRelay: node.connectedRelay,
      status: node.status,
    };
    res.status(201).json(registration);
  } catch (err) {
    logError('Register service node error:', err);
    res.status(500).json({ error: 'Failed to register service node' });
  }
});

// GET /nodes/:domain -- look up a service node by domain (e.g. example.ox)
router.get('/:domain', async (req, res) => {
  try {
    const parts = req.params.domain.split('.');
    if (parts.length !== 2) {
      res.status(400).json({ error: 'Format must be name.tld (e.g., example.ox)' });
      return;
    }

    const [name, tld] = parts.map((p) => p.toLowerCase());

    // TNP serves no reserved TLD, so it publishes no service node under one
    // either — otherwise this endpoint would be a way around the namespace rule.
    if (isReservedTld(tld)) {
      res.status(404).json({ error: 'TLD not found' });
      return;
    }

    const db = getDb();

    const [tldRow] = await db
      .select({ id: tlds.id })
      .from(tlds)
      .where(and(eq(tlds.name, tld), eq(tlds.status, 'active')))
      .limit(1);

    if (!tldRow) {
      res.status(404).json({ error: 'TLD not found' });
      return;
    }

    const [node] = await db
      .select({
        publicKey: serviceNodes.publicKey,
        connectedRelay: serviceNodes.connectedRelay,
        status: serviceNodes.status,
        lastSeen: serviceNodes.lastSeen,
      })
      .from(serviceNodes)
      .innerJoin(domains, eq(serviceNodes.domainId, domains.id))
      .where(and(eq(domains.name, name), eq(domains.tld, tld), eq(domains.status, 'active')))
      .limit(1);

    if (!node) {
      res.status(404).json({ error: 'No service node registered for this domain' });
      return;
    }

    // `status` is the effective one, never the stored column, which nothing
    // sets back to `offline`; and no `lastSeen` (registry/nodes.ts).
    const lookup: ServiceNodeLookup = toServiceNodeLookup(node, new Date());
    res.json(lookup);
  } catch (err) {
    logError('Lookup service node error:', err);
    res.status(500).json({ error: 'Failed to look up service node' });
  }
});

// POST /nodes/heartbeat -- update service node status (auth required)
router.post('/heartbeat', requireOxyAuth, async (req, res) => {
  try {
    const parsed = parseServiceNodeHeartbeatRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const { domainId, connectedRelay } = parsed.value;

    // The ownership predicate is in the UPDATE, so a node belonging to another
    // account cannot be touched even by guessing its domain id.
    const updated = await getDb()
      .update(serviceNodes)
      .set({
        lastSeen: sql`now()`,
        connectedRelay,
        status: 'online',
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(serviceNodes.domainId, domainId),
          eq(serviceNodes.oxyUserId, getRequiredOxyUserId(req)),
        ),
      )
      .returning({ id: serviceNodes.id });

    if (updated.length === 0) {
      // Deliberately does not distinguish "no such node" from "not yours":
      // telling an unauthorized caller which domains have nodes is a disclosure
      // the previous 404/403 split made for free.
      res.status(404).json({ error: 'Service node not found' });
      return;
    }

    const response: ServiceNodeHeartbeatResponse = { status: 'ok' };
    res.json(response);
  } catch (err) {
    logError('Service node heartbeat error:', err);
    res.status(500).json({ error: 'Failed to update heartbeat' });
  }
});

export default router;
