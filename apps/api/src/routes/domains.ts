import { Router } from "express";
import type { Request, Response } from "express";
import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { requireOxyAuth, getRequiredOxyUserId } from "@oxy.so/core/server";
import { validateNativeLabel, validateNativeTld } from "@tnp/namespace";
import {
  parseCreateDnsRecordRequest,
  parseUpdateDnsRecordRequest,
  type NativeAvailability,
  type OwnedDomainPage,
  type OwnedDomainWithRecords,
  type PublicDomain,
  type PublicDomainPage,
  type PublicDomainWithRecords,
  type RenewDomainResponse,
} from "@tnp/shared-types";
import { getDb } from "../db/postgres.js";
import { dnsRecords, domains, tlds, users } from "../db/schema/index.js";
import {
  checkNativeAvailability,
  listOwnedDomains,
  parseAvailabilityQuery,
  renewNativeDomain,
} from "../registry/domains.js";
import {
  createDnsRecord,
  deleteDnsRecord,
  updateDnsRecord,
  type RecordMutationFailure,
} from "../registry/records.js";
import {
  serializeDnsRecord,
  toOwnedDomain,
  toOwnedDomainSummary,
  toOwnedDomainWithRecords,
  toPublicDomain,
  toPublicDomainWithRecords,
} from "../registry/serialize.js";
import { likeContains } from "@oxy.so/utils/sql";

const router = Router();

/** Postgres rejects a malformed uuid rather than returning no rows, so screen first. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?page=&limit=`, clamped. Garbage falls back to the defaults rather than failing. */
function pagination(req: Request, defaultLimit: number): { page: number; limit: number } {
  const page = Math.max(1, parseInt(String(req.query.page)) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit)) || defaultLimit));
  return { page, limit };
}

async function findOrCreateUser(oxyUserId: string): Promise<string> {
  const db = getDb();
  // ON CONFLICT rather than select-then-insert: two concurrent first requests
  // from the same account would otherwise both miss and both insert.
  const [row] = await db
    .insert(users)
    .values({ oxyUserId })
    .onConflictDoUpdate({
      target: users.oxyUserId,
      set: { updatedAt: sql`now()` },
    })
    .returning({ id: users.id });
  return row.id;
}

/**
 * Load a domain and confirm the caller owns it.
 *
 * Every record route needs exactly this, and getting it wrong in one of them is
 * an IDOR — so it exists once.
 */
async function requireOwnedDomain(
  id: string,
  oxyUserId: string,
): Promise<{ ok: true; domainId: string } | { ok: false; status: number; error: string }> {
  if (!UUID_RE.test(id)) return { ok: false, status: 404, error: "Domain not found" };

  const [domain] = await getDb()
    .select({ id: domains.id, oxyUserId: domains.oxyUserId })
    .from(domains)
    .where(eq(domains.id, id))
    .limit(1);

  if (!domain) return { ok: false, status: 404, error: "Domain not found" };
  if (domain.oxyUserId !== oxyUserId) {
    return { ok: false, status: 403, error: "You do not own this domain" };
  }
  return { ok: true, domainId: domain.id };
}

function sendRecordFailure(res: Response, failure: RecordMutationFailure): void {
  const { ok: _ok, status, ...body } = failure;
  res.status(status).json(body);
}

// GET /domains -- public directory of all registered domains
//
// Public reads serialize through `toPublicDomain`, which carries no owner
// identifier. The directory used to publish every owner's Oxy user id.
router.get("/", async (req, res) => {
  try {
    const { page, limit } = pagination(req, 50);
    const db = getDb();

    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(domains)
        .where(eq(domains.status, "active"))
        .orderBy(desc(domains.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(domains)
        .where(eq(domains.status, "active")),
    ]);

    const body: PublicDomainPage = {
      domains: rows.map(toPublicDomain),
      total,
      page,
      pages: Math.ceil(total / limit),
    };
    res.json(body);
  } catch (err) {
    console.error("List domains error:", err);
    res.status(500).json({ error: "Failed to list domains" });
  }
});

// GET /domains/search?q= -- search registered domains by name
router.get("/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").toLowerCase().trim();
    if (!q) {
      res.status(400).json({ error: "Search query is required" });
      return;
    }

    // `ilike` with the pattern escaped: a raw `%` or `_` from the caller would
    // otherwise be a wildcard, turning a search for "a_b" into "a<any>b".
    const pattern = likeContains(q);

    const rows = await getDb()
      .select()
      .from(domains)
      .where(and(eq(domains.status, "active"), ilike(domains.name, pattern)))
      .limit(50);

    const body: PublicDomain[] = rows.map(toPublicDomain);
    res.json(body);
  } catch (err) {
    console.error("Search domains error:", err);
    res.status(500).json({ error: "Failed to search domains" });
  }
});

/** Refusals that need no query are answered without opening one. */
async function availability(input: string): Promise<NativeAvailability> {
  const query = parseAvailabilityQuery(input);
  return query.ok ? checkNativeAvailability(getDb(), query) : query.answer;
}

// GET /domains/check/:name/:tld
//
// Native availability only, under the full native policy. A public name's
// availability is a provider question for the services layer and is never
// answered here.
router.get("/check/:name/:tld", async (req, res) => {
  try {
    res.json(await availability(`${req.params.name}.${req.params.tld}`));
  } catch (err) {
    console.error("Check domain error:", err);
    res.status(500).json({ error: "Failed to check domain" });
  }
});

// GET /domains/check/:domain -- name.tld form
//
// Malformed input — a subdomain, a single label — is a 200 with
// `reason: "invalid"` and a message, not a 400: "can I register this?" has an
// answer, and it is no.
router.get("/check/:domain", async (req, res) => {
  try {
    res.json(await availability(req.params.domain));
  } catch (err) {
    console.error("Check domain error:", err);
    res.status(500).json({ error: "Failed to check domain" });
  }
});

// GET /domains/lookup/:domain -- public detail view
router.get("/lookup/:domain", async (req, res) => {
  try {
    const parts = req.params.domain.split(".");
    if (parts.length !== 2) {
      res.status(400).json({ error: "Format must be name.tld" });
      return;
    }
    const [name, tld] = parts.map((p) => p.toLowerCase());

    const [domain] = await getDb()
      .select()
      .from(domains)
      .where(and(eq(domains.name, name), eq(domains.tld, tld), eq(domains.status, "active")))
      .limit(1);

    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    const records = await getDb()
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, domain.id))
      .orderBy(dnsRecords.createdAt);

    const body: PublicDomainWithRecords = toPublicDomainWithRecords(domain, records);
    res.json(body);
  } catch (err) {
    console.error("Lookup domain error:", err);
    res.status(500).json({ error: "Failed to look up domain" });
  }
});

// POST /domains/register -- register a domain (auth required)
router.post("/register", requireOxyAuth, async (req, res) => {
  try {
    const userId = getRequiredOxyUserId(req);
    const { name, tld } = req.body;

    if (!name || typeof name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!tld || typeof tld !== "string") {
      res.status(400).json({ error: "tld is required" });
      return;
    }

    const label = validateNativeLabel(name);
    if (!label.ok) {
      res.status(400).json({ error: label.detail });
      return;
    }
    const cleanName = label.label;
    const cleanTld = tld.toLowerCase().trim().replace(/^\./, "");

    // Reserved TLDs are refused before the registry is consulted, so a stale row
    // from an earlier seed cannot make one registrable. TNP is never
    // authoritative for a label the public DNS root delegates
    // (docs/architecture/naming.md, rule N1).
    const tldPolicy = validateNativeTld(cleanTld);
    if (!tldPolicy.ok && tldPolicy.reason === "reserved") {
      res.status(403).json({ error: "TLD_RESERVED", detail: tldPolicy.detail });
      return;
    }

    const db = getDb();

    const [tldRow] = await db
      .select({ id: tlds.id })
      .from(tlds)
      .where(and(eq(tlds.name, cleanTld), eq(tlds.status, "active")))
      .limit(1);

    if (!tldRow) {
      res.status(400).json({ error: `TLD .${cleanTld} is not available` });
      return;
    }

    const ownerId = await findOrCreateUser(userId);

    const now = new Date();
    const expiresAt = new Date(now);
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    // The unique index decides, not a prior existence check: two concurrent
    // registrations of the same name would both pass a check-then-insert.
    const inserted = await db
      .insert(domains)
      .values({
        name: cleanName,
        tld: cleanTld,
        ownerId,
        oxyUserId: userId,
        status: "active",
        expiresAt,
      })
      .onConflictDoNothing({ target: [domains.name, domains.tld] })
      .returning();

    if (inserted.length === 0) {
      res.status(409).json({ error: `${cleanName}.${cleanTld} is already registered` });
      return;
    }

    const body: OwnedDomainWithRecords = toOwnedDomainWithRecords(inserted[0], [], now);
    res.status(201).json(body);
  } catch (err) {
    console.error("Register domain error:", err);
    res.status(500).json({ error: "Failed to register domain" });
  }
});

// GET /domains/owned?page=&limit= (auth required)
//
// The dashboard's inventory: a page of the caller's domains with record counts
// and no records, which are fetched per domain when one is opened.
router.get("/owned", requireOxyAuth, async (req, res) => {
  try {
    const { page, limit } = pagination(req, 20);
    const now = new Date();
    const { rows, total } = await listOwnedDomains(getDb(), {
      oxyUserId: getRequiredOxyUserId(req),
      page,
      limit,
    });

    const body: OwnedDomainPage = {
      domains: rows.map((row) => toOwnedDomainSummary(row.domain, row.recordCount, now)),
      total,
      page,
      pages: Math.ceil(total / limit),
    };
    res.json(body);
  } catch (err) {
    console.error("Owned domains error:", err);
    res.status(500).json({ error: "Failed to get your domains" });
  }
});

// GET /domains/mine (auth required)
//
// DEPRECATED: use GET /domains/owned. Unpaginated and loads every record of
// every domain. Kept unchanged in shape for web builds and CLIs that still call
// it; remove once none do.
router.get("/mine", requireOxyAuth, async (req, res) => {
  try {
    const db = getDb();
    const now = new Date();
    const rows = await db
      .select()
      .from(domains)
      .where(eq(domains.oxyUserId, getRequiredOxyUserId(req)))
      .orderBy(desc(domains.createdAt));
    const records =
      rows.length === 0
        ? []
        : await db
            .select()
            .from(dnsRecords)
            .where(inArray(dnsRecords.domainId, rows.map((domain) => domain.id)))
            .orderBy(dnsRecords.createdAt);

    const body: OwnedDomainWithRecords[] = rows.map((domain) =>
      toOwnedDomainWithRecords(domain, records, now),
    );
    res.json(body);
  } catch (err) {
    console.error("My domains error:", err);
    res.status(500).json({ error: "Failed to get your domains" });
  }
});

// POST /domains/:id/renew -- renew a native registration (auth required, owner only, free)
router.post("/:id/renew", requireOxyAuth, async (req: Request<{ id: string }>, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    const outcome = await renewNativeDomain(getDb(), {
      domainId: req.params.id,
      oxyUserId: getRequiredOxyUserId(req),
      now: new Date(),
    });

    if (!outcome.ok) {
      const { ok: _ok, status, ...body } = outcome;
      res.status(status).json(body);
      return;
    }

    const body: RenewDomainResponse = toOwnedDomain(outcome.domain, new Date());
    res.json(body);
  } catch (err) {
    console.error("Renew domain error:", err);
    res.status(500).json({ error: "Failed to renew domain" });
  }
});

// DELETE /domains/:id -- release a native domain (auth required, must be owner)
//
// This is the explicit, irreversible release of a NATIVE name: the row, its
// records and its service node are deleted and the name becomes registrable by
// anyone. It is never the implementation of anything in the services layer —
// not cancelling a public domain, not ending hosting, not a transfer, not
// "don't renew". Nothing under `apps/api/src/services/` may call this route or
// delete from `domains` (issue #62, finding A7; services.md §2). The web asks
// for the full name to be typed before calling it.
router.delete("/:id", requireOxyAuth, async (req: Request<{ id: string }>, res) => {
  try {
    const owned = await requireOwnedDomain(req.params.id, getRequiredOxyUserId(req));
    if (!owned.ok) {
      res.status(owned.status).json({ error: owned.error });
      return;
    }

    // Records and any service node go with it, by ON DELETE CASCADE — the
    // Mongoose version left orphaned service_nodes behind.
    await getDb().delete(domains).where(eq(domains.id, owned.domainId));

    res.json({ message: "Domain released" });
  } catch (err) {
    console.error("Delete domain error:", err);
    res.status(500).json({ error: "Failed to release domain" });
  }
});

// -- DNS records --

// GET /domains/:id/records (auth required, must be owner)
router.get("/:id/records", requireOxyAuth, async (req: Request<{ id: string }>, res) => {
  try {
    const owned = await requireOwnedDomain(req.params.id, getRequiredOxyUserId(req));
    if (!owned.ok) {
      res.status(owned.status).json({ error: owned.error });
      return;
    }

    const rows = await getDb()
      .select()
      .from(dnsRecords)
      .where(eq(dnsRecords.domainId, owned.domainId))
      .orderBy(dnsRecords.createdAt);

    res.json(rows.map(serializeDnsRecord));
  } catch (err) {
    console.error("Get records error:", err);
    res.status(500).json({ error: "Failed to get records" });
  }
});

// POST /domains/:id/records (auth required, must be owner)
router.post("/:id/records", requireOxyAuth, async (req: Request<{ id: string }>, res) => {
  try {
    // Validated before the ownership lookup: a malformed record is a 400
    // whoever sends it, and the contract test can reach it without a database.
    const parsed = parseCreateDnsRecordRequest(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error, code: parsed.code, field: parsed.field });
      return;
    }

    const owned = await requireOwnedDomain(req.params.id, getRequiredOxyUserId(req));
    if (!owned.ok) {
      res.status(owned.status).json({ error: owned.error });
      return;
    }

    const result = await createDnsRecord(getDb(), owned.domainId, parsed.value);
    if (!result.ok) {
      sendRecordFailure(res, result);
      return;
    }

    res.status(201).json(serializeDnsRecord(result.value));
  } catch (err) {
    console.error("Add record error:", err);
    res.status(500).json({ error: "Failed to add record" });
  }
});

// PUT /domains/:id/records/:rid
router.put(
  "/:id/records/:rid",
  requireOxyAuth,
  async (req: Request<{ id: string; rid: string }>, res) => {
    try {
      const parsed = parseUpdateDnsRecordRequest(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: parsed.error, code: parsed.code, field: parsed.field });
        return;
      }

      const owned = await requireOwnedDomain(req.params.id, getRequiredOxyUserId(req));
      if (!owned.ok) {
        res.status(owned.status).json({ error: owned.error });
        return;
      }
      if (!UUID_RE.test(req.params.rid)) {
        res.status(404).json({ error: "Record not found" });
        return;
      }

      // The merged record — stored fields overlaid with the patch — is what
      // is validated, inside the same lock as the write.
      const result = await updateDnsRecord(getDb(), owned.domainId, req.params.rid, parsed.value);
      if (!result.ok) {
        sendRecordFailure(res, result);
        return;
      }

      res.json(serializeDnsRecord(result.value));
    } catch (err) {
      console.error("Update record error:", err);
      res.status(500).json({ error: "Failed to update record" });
    }
  },
);

// DELETE /domains/:id/records/:rid
router.delete(
  "/:id/records/:rid",
  requireOxyAuth,
  async (req: Request<{ id: string; rid: string }>, res) => {
    try {
      const owned = await requireOwnedDomain(req.params.id, getRequiredOxyUserId(req));
      if (!owned.ok) {
        res.status(owned.status).json({ error: owned.error });
        return;
      }
      if (!UUID_RE.test(req.params.rid)) {
        res.status(404).json({ error: "Record not found" });
        return;
      }

      const result = await deleteDnsRecord(getDb(), owned.domainId, req.params.rid);
      if (!result.ok) {
        sendRecordFailure(res, result);
        return;
      }

      res.json({ message: "Record deleted" });
    } catch (err) {
      console.error("Delete record error:", err);
      res.status(500).json({ error: "Failed to delete record" });
    }
  },
);

export default router;
