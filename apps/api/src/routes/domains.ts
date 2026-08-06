import { Router } from "express";
import type { Request } from "express";
import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { requireOxyAuth, getRequiredOxyUserId } from "@oxyhq/core/server";
import { validateNativeTld } from "@tnp/namespace";
import { getDb } from "../db/postgres.js";
import { dnsRecords, domains, tlds, users } from "../db/schema/index.js";

const router = Router();

const DOMAIN_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Record types the registry stores. */
const RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "NS"] as const;
type RecordType = (typeof RECORD_TYPES)[number];

function isRecordType(value: unknown): value is RecordType {
  return typeof value === "string" && (RECORD_TYPES as readonly string[]).includes(value);
}

/** Postgres rejects a malformed uuid rather than returning no rows, so screen first. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// GET /domains -- public directory of all registered domains
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page)) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit)) || 50));
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

    res.json({ domains: rows, total, page, pages: Math.ceil(total / limit) });
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
    const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

    const rows = await getDb()
      .select()
      .from(domains)
      .where(and(eq(domains.status, "active"), ilike(domains.name, pattern)))
      .limit(50);

    res.json(rows);
  } catch (err) {
    console.error("Search domains error:", err);
    res.status(500).json({ error: "Failed to search domains" });
  }
});

async function isAvailable(name: string, tld: string): Promise<boolean> {
  const [existing] = await getDb()
    .select({ id: domains.id })
    .from(domains)
    .where(and(eq(domains.name, name), eq(domains.tld, tld)))
    .limit(1);
  return !existing;
}

// GET /domains/check/:name/:tld
router.get("/check/:name/:tld", async (req, res) => {
  try {
    const name = req.params.name.toLowerCase();
    const tld = req.params.tld.toLowerCase();
    res.json({ domain: `${name}.${tld}`, available: await isAvailable(name, tld) });
  } catch (err) {
    console.error("Check domain error:", err);
    res.status(500).json({ error: "Failed to check domain" });
  }
});

// GET /domains/check/:domain -- name.tld form
router.get("/check/:domain", async (req, res) => {
  try {
    const parts = req.params.domain.split(".");
    if (parts.length !== 2) {
      res.status(400).json({ error: "Format must be name.tld" });
      return;
    }
    const [name, tld] = parts.map((p) => p.toLowerCase());
    res.json({ domain: `${name}.${tld}`, available: await isAvailable(name, tld) });
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

    // ownerId is the internal user key and is deliberately not selected — this
    // endpoint is public.
    const [domain] = await getDb()
      .select({
        _id: domains.id,
        name: domains.name,
        tld: domains.tld,
        oxyUserId: domains.oxyUserId,
        status: domains.status,
        createdAt: domains.createdAt,
        expiresAt: domains.expiresAt,
      })
      .from(domains)
      .where(and(eq(domains.name, name), eq(domains.tld, tld), eq(domains.status, "active")))
      .limit(1);

    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    res.json(domain);
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

    const cleanName = name.toLowerCase().trim();
    const cleanTld = tld.toLowerCase().trim().replace(/^\./, "");

    if (!DOMAIN_NAME_RE.test(cleanName)) {
      res.status(400).json({
        error:
          "Domain name must be 1-63 characters, alphanumeric and hyphens only, cannot start or end with a hyphen",
      });
      return;
    }

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

    const expiresAt = new Date();
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

    res.status(201).json(inserted[0]);
  } catch (err) {
    console.error("Register domain error:", err);
    res.status(500).json({ error: "Failed to register domain" });
  }
});

// GET /domains/mine (auth required)
router.get("/mine", requireOxyAuth, async (req, res) => {
  try {
    const rows = await getDb()
      .select()
      .from(domains)
      .where(eq(domains.oxyUserId, getRequiredOxyUserId(req)))
      .orderBy(desc(domains.createdAt));
    res.json(rows);
  } catch (err) {
    console.error("My domains error:", err);
    res.status(500).json({ error: "Failed to get your domains" });
  }
});

// DELETE /domains/:id -- release a domain (auth required, must be owner)
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

    res.json(rows);
  } catch (err) {
    console.error("Get records error:", err);
    res.status(500).json({ error: "Failed to get records" });
  }
});

// POST /domains/:id/records (auth required, must be owner)
router.post("/:id/records", requireOxyAuth, async (req: Request<{ id: string }>, res) => {
  try {
    const owned = await requireOwnedDomain(req.params.id, getRequiredOxyUserId(req));
    if (!owned.ok) {
      res.status(owned.status).json({ error: owned.error });
      return;
    }

    const { type, name, value, ttl } = req.body;

    if (!type || !name || !value) {
      res.status(400).json({ error: "type, name, and value are required" });
      return;
    }
    if (!isRecordType(type)) {
      res.status(400).json({ error: `type must be one of ${RECORD_TYPES.join(", ")}` });
      return;
    }

    // domainId comes from the ownership check, never from the body — spreading
    // req.body here would let a caller write a record onto someone else's domain.
    const [record] = await getDb()
      .insert(dnsRecords)
      .values({
        domainId: owned.domainId,
        type,
        name: String(name),
        value: String(value),
        ttl: typeof ttl === "number" && ttl > 0 ? ttl : 3600,
      })
      .returning();

    res.status(201).json(record);
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
      const owned = await requireOwnedDomain(req.params.id, getRequiredOxyUserId(req));
      if (!owned.ok) {
        res.status(owned.status).json({ error: owned.error });
        return;
      }
      if (!UUID_RE.test(req.params.rid)) {
        res.status(404).json({ error: "Record not found" });
        return;
      }

      const { type, name, value, ttl } = req.body;
      if (type !== undefined && !isRecordType(type)) {
        res.status(400).json({ error: `type must be one of ${RECORD_TYPES.join(", ")}` });
        return;
      }

      // An explicit field whitelist. Spreading req.body into the update would
      // let a caller move the record to another domain.
      const patch: Partial<typeof dnsRecords.$inferInsert> = { updatedAt: new Date() };
      if (type !== undefined) patch.type = type;
      if (name !== undefined) patch.name = String(name);
      if (value !== undefined) patch.value = String(value);
      if (typeof ttl === "number" && ttl > 0) patch.ttl = ttl;

      // The domainId predicate is what stops a record id from another domain
      // being edited through an owned one.
      const [record] = await getDb()
        .update(dnsRecords)
        .set(patch)
        .where(and(eq(dnsRecords.id, req.params.rid), eq(dnsRecords.domainId, owned.domainId)))
        .returning();

      if (!record) {
        res.status(404).json({ error: "Record not found" });
        return;
      }

      res.json(record);
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

      const deleted = await getDb()
        .delete(dnsRecords)
        .where(and(eq(dnsRecords.id, req.params.rid), eq(dnsRecords.domainId, owned.domainId)))
        .returning({ id: dnsRecords.id });

      if (deleted.length === 0) {
        res.status(404).json({ error: "Record not found" });
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
