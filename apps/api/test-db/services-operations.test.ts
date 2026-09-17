import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { operations, operationResourceLeases } from "../src/db/schema/index.js";
import type { Database } from "../src/db/postgres.js";
import { IdempotencyConflictError } from "../src/services/operations/intent.js";
import { claimNextOperation, enqueueOperation, finishOperation, markSubmitted, LeaseLostError } from "../src/services/operations/store.js";
import { createTestDatabase, type TestDatabase } from "./harness.js";
import { createUser } from "./servicesFixtures.js";

let t: TestDatabase;
let db: Database;
let ownerId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
  ownerId = await createUser(db);
});

afterAll(async () => {
  await t.drop();
});

function input(kind: string, resourceId: string, key: string, payload: Record<string, unknown> = { a: 1 }) {
  return {
    kind,
    scope: `user:${ownerId}`,
    idempotencyKey: key,
    ownerId,
    resourceType: "test_resource",
    resourceId,
    providerAccountId: null,
    payload,
  };
}

describe("idempotent enqueue", () => {
  test("the same key and intent returns the original operation", async () => {
    const resource = crypto.randomUUID();
    const first = await enqueueOperation(db, input("test.idem", resource, "idem-key-0001"));
    const second = await enqueueOperation(db, input("test.idem", resource, "idem-key-0001", { a: 1 }));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.operation.id).toBe(first.operation.id);
  });

  test("the same key with a different intent is a conflict, and writes nothing", async () => {
    const resource = crypto.randomUUID();
    await enqueueOperation(db, input("test.idem", resource, "idem-key-0002"));
    await expect(enqueueOperation(db, input("test.idem", resource, "idem-key-0002", { a: 2 }))).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    const rows = await db.select().from(operations).where(eq(operations.idempotencyKey, "idem-key-0002"));
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ a: 1 });
  });
});

describe("claiming", () => {
  const kinds = ["test.claim"];

  test("two operations on one resource never run at the same time; another resource still runs", async () => {
    const busy = crypto.randomUUID();
    const other = crypto.randomUUID();
    const a = await enqueueOperation(db, input("test.claim", busy, "claim-a-0001"));
    const b = await enqueueOperation(db, input("test.claim", busy, "claim-b-0001"));
    const c = await enqueueOperation(db, input("test.claim", other, "claim-c-0001"));

    const first = await claimNextOperation(db, { workerId: "w1", leaseMs: 60_000, kinds });
    expect(first?.id).toBe(a.operation.id);

    // Worker 1 still holds resource `busy`: worker 2 must skip `b` and take `c`.
    const second = await claimNextOperation(db, { workerId: "w2", leaseMs: 60_000, kinds });
    expect(second?.id).toBe(c.operation.id);
    const third = await claimNextOperation(db, { workerId: "w3", leaseMs: 60_000, kinds });
    expect(third).toBeNull();

    // Releasing `a` frees the resource for `b`.
    expect(await finishOperation(db, a.operation.id, "w1", { status: "succeeded" })).toBe(true);
    const fourth = await claimNextOperation(db, { workerId: "w3", leaseMs: 60_000, kinds });
    expect(fourth?.id).toBe(b.operation.id);

    for (const [id, w] of [[b.operation.id, "w3"], [c.operation.id, "w2"]] as const) {
      await finishOperation(db, id, w, { status: "succeeded" });
    }
    const leases = await db.select().from(operationResourceLeases);
    expect(leases).toHaveLength(0);
  });

  test("a row locked by another transaction is skipped, not waited on", async () => {
    const op = await enqueueOperation(db, input("test.skip", crypto.randomUUID(), "skip-key-0001"));
    const holder = t.sql.reserve();
    const conn = await holder;
    try {
      await conn`begin`;
      await conn`select id from operations where id = ${op.operation.id} for update`;
      const started = Date.now();
      const claimed = await claimNextOperation(db, { workerId: "w-skip", leaseMs: 60_000, kinds: ["test.skip"] });
      expect(claimed).toBeNull();
      expect(Date.now() - started).toBeLessThan(2_000);
      await conn`rollback`;
    } finally {
      conn.release();
    }
    const claimed = await claimNextOperation(db, { workerId: "w-skip", leaseMs: 60_000, kinds: ["test.skip"] });
    expect(claimed?.id).toBe(op.operation.id);
    await finishOperation(db, op.operation.id, "w-skip", { status: "succeeded" });
  });

  test("an expired lease is taken over, and the stale worker can neither submit nor finish", async () => {
    const op = await enqueueOperation(db, input("test.lease", crypto.randomUUID(), "lease-key-0001"));
    const stale = await claimNextOperation(db, { workerId: "stale", leaseMs: 1_000, kinds: ["test.lease"] });
    expect(stale?.id).toBe(op.operation.id);

    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await expect(markSubmitted(db, op.operation.id, "stale")).rejects.toBeInstanceOf(LeaseLostError);

    const fresh = await claimNextOperation(db, { workerId: "fresh", leaseMs: 60_000, kinds: ["test.lease"] });
    expect(fresh?.id).toBe(op.operation.id);
    expect(fresh?.attempts).toBe(2);

    expect(await finishOperation(db, op.operation.id, "stale", { status: "failed" })).toBe(false);
    expect(await finishOperation(db, op.operation.id, "fresh", { status: "succeeded" })).toBe(true);
  });
});
