import { useState, useEffect, useCallback } from "react";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import type { RelayDirectoryEntry, RelayOperator } from "@tnp/shared-types";
import { apiFetch } from "../lib/api";

const FILTER_KEYS = {
  all: "filterAll",
  oxy: "filterOxy",
  community: "filterCommunity",
} as const;

export default function Network() {
  const { t } = useTranslation("network");
  const [relays, setRelays] = useState<RelayDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | RelayOperator>("all");

  const fetchRelays = useCallback(() => {
    setLoading(true);
    apiFetch<RelayDirectoryEntry[]>("/relays")
      .then((data) => {
        setRelays(data);
        setLoading(false);
      })
      .catch(() => {
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchRelays();
  }, [fetchRelays]);

  const activeRelays = relays.filter((r) => r.status === "active");
  const oxyCount = activeRelays.filter((r) => r.operator === "oxy").length;
  const communityCount = activeRelays.filter(
    (r) => r.operator === "community"
  ).length;

  const filteredRelays =
    filter === "all"
      ? relays
      : relays.filter((r) => r.operator === filter);

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>{t("meta.title")} — TNP</title>
        <meta
          name="description"
          content={t("meta.description")}
        />
        <link rel="canonical" href="https://tnp.network/network" />
        <meta property="og:title" content={`${t("meta.title")} — TNP`} />
        <meta
          property="og:description"
          content={t("meta.ogDescription")}
        />
        <meta property="og:url" content="https://tnp.network/network" />
      </Helmet>

      <h1 className="mb-2 font-pixel text-xl text-primary-text">{t("title")}</h1>
      <p className="mb-8 font-mono text-sm text-muted-foreground/70">
        {t("subtitle")}
      </p>

      {loading ? (
        <p className="font-mono text-sm text-muted-foreground/70">
          {t("loadingStatus")}
        </p>
      ) : (
        <>
          <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground/70">
                {t("activeRelays")}
              </p>
              <p className="mt-1 font-pixel text-2xl text-primary-text">
                {activeRelays.length}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground/70">
                {t("oxyOperated")}
              </p>
              <p className="mt-1 font-pixel text-2xl text-foreground">
                {oxyCount}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card p-4">
              <p className="font-mono text-xs uppercase tracking-wider text-muted-foreground/70">
                {t("community")}
              </p>
              <p className="mt-1 font-pixel text-2xl text-foreground">
                {communityCount}
              </p>
            </div>
          </div>

          <div className="mb-6 flex gap-2">
            {(["all", "oxy", "community"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`cursor-pointer rounded-md px-3 py-1.5 font-mono text-sm transition-colors ${
                  filter === f
                    ? "border border-primary/30 bg-primary/10 text-primary-text"
                    : "border border-border text-muted-foreground/70 hover:text-muted-foreground"
                }`}
              >
                {t(FILTER_KEYS[f])}
              </button>
            ))}
          </div>

          {filteredRelays.length === 0 ? (
            <p className="font-mono text-sm text-muted-foreground/70">
              {t("noRelaysMatch")}
            </p>
          ) : (
            <div className="space-y-3">
              {filteredRelays.map((relay) => (
                <div
                  key={relay.endpoint}
                  className="rounded-lg border border-border bg-card p-4"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${
                          relay.status === "active"
                            ? "bg-success-text"
                            : "bg-muted-foreground"
                        }`}
                        title={relay.status}
                      />
                      <code className="font-mono text-sm text-foreground">
                        {relay.endpoint}
                      </code>
                      <span
                        className={`rounded-md px-2.5 py-0.5 font-mono text-xs font-medium ${
                          relay.operator === "oxy"
                            ? "bg-primary/10 text-primary-text"
                            : "bg-accent text-muted-foreground"
                        }`}
                      >
                        {relay.operator}
                      </span>
                    </div>
                    <span className="font-mono text-xs text-muted-foreground/70">
                      {relay.location}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
