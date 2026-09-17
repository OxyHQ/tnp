import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { OwnedPublicDomainPage } from "@tnp/shared-types";
import { apiRequest } from "../../lib/api";
import { errorMessage, errorStatus, isAbort } from "../../lib/services/errors";
import { lifecyclePresentation, zoneStatePresentation } from "../../lib/services/status";
import { useLocaleFormatter } from "../../lib/useLocaleFormatter";
import { DomainName, ErrorPanel, LINK_BUTTON_CLASSES, NamespaceBadge, SandboxBadge, StatusBadge } from "./ui";

const PAGE_SIZE = 25;

type InventoryState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; page: OwnedPublicDomainPage };

/**
 * The owner's public domains. Loading, failure and an empty inventory are
 * three different states: "you have none" is never shown for "we could not
 * ask".
 */
export default function Inventory() {
  const { t } = useTranslation("services");
  const { formatDate } = useLocaleFormatter();
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<InventoryState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    apiRequest<OwnedPublicDomainPage>("GET", `/services/domains?page=${page}&limit=${PAGE_SIZE}`, { signal: controller.signal })
      .then((result) => setState({ kind: "ready", page: result }))
      .catch((err: unknown) => {
        if (isAbort(err, controller.signal)) return;
        setState({
          kind: "error",
          message: errorMessage(err) ?? (errorStatus(err) === null ? t("errors.network") : t("inventory.failed")),
        });
      });
    return () => controller.abort();
  }, [page, attempt, t]);

  return (
    <section aria-labelledby="services-inventory-heading" className="space-y-4">
      <h2 id="services-inventory-heading" className="font-pixel text-lg text-primary-text">
        {t("inventory.heading")}
      </h2>

      <div aria-live="polite" aria-busy={state.kind === "loading"}>
        {state.kind === "loading" && (
          <p className="font-mono text-sm text-muted-foreground/70">{t("inventory.loading")}</p>
        )}

        {state.kind === "error" && (
          <ErrorPanel message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
        )}

        {state.kind === "ready" && state.page.domains.length === 0 && (
          <div className="rounded-lg border border-border bg-card p-6">
            <p className="font-mono text-sm text-muted-foreground/70">{t("inventory.empty")}</p>
          </div>
        )}

        {state.kind === "ready" && state.page.domains.length > 0 && (
          <ul className="space-y-3">
            {state.page.domains.map((domain) => (
              <li key={domain.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to={`/services/domains/${domain.id}`}
                      className="rounded-sm transition-colors hover:text-primary-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                    >
                      <DomainName name={domain.name} displayName={domain.displayName} />
                    </Link>
                    <NamespaceBadge namespace="public-dns" />
                    <StatusBadge presentation={lifecyclePresentation(domain.lifecycle)} />
                    {domain.provider.environment === "sandbox" && <SandboxBadge />}
                  </div>
                  <Link
                    to={`/services/domains/${domain.id}`}
                    className="font-mono text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground"
                    aria-label={t("inventory.manageName", { name: domain.displayName })}
                  >
                    [{t("inventory.manage")}]
                  </Link>
                </div>
                <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 border-t border-border pt-3 font-mono text-xs sm:grid-cols-3">
                  <div>
                    <dt className="text-muted-foreground/70">{t("domain.expires")}</dt>
                    <dd className="text-muted-foreground">
                      {domain.expiresAt ? formatDate(domain.expiresAt) : t("domain.expiresUnknown")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground/70">{t("domain.provider")}</dt>
                    <dd className="text-muted-foreground">
                      {domain.provider.adapter} · {t(`provider.environment.${domain.provider.environment}`)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground/70">{t("zone.heading")}</dt>
                    <dd className="flex flex-wrap items-center gap-2 text-muted-foreground">
                      {domain.zone ? (
                        <>
                          <span>{t(`zone.authority.${domain.zone.authority}`)}</span>
                          <StatusBadge presentation={zoneStatePresentation(domain.zone.state)} />
                        </>
                      ) : (
                        t("zone.none")
                      )}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </div>

      {state.kind === "ready" && state.page.pages > 1 && (
        <nav aria-label={t("inventory.pagination")} className="flex items-center justify-center gap-4 font-mono text-sm">
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className={LINK_BUTTON_CLASSES}
          >
            [{t("inventory.prev")}]
          </button>
          <span className="text-muted-foreground/70">
            {t("inventory.pageOf", { page: state.page.page, pages: state.page.pages })}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(state.page.pages, p + 1))}
            disabled={page >= state.page.pages}
            className={LINK_BUTTON_CLASSES}
          >
            [{t("inventory.next")}]
          </button>
        </nav>
      )}
    </section>
  );
}
