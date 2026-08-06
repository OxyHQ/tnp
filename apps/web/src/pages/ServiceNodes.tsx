import { useState, useEffect, useCallback } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import type { ServiceNodeLookup } from "@tnp/shared-types";
import { apiFetch } from "../lib/api";
import { useLocaleFormatter } from "../lib/useLocaleFormatter";

interface Domain {
  _id: string;
  name: string;
  tld: string;
  status: string;
  serviceNodeId?: string;
}

interface DomainWithNode {
  domain: Domain;
  node: ServiceNodeLookup | null;
  loading: boolean;
}

export default function ServiceNodes() {
  const { t } = useTranslation(["serviceNodes", "common"]);
  const { formatRelativeTime } = useLocaleFormatter();
  const [entries, setEntries] = useState<DomainWithNode[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  const fetchDomains = useCallback(() => {
    setDomainsLoading(true);
    apiFetch<Domain[]>("/domains/mine")
      .then((domains) => {
        setEntries(
          domains.map((domain) => ({ domain, node: null, loading: true }))
        );
        setDomainsLoading(false);

        domains.forEach((domain) => {
          apiFetch<ServiceNodeLookup>(`/nodes/${domain.name}.${domain.tld}`)
            .then((node) => {
              setEntries((prev) =>
                prev.map((e) =>
                  e.domain._id === domain._id
                    ? { ...e, node, loading: false }
                    : e
                )
              );
            })
            .catch(() => {
              setEntries((prev) =>
                prev.map((e) =>
                  e.domain._id === domain._id
                    ? { ...e, node: null, loading: false }
                    : e
                )
              );
            });
        });
      })
      .catch(() => {
        setDomainsLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchDomains();
  }, [fetchDomains]);

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
          className="cursor-pointer rounded-lg px-4 py-2 font-mono text-sm transition-colors border border-edge text-muted-foreground/70 hover:text-muted-foreground"
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

      {domainsLoading ? (
        <p className="font-mono text-sm text-muted-foreground/70">{t("serviceNodes:loadingDomains")}</p>
      ) : entries.length === 0 ? (
        <div className="rounded-lg border border-edge bg-surface-card p-6">
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
      ) : (
        <div className="space-y-3">
          {entries.map(({ domain, node, loading }) => (
            <div
              key={domain._id}
              className="rounded-lg border border-edge bg-surface-card p-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      loading
                        ? "bg-info-text"
                        : node?.status === "online"
                          ? "bg-success-text"
                          : "bg-muted-foreground"
                    }`}
                    title={
                      loading
                        ? t("common:status.checking")
                        : node?.status === "online"
                          ? t("common:status.online")
                          : t("common:status.offline")
                    }
                  />
                  <span className="font-mono text-sm">
                    {domain.name}
                    <span className="text-primary-text">.{domain.tld}</span>
                  </span>
                  <span
                    className={`rounded-md px-2.5 py-0.5 font-mono text-xs font-medium ${
                      loading
                        ? "bg-surface-hover text-muted-foreground/70"
                        : node?.status === "online"
                          ? "bg-primary/10 text-primary-text"
                          : "bg-surface-hover text-muted-foreground/70"
                    }`}
                  >
                    {loading
                      ? t("common:status.checking")
                      : node?.status
                        ? t(`common:status.${node.status}`)
                        : t("common:status.noNode")}
                  </span>
                </div>
                {node?.lastSeen && (
                  <span className="font-mono text-xs text-muted-foreground/70">
                    {t("serviceNodes:lastSeen", { time: formatRelativeTime(node.lastSeen) })}
                  </span>
                )}
              </div>

              {node && !loading && (
                <div className="mt-3 space-y-2 border-t border-edge pt-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground/70">
                      {t("serviceNodes:publicKey")}
                    </span>
                    <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                      {truncateKey(node.publicKey)}
                    </code>
                    <button
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
                      <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                        {node.connectedRelay}
                      </code>
                    </div>
                  )}
                </div>
              )}

              {!node && !loading && (
                <p className="mt-3 border-t border-edge pt-3 font-mono text-xs text-muted-foreground/70">
                  {t("serviceNodes:noNodeConfigured")}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-12 rounded-lg border border-edge bg-surface-card p-5 space-y-4">
        <h2 className="font-pixel text-lg text-primary-text">{t("serviceNodes:setup.heading")}</h2>
        <p className="font-mono text-xs text-muted-foreground/70">
          {t("serviceNodes:setup.intro")}
        </p>

        <div className="space-y-3">
          <div>
            <p className="mb-1 font-mono text-xs font-medium text-muted-foreground">
              {t("serviceNodes:setup.step1Title")}
            </p>
            <code className="block rounded bg-surface px-3 py-2 font-mono text-xs text-primary-text">
              curl -fsSL https://get.tnp.network | sh
            </code>
          </div>

          <div>
            <p className="mb-1 font-mono text-xs font-medium text-muted-foreground">
              {t("serviceNodes:setup.step2Title")}
            </p>
            <code className="block rounded bg-surface px-3 py-2 font-mono text-xs text-primary-text">
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
                components={{ code: <code className="rounded bg-surface px-1.5 py-0.5 text-primary-text" /> }}
              />
            </p>
          </div>
        </div>

        <p className="font-mono text-xs text-muted-foreground/70">
          <Trans
            i18nKey="serviceNodes:setup.footer"
            t={t}
            components={{
              code1: <code className="rounded bg-surface px-1.5 py-0.5 text-primary-text" />,
              code2: <code className="rounded bg-surface px-1.5 py-0.5 text-primary-text" />,
            }}
          />
        </p>
      </div>
    </div>
  );
}
