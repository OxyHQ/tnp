import { useState, useEffect, useCallback } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import type { ServiceNodeLookup } from "@tnp/shared-types";
import { apiFetch, errorMessage, errorStatus } from "../lib/api";
import { loadInventoryPage, type InventoryDomain, type InventoryPage } from "../lib/ownedDomains";
import { useLocaleFormatter } from "../lib/useLocaleFormatter";

/** A domain's node lookup: pending, none registered (404), found, or failed. */
type NodeState =
  | { status: "loading" }
  | { status: "none" }
  | { status: "found"; node: ServiceNodeLookup }
  | { status: "error" };

interface DomainWithNode {
  domain: InventoryDomain;
  node: NodeState;
}

type Inventory =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; entries: DomainWithNode[]; page: number; pages: number };

const fetchJson = <T,>(path: string) => apiFetch<T>(path);

export default function ServiceNodes() {
  const { t } = useTranslation(["serviceNodes", "common"]);
  const { formatRelativeTime } = useLocaleFormatter();
  const [page, setPage] = useState(1);
  const [inventory, setInventory] = useState<Inventory>({ status: "loading" });
  const [copied, setCopied] = useState<string | null>(null);

  const setNode = (domainId: string, node: NodeState) => {
    setInventory((prev) =>
      prev.status !== "ready"
        ? prev
        : {
            ...prev,
            entries: prev.entries.map((e) => (e.domain._id === domainId ? { ...e, node } : e)),
          },
    );
  };

  const load = useCallback(
    async (target: number) => {
      setInventory({ status: "loading" });
      let loaded: InventoryPage;
      try {
        loaded = await loadInventoryPage(fetchJson, errorStatus, target);
      } catch (err) {
        setInventory({ status: "error", message: errorMessage(err, t("serviceNodes:loadError")) });
        return;
      }

      setInventory({
        status: "ready",
        page: loaded.page,
        pages: loaded.pages,
        entries: loaded.domains.map((domain) => ({ domain, node: { status: "loading" } })),
      });

      // A 404 means no node is registered; anything else is a failed check,
      // which must not read as "no node".
      for (const domain of loaded.domains) {
        apiFetch<ServiceNodeLookup>(`/nodes/${domain.name}.${domain.tld}`)
          .then((node) => setNode(domain._id, { status: "found", node }))
          .catch((err) =>
            setNode(domain._id, errorStatus(err) === 404 ? { status: "none" } : { status: "error" }),
          );
      }
    },
    [t],
  );

  useEffect(() => {
    void load(page);
  }, [load, page]);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const truncateKey = (key: string): string => {
    if (key.length <= 20) return key;
    return `${key.slice(0, 10)}...${key.slice(-10)}`;
  };

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>{t("serviceNodes:meta.title")}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="mb-8 flex gap-3">
        <Link
          to="/dashboard"
          className="cursor-pointer rounded-lg px-4 py-2 font-mono text-sm transition-colors border border-border text-muted-foreground/70 hover:text-muted-foreground"
        >
          {t("serviceNodes:tabs.domains")}
        </Link>
        <Link
          to="/service-nodes"
          className="cursor-pointer rounded-lg px-4 py-2 font-mono text-sm transition-colors border border-primary/30 bg-primary/10 text-primary-text"
        >
          {t("serviceNodes:tabs.serviceNodes")}
        </Link>
      </div>

      <h1 className="mb-2 font-pixel text-xl text-primary-text">{t("serviceNodes:heading")}</h1>
      <p className="mb-8 font-mono text-sm text-muted-foreground/70">
        {t("serviceNodes:subtitle")}
      </p>

      {inventory.status === "loading" && (
        <p role="status" className="font-mono text-sm text-muted-foreground/70">
          {t("serviceNodes:loadingDomains")}
        </p>
      )}

      {inventory.status === "error" && (
        <div role="alert" className="rounded-lg border border-border bg-card p-6">
          <p className="mb-3 font-mono text-sm text-error-text">{t("serviceNodes:loadError")}</p>
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

      {inventory.status === "ready" && inventory.entries.length === 0 && (
        <div className="rounded-lg border border-border bg-card p-6">
          <p className="font-mono text-sm text-muted-foreground/70">
            {t("serviceNodes:emptyState")}{" "}
            <Link
              to="/register"
              className="text-primary-text transition-colors hover:text-foreground"
            >
              {t("serviceNodes:emptyStateRegister")}
            </Link>{" "}
            {t("serviceNodes:emptyStateToGetStarted")}
          </p>
        </div>
      )}

      {inventory.status === "ready" && inventory.entries.length > 0 && (
        <div className="space-y-3">
          {inventory.entries.map(({ domain, node: state }) => {
            const node = state.status === "found" ? state.node : null;
            const loading = state.status === "loading";
            const label = loading
              ? t("common:status.checking")
              : state.status === "error"
                ? t("serviceNodes:checkFailed")
                : node
                  ? t(`common:status.${node.status}`)
                  : t("common:status.noNode");
            return (
              <div
                key={domain._id}
                className="rounded-lg border border-border bg-card p-4"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span
                      aria-hidden="true"
                      className={`inline-block h-2 w-2 rounded-full ${
                        loading
                          ? "bg-info-text"
                          : node?.status === "online"
                            ? "bg-success-text"
                            : "bg-muted-foreground"
                      }`}
                    />
                    <span className="font-mono text-sm">
                      {domain.name}
                      <span className="text-primary-text">.{domain.tld}</span>
                    </span>
                    <span
                      className={`rounded-md px-2.5 py-0.5 font-mono text-xs font-medium ${
                        state.status === "error"
                          ? "bg-error-subtle text-error-text"
                          : node?.status === "online"
                            ? "bg-primary/10 text-primary-text"
                            : "bg-accent text-muted-foreground/70"
                      }`}
                    >
                      {label}
                    </span>
                  </div>
                  {node?.lastSeen && (
                    <span className="font-mono text-xs text-muted-foreground/70">
                      {t("serviceNodes:lastSeen", { time: formatRelativeTime(node.lastSeen) })}
                    </span>
                  )}
                </div>

                {node && (
                  <div className="mt-3 space-y-2 border-t border-border pt-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground/70">
                        {t("serviceNodes:publicKey")}
                      </span>
                      <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                        {truncateKey(node.publicKey)}
                      </code>
                      <button
                        type="button"
                        onClick={() =>
                          copyToClipboard(node.publicKey, domain._id)
                        }
                        className="cursor-pointer font-mono text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground"
                      >
                        [{copied === domain._id ? t("common:copied") : t("common:copy")}]
                      </button>
                    </div>
                    {node.connectedRelay && (
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground/70">
                          {t("serviceNodes:relay")}
                        </span>
                        <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                          {node.connectedRelay}
                        </code>
                      </div>
                    )}
                  </div>
                )}

                {state.status === "none" && (
                  <p className="mt-3 border-t border-border pt-3 font-mono text-xs text-muted-foreground/70">
                    {t("serviceNodes:noNodeConfigured")}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {inventory.status === "ready" && inventory.pages > 1 && (
        <nav aria-label={t("serviceNodes:pagination")} className="mt-8 flex items-center justify-center gap-3">
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

      <div className="mt-12 rounded-lg border border-border bg-card p-5 space-y-4">
        <h2 className="font-pixel text-lg text-primary-text">{t("serviceNodes:setup.heading")}</h2>
        <p className="font-mono text-xs text-muted-foreground/70">
          {t("serviceNodes:setup.intro")}
        </p>

        <div className="space-y-3">
          <div>
            <p className="mb-1 font-mono text-xs font-medium text-muted-foreground">
              {t("serviceNodes:setup.step1Title")}
            </p>
            <code className="block rounded bg-background px-3 py-2 font-mono text-xs text-primary-text">
              curl -fsSL https://get.tnp.network | sh
            </code>
          </div>

          <div>
            <p className="mb-1 font-mono text-xs font-medium text-muted-foreground">
              {t("serviceNodes:setup.step2Title")}
            </p>
            <code className="block rounded bg-background px-3 py-2 font-mono text-xs text-primary-text">
              tnp serve --domain example.ox --target localhost:80 --token
              &lt;your-token&gt;
            </code>
          </div>

          <div>
            <p className="mb-1 font-mono text-xs font-medium text-muted-foreground">
              {t("serviceNodes:setup.step3Title")}
            </p>
            <p className="font-mono text-xs text-muted-foreground/70">
              <Trans
                i18nKey="serviceNodes:setup.step3Desc"
                t={t}
                components={{ code: <code className="rounded bg-background px-1.5 py-0.5 text-primary-text" /> }}
              />
            </p>
          </div>
        </div>

        <p className="font-mono text-xs text-muted-foreground/70">
          <Trans
            i18nKey="serviceNodes:setup.footer"
            t={t}
            components={{
              code1: <code className="rounded bg-background px-1.5 py-0.5 text-primary-text" />,
              code2: <code className="rounded bg-background px-1.5 py-0.5 text-primary-text" />,
            }}
          />
        </p>
      </div>
    </div>
  );
}
