import { useState, useEffect, useCallback } from "react";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { apiFetch } from "../lib/api";

interface Relay {
  endpoint: string;
  publicKey: string;
  operator: "oxy" | "community";
  location: string;
  status: "active" | "inactive";
}

const FILTER_KEYS = {
  all: "filterAll",
  oxy: "filterOxy",
  community: "filterCommunity",
} as const;

export default function Network() {
  const { t } = useTranslation("network");
  const [relays, setRelays] = useState<Relay[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "oxy" | "community">("all");

  const fetchRelays = useCallback(() => {
    setLoading(true);
    apiFetch<Relay[]>("/relays")
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

      <h1 className="mb-2 font-pixel text-xl text-accent">{t("title")}</h1>
      <p className="mb-8 font-mono text-sm text-muted">
        {t("subtitle")}
      </p>

      {loading ? (
        <p className="font-mono text-sm text-muted">
          {t("loadingStatus")}
        </p>
      ) : (
        <>
          <div className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-edge bg-surface-card p-4">
              <p className="font-mono text-xs uppercase tracking-wider text-muted">
                {t("activeRelays")}
              </p>
              <p className="mt-1 font-pixel text-2xl text-accent">
                {activeRelays.length}
              </p>
            </div>
            <div className="rounded-lg border border-edge bg-surface-card p-4">
              <p className="font-mono text-xs uppercase tracking-wider text-muted">
                {t("oxyOperated")}
              </p>
              <p className="mt-1 font-pixel text-2xl text-primary">
                {oxyCount}
              </p>
            </div>
            <div className="rounded-lg border border-edge bg-surface-card p-4">
              <p className="font-mono text-xs uppercase tracking-wider text-muted">
                {t("community")}
              </p>
              <p className="mt-1 font-pixel text-2xl text-primary">
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
                    ? "border border-accent/30 bg-accent/10 text-accent"
                    : "border border-edge text-muted hover:text-secondary"
                }`}
              >
                {t(FILTER_KEYS[f])}
              </button>
            ))}
          </div>

          {filteredRelays.length === 0 ? (
            <p className="font-mono text-sm text-muted">
              {t("noRelaysMatch")}
            </p>
          ) : (
            <div className="space-y-3">
              {filteredRelays.map((relay) => (
                <div
                  key={relay.endpoint}
                  className="rounded-lg border border-edge bg-surface-card p-4"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${
                          relay.status === "active"
                            ? "bg-green-400"
                            : "bg-gray-500"
                        }`}
                        title={relay.status}
                      />
                      <code className="font-mono text-sm text-primary">
                        {relay.endpoint}
                      </code>
                      <span
                        className={`rounded-md px-2.5 py-0.5 font-mono text-xs font-medium ${
                          relay.operator === "oxy"
                            ? "bg-accent/10 text-accent"
                            : "bg-surface-hover text-secondary"
                        }`}
                      >
                        {relay.operator}
                      </span>
                    </div>
                    <span className="font-mono text-xs text-muted">
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
