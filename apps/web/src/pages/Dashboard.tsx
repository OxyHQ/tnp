import { useCallback, useEffect, useRef, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "@oxy.so/bloom/toast";
import type {
  DnsRecordDto,
  DnsRecordField,
  DnsRecordInput,
  RenewDomainResponse,
} from "@tnp/shared-types";
import { apiFetch, errorBody, errorMessage, errorStatus } from "../lib/api";
import {
  canRenew,
  loadInventoryPage,
  type InventoryDomain,
  type InventoryPage,
} from "../lib/ownedDomains";
import { useLocaleFormatter } from "../lib/useLocaleFormatter";
import RecordEditor, { type RecordFieldError } from "../components/RecordEditor";
import ReleaseDomainDialog from "../components/ReleaseDomainDialog";

type Inventory =
  | { status: "loading" }
  | { status: "error"; message: string }
  | ({ status: "ready" } & InventoryPage);

type RecordsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; records: DnsRecordDto[] };

const EXPIRY_BADGE: Record<string, string> = {
  active: "bg-primary/10 text-primary-text",
  renewable: "bg-warning-subtle text-warning-text",
  grace: "bg-error-subtle text-error-text",
  expired: "bg-error-subtle text-error-text",
};

const fetchJson = <T,>(path: string) => apiFetch<T>(path);

const RECORD_FIELDS: readonly DnsRecordField[] = ["body", "type", "name", "value", "priority", "ttl"];

function isRecordField(value: string | undefined): value is DnsRecordField {
  return value !== undefined && (RECORD_FIELDS as readonly string[]).includes(value);
}

export default function Dashboard() {
  const { t } = useTranslation(["dashboard", "common"]);
  const { formatDate } = useLocaleFormatter();
  const [page, setPage] = useState(1);
  const [inventory, setInventory] = useState<Inventory>({ status: "loading" });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [records, setRecords] = useState<Record<string, RecordsState>>({});
  // Keys of in-flight actions, e.g. `renew:<domainId>`. Each disables only its
  // own control, so a slow request never locks the whole page.
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  // The same keys, read synchronously: a second click can arrive before React
  // re-renders the disabled button, and state from that render is stale.
  const inFlight = useRef(new Set<string>());
  const [releasing, setReleasing] = useState<InventoryDomain | null>(null);

  const load = useCallback(
    async (target: number) => {
      setInventory({ status: "loading" });
      try {
        const loaded = await loadInventoryPage(fetchJson, errorStatus, target);
        setInventory({ status: "ready", ...loaded });
      } catch (err) {
        setInventory({ status: "error", message: errorMessage(err, t("dashboard:loadError")) });
      }
    },
    [t],
  );

  useEffect(() => {
    void load(page);
  }, [load, page]);

  const loadRecords = useCallback(
    async (domainId: string) => {
      setRecords((prev) => ({ ...prev, [domainId]: { status: "loading" } }));
      try {
        const list = await apiFetch<DnsRecordDto[]>(`/domains/${domainId}/records`);
        setRecords((prev) => ({ ...prev, [domainId]: { status: "ready", records: list } }));
      } catch (err) {
        setRecords((prev) => ({
          ...prev,
          [domainId]: { status: "error", message: errorMessage(err, t("dashboard:recordsError")) },
        }));
      }
    },
    [t],
  );

  const toggle = (domainId: string) => {
    if (expanded === domainId) {
      setExpanded(null);
      return;
    }
    setExpanded(domainId);
    if (records[domainId]?.status !== "ready") void loadRecords(domainId);
  };

  /** Run one action under a pending key; the key is released however it ends. */
  const track = async <T,>(key: string, action: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current.has(key)) return undefined;
    inFlight.current.add(key);
    setPending((prev) => new Set(prev).add(key));
    try {
      return await action();
    } finally {
      inFlight.current.delete(key);
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  /** Update one domain in place; the rest of the inventory is not refetched. */
  const patchDomain = (domainId: string, patch: (domain: InventoryDomain) => InventoryDomain | null) => {
    setInventory((prev) => {
      if (prev.status !== "ready") return prev;
      let removed = 0;
      const domains = prev.domains.flatMap((domain) => {
        if (domain._id !== domainId) return [domain];
        const next = patch(domain);
        if (next === null) removed += 1;
        return next === null ? [] : [next];
      });
      return { ...prev, domains, total: prev.total - removed };
    });
  };

  const addRecord = async (domainId: string, record: DnsRecordInput): Promise<RecordFieldError | null> => {
    const result = await track(`record:add:${domainId}`, async () => {
      try {
        const created = await apiFetch<DnsRecordDto>(`/domains/${domainId}/records`, {
          method: "POST",
          body: JSON.stringify(record),
        });
        setRecords((prev) => {
          const current = prev[domainId];
          if (current?.status !== "ready") return prev;
          return { ...prev, [domainId]: { status: "ready", records: [...current.records, created] } };
        });
        patchDomain(domainId, (domain) => ({ ...domain, recordCount: domain.recordCount + 1 }));
        toast.success(t("dashboard:recordAdded"));
        return null;
      } catch (err) {
        const body = errorBody(err);
        const message = errorMessage(err, t("dashboard:recordAddFailed"));
        // A field error belongs next to the field; anything else (a conflict,
        // the record cap, a network failure) is a toast.
        if (errorStatus(err) === 400 && isRecordField(body.field)) {
          return { field: body.field, code: body.code ?? "", message };
        }
        toast.error(t(`common:recordErrors.${body.code ?? "unknown"}`, { defaultValue: message }));
        return null;
      }
    });
    return result ?? null;
  };

  const deleteRecord = (domainId: string, recordId: string) =>
    track(`record:delete:${recordId}`, async () => {
      try {
        await apiFetch(`/domains/${domainId}/records/${recordId}`, { method: "DELETE" });
        setRecords((prev) => {
          const current = prev[domainId];
          if (current?.status !== "ready") return prev;
          return {
            ...prev,
            [domainId]: { status: "ready", records: current.records.filter((r) => r._id !== recordId) },
          };
        });
        patchDomain(domainId, (domain) => ({ ...domain, recordCount: Math.max(0, domain.recordCount - 1) }));
      } catch (err) {
        toast.error(errorMessage(err, t("dashboard:recordDeleteFailed")));
      }
    });

  const renew = (domain: InventoryDomain) =>
    track(`renew:${domain._id}`, async () => {
      try {
        const renewed = await apiFetch<RenewDomainResponse>(`/domains/${domain._id}/renew`, {
          method: "POST",
        });
        patchDomain(domain._id, (current) => ({
          ...current,
          expiresAt: renewed.expiresAt,
          expiryState: renewed.expiryState,
        }));
        toast.success(t("dashboard:renewed", { domain: `${domain.name}.${domain.tld}` }));
      } catch (err) {
        toast.error(errorMessage(err, t("dashboard:renewFailed")));
      }
    });

  const release = (domain: InventoryDomain) =>
    track(`release:${domain._id}`, async () => {
      try {
        await apiFetch(`/domains/${domain._id}`, { method: "DELETE" });
        setReleasing(null);
        if (expanded === domain._id) setExpanded(null);
        // Releasing the last domain on a later page would leave an empty page
        // behind; step back instead.
        if (inventory.status === "ready" && inventory.domains.length === 1 && page > 1) {
          setPage(page - 1);
        } else {
          patchDomain(domain._id, () => null);
        }
        toast.success(t("dashboard:released", { domain: `${domain.name}.${domain.tld}` }));
      } catch (err) {
        toast.error(errorMessage(err, t("dashboard:releaseFailed")));
      }
    });

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>{t("dashboard:meta.title")}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>
      <div className="mb-8 flex gap-3">
        <Link
          to="/dashboard"
          aria-current="page"
          className="cursor-pointer rounded-lg px-4 py-2 font-mono text-sm transition-colors border border-primary/30 bg-primary/10 text-primary-text"
        >
          {t("dashboard:tabs.domains")}
        </Link>
        <Link
          to="/service-nodes"
          className="cursor-pointer rounded-lg px-4 py-2 font-mono text-sm transition-colors border border-border text-muted-foreground/70 hover:text-muted-foreground"
        >
          {t("dashboard:tabs.serviceNodes")}
        </Link>
      </div>

      <h1 className="mb-8 font-pixel text-xl text-primary-text">
        {t("dashboard:heading")}
      </h1>

      {inventory.status === "loading" && (
        <p role="status" className="font-mono text-sm text-muted-foreground/70">
          {t("dashboard:loading")}
        </p>
      )}

      {inventory.status === "error" && (
        <div role="alert" className="rounded-lg border border-border bg-card p-6">
          <p className="mb-3 font-mono text-sm text-error-text">{t("dashboard:loadError")}</p>
          <p className="mb-4 font-mono text-xs text-muted-foreground/70">{inventory.message}</p>
          <button
            type="button"
            onClick={() => void load(page)}
            className="cursor-pointer rounded-md border border-primary/30 bg-primary/10 px-3 py-2 font-mono text-xs text-primary-text transition-colors hover:bg-primary/20"
          >
            [{t("common:retry")}]
          </button>
        </div>
      )}

      {inventory.status === "ready" && inventory.domains.length === 0 && (
        <div className="rounded-lg border border-border bg-card p-6">
          <p className="font-mono text-sm text-muted-foreground/70">
            {t("dashboard:emptyState")}{" "}
            <Link to="/register" className="text-primary-text transition-colors hover:text-foreground">
              {t("dashboard:emptyStateRegister")}
            </Link>
          </p>
        </div>
      )}

      {inventory.status === "ready" && inventory.domains.length > 0 && (
        <div className="space-y-3">
          {inventory.domains.map((domain) => {
            const fullName = `${domain.name}.${domain.tld}`;
            const isOpen = expanded === domain._id;
            const panelId = `domain-panel-${domain._id}`;
            const recordState = records[domain._id];
            return (
              <div key={domain._id} className="rounded-lg border border-border bg-card">
                <button
                  type="button"
                  onClick={() => toggle(domain._id)}
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  className="flex w-full cursor-pointer flex-wrap items-center justify-between gap-2 p-4 text-left"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-mono text-sm">
                      {domain.name}
                      <span className="text-primary-text">.{domain.tld}</span>
                    </span>
                    <span
                      className={`rounded-md px-2.5 py-0.5 font-mono text-xs font-medium ${
                        domain.status === "active"
                          ? "bg-primary/10 text-primary-text"
                          : "bg-accent text-muted-foreground/70"
                      }`}
                    >
                      {domain.status}
                    </span>
                    {domain.expiryState && (
                      <span
                        className={`rounded-md px-2.5 py-0.5 font-mono text-xs font-medium ${EXPIRY_BADGE[domain.expiryState]}`}
                      >
                        {t(`dashboard:expiry.state.${domain.expiryState}`)}
                      </span>
                    )}
                  </div>
                  <span className="font-mono text-xs text-muted-foreground/70">
                    {t("common:recordCount", { count: domain.recordCount })}
                  </span>
                </button>

                {isOpen && (
                  <div id={panelId} className="space-y-6 border-t border-border p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="font-mono text-xs text-muted-foreground">
                        {domain.expiresAt
                          ? t("dashboard:expiry.expiresOn", { date: formatDate(domain.expiresAt) })
                          : t("dashboard:expiry.never")}
                      </p>
                      {canRenew(domain) && (
                        <button
                          type="button"
                          onClick={() => void renew(domain)}
                          disabled={pending.has(`renew:${domain._id}`)}
                          aria-busy={pending.has(`renew:${domain._id}`)}
                          className="cursor-pointer rounded-md border border-primary/30 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary-text transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {pending.has(`renew:${domain._id}`)
                            ? t("dashboard:expiry.renewing")
                            : t("dashboard:expiry.renew")}
                        </button>
                      )}
                    </div>

                    {(!recordState || recordState.status === "loading") && (
                      <p role="status" className="font-mono text-xs text-muted-foreground/70">
                        {t("dashboard:recordsLoading")}
                      </p>
                    )}

                    {recordState?.status === "error" && (
                      <div role="alert" className="flex flex-wrap items-center gap-3">
                        <p className="font-mono text-xs text-error-text">{recordState.message}</p>
                        <button
                          type="button"
                          onClick={() => void loadRecords(domain._id)}
                          className="cursor-pointer font-mono text-xs text-primary-text transition-colors hover:text-foreground"
                        >
                          [{t("common:retry")}]
                        </button>
                      </div>
                    )}

                    {recordState?.status === "ready" && recordState.records.length === 0 && (
                      <p className="font-mono text-xs text-muted-foreground/70">{t("dashboard:noRecords")}</p>
                    )}

                    {recordState?.status === "ready" && recordState.records.length > 0 && (
                      <div className="overflow-x-auto">
                        <table className="w-full font-mono text-sm">
                          <caption className="sr-only">{t("dashboard:recordsCaption", { domain: fullName })}</caption>
                          <thead>
                            <tr className="text-left text-xs text-muted-foreground/70">
                              <th scope="col" className="pb-2 pr-4">{t("common:form.type")}</th>
                              <th scope="col" className="pb-2 pr-4">{t("common:form.name")}</th>
                              <th scope="col" className="pb-2 pr-4">{t("common:form.value")}</th>
                              <th scope="col" className="pb-2 pr-4">{t("common:form.ttl")}</th>
                              <th scope="col" className="pb-2">
                                <span className="sr-only">{t("dashboard:actions")}</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {recordState.records.map((record) => {
                              const deleting = pending.has(`record:delete:${record._id}`);
                              return (
                                <tr key={record._id} className="border-t border-muted">
                                  <td className="py-2 pr-4 text-xs text-muted-foreground">{record.type}</td>
                                  <td className="py-2 pr-4 text-foreground">{record.name}</td>
                                  <td className="break-all py-2 pr-4 text-xs text-muted-foreground/70">{record.value}</td>
                                  <td className="py-2 pr-4 text-muted-foreground/70">{record.ttl}</td>
                                  <td className="py-2">
                                    <button
                                      type="button"
                                      onClick={() => void deleteRecord(domain._id, record._id)}
                                      disabled={deleting}
                                      aria-busy={deleting}
                                      aria-label={t("dashboard:deleteRecordLabel", {
                                        type: record.type,
                                        name: record.name,
                                      })}
                                      className="cursor-pointer text-xs text-destructive transition-colors hover:text-destructive/80 disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                      [{deleting ? t("dashboard:deleting") : t("common:delete")}]
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}

                    <div>
                      <h2 className="mb-3 font-mono text-xs uppercase tracking-wider text-muted-foreground/70">
                        {t("dashboard:addRecord")}
                      </h2>
                      <RecordEditor
                        pending={pending.has(`record:add:${domain._id}`)}
                        onSubmit={(record) => addRecord(domain._id, record)}
                      />
                    </div>

                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={() => setReleasing(domain)}
                        disabled={pending.has(`release:${domain._id}`)}
                        className="cursor-pointer font-mono text-xs text-destructive transition-colors hover:text-destructive/80 disabled:opacity-50"
                      >
                        [{t("common:releaseDomain")}]
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {inventory.status === "ready" && inventory.pages > 1 && (
        <nav aria-label={t("dashboard:pagination")} className="mt-8 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="cursor-pointer font-mono text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            [{t("common:prev")}]
          </button>
          <span className="font-mono text-sm text-muted-foreground/70">
            {t("common:pagination", { page: inventory.page, totalPages: inventory.pages })}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(inventory.pages, p + 1))}
            disabled={page >= inventory.pages}
            className="cursor-pointer font-mono text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            [{t("common:next")}]
          </button>
        </nav>
      )}

      {releasing && (
        <ReleaseDomainDialog
          domain={`${releasing.name}.${releasing.tld}`}
          pending={pending.has(`release:${releasing._id}`)}
          onConfirm={() => void release(releasing)}
          onCancel={() => setReleasing(null)}
        />
      )}
    </div>
  );
}
