import type {
  NativeExpiryStateDto,
  OwnedDomainPage,
  OwnedDomainWithRecords,
} from "@tnp/shared-types";

/**
 * A domain in the owner's inventory, as the dashboard and the service-node
 * page use it.
 *
 * `expiryState` is optional because the legacy endpoint, served by API images
 * older than this web build, does not send it.
 */
export interface InventoryDomain {
  _id: string;
  name: string;
  tld: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  expiryState?: NativeExpiryStateDto;
  recordCount: number;
}

export interface InventoryPage {
  domains: InventoryDomain[];
  page: number;
  pages: number;
  total: number;
}

export const INVENTORY_PAGE_SIZE = 20;

type Fetch = <T>(path: string) => Promise<T>;

/**
 * Load one page of the caller's domains.
 *
 * `GET /domains/owned` is paginated and sends counts, not records. The web
 * deploys the moment it merges while the API image is promoted by hand later,
 * so this build can meet an API without that route: on a 404 it falls back to
 * the deprecated `GET /domains/mine` and presents it as a single page.
 * TODO: remove the fallback once the API digest carrying /domains/owned is
 * promoted to production.
 */
export async function loadInventoryPage(
  fetch: Fetch,
  statusOf: (err: unknown) => number | undefined,
  page: number,
): Promise<InventoryPage> {
  try {
    const owned = await fetch<OwnedDomainPage>(
      `/domains/owned?page=${page}&limit=${INVENTORY_PAGE_SIZE}`,
    );
    return {
      domains: owned.domains,
      page: owned.page,
      pages: Math.max(1, owned.pages),
      total: owned.total,
    };
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
  }

  const legacy = await fetch<OwnedDomainWithRecords[]>("/domains/mine");
  return {
    domains: legacy.map(({ records, ...domain }) => ({ ...domain, recordCount: records.length })),
    page: 1,
    pages: 1,
    total: legacy.length,
  };
}

/** Whether the owner can renew now. Unknown (legacy API) means no button. */
export function canRenew(domain: InventoryDomain): boolean {
  return (
    domain.expiryState === "renewable" ||
    domain.expiryState === "grace" ||
    domain.expiryState === "expired"
  );
}
