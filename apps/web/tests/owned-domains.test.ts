import { describe, expect, test } from "bun:test";
import { canRenew, loadInventoryPage, type InventoryDomain } from "../src/lib/ownedDomains";

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const statusOf = (err: unknown) => (err instanceof HttpError ? err.status : undefined);

const domain = {
  _id: "d1",
  name: "nate",
  tld: "ox",
  status: "active",
  createdAt: "2026-09-11T00:00:00.000Z",
  updatedAt: "2026-09-11T00:00:00.000Z",
  expiresAt: "2027-09-11T00:00:00.000Z",
};

describe("loadInventoryPage", () => {
  test("uses the paginated endpoint when the API has it", async () => {
    const calls: string[] = [];
    const page = await loadInventoryPage(
      async <T>(path: string) => {
        calls.push(path);
        return { domains: [{ ...domain, expiryState: "active", recordCount: 3 }], total: 41, page: 2, pages: 3 } as T;
      },
      statusOf,
      2,
    );
    expect(calls).toEqual(["/domains/owned?page=2&limit=20"]);
    expect(page).toMatchObject({ page: 2, pages: 3, total: 41 });
    expect(page.domains[0].recordCount).toBe(3);
  });

  test("falls back to the legacy endpoint on a 404 only, counting its records", async () => {
    const calls: string[] = [];
    const page = await loadInventoryPage(
      async <T>(path: string) => {
        calls.push(path);
        if (path.startsWith("/domains/owned")) throw new HttpError(404);
        return [{ ...domain, records: [{ _id: "r1" }, { _id: "r2" }] }] as T;
      },
      statusOf,
      1,
    );
    expect(calls).toEqual(["/domains/owned?page=1&limit=20", "/domains/mine"]);
    expect(page).toMatchObject({ page: 1, pages: 1, total: 1 });
    expect(page.domains[0]).not.toHaveProperty("records");
    expect(page.domains[0].recordCount).toBe(2);
  });

  test("any other failure is an error, not a silent fallback", async () => {
    const calls: string[] = [];
    const failing = loadInventoryPage(
      async <T>(path: string): Promise<T> => {
        calls.push(path);
        throw new HttpError(500);
      },
      statusOf,
      1,
    );
    await expect(failing).rejects.toBeInstanceOf(HttpError);
    expect(calls).toEqual(["/domains/owned?page=1&limit=20"]);
  });
});

describe("canRenew", () => {
  const base: InventoryDomain = { ...domain, recordCount: 0 };
  test("only inside the renewal window or after expiry, and never on a legacy response", () => {
    expect(canRenew({ ...base, expiryState: "renewable" })).toBe(true);
    expect(canRenew({ ...base, expiryState: "grace" })).toBe(true);
    expect(canRenew({ ...base, expiryState: "expired" })).toBe(true);
    expect(canRenew({ ...base, expiryState: "active" })).toBe(false);
    expect(canRenew(base)).toBe(false);
  });
});
