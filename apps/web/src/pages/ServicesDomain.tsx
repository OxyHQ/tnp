import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Helmet } from "react-helmet-async";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { OperationDto, OwnedPublicDomain } from "@tnp/shared-types";
import { apiRequest } from "../lib/api";
import { errorMessage, errorStatus, isAbort } from "../lib/services/errors";
import { lifecyclePresentation, zoneStatePresentation } from "../lib/services/status";
import { useServicesStatus } from "../lib/services/useServicesStatus";
import { useLocaleFormatter } from "../lib/useLocaleFormatter";
import OperationLog from "../components/services/OperationLog";
import { ServicesNotAvailable } from "../components/services/ServicesNotice";
import ZoneEditor from "../components/services/ZoneEditor";
import {
  Card,
  DomainName,
  ErrorPanel,
  LINK_BUTTON_CLASSES,
  NamespaceBadge,
  SandboxBadge,
  StatusBadge,
} from "../components/services/ui";

type Load<T> = { kind: "loading" } | { kind: "error"; message: string; notFound: boolean } | { kind: "ready"; value: T };

/**
 * One public domain as its owner sees it: registration facts, where its zone
 * lives, the operation log, and — only for a provider-hosted zone with DNS
 * editing enabled — the zone editor.
 */
export default function ServicesDomain() {
  const { id = "" } = useParams<{ id: string }>();
  const { t } = useTranslation("services");
  const { formatDate, formatRelativeTime } = useLocaleFormatter();
  const { availability, recheck } = useServicesStatus();
  const [domain, setDomain] = useState<Load<OwnedPublicDomain>>({ kind: "loading" });
  const [operations, setOperations] = useState<Load<OperationDto[]>>({ kind: "loading" });
  const [domainAttempt, setDomainAttempt] = useState(0);
  const [opsAttempt, setOpsAttempt] = useState(0);

  const failure = useCallback(
    (err: unknown, fallback: string) => ({
      kind: "error" as const,
      notFound: errorStatus(err) === 404,
      message: errorMessage(err) ?? (errorStatus(err) === null ? t("errors.network") : fallback),
    }),
    [t],
  );

  const enabled = availability.kind === "available";

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    // A refresh keeps the loaded domain on screen, so the zone editor and the
    // operation it is following are not unmounted by their own success.
    setDomain((prev) => (prev.kind === "ready" && prev.value.id === id ? prev : { kind: "loading" }));
    apiRequest<OwnedPublicDomain>("GET", `/services/domains/${encodeURIComponent(id)}`, { signal: controller.signal })
      .then((value) => setDomain({ kind: "ready", value }))
      .catch((err: unknown) => {
        if (isAbort(err, controller.signal)) return;
        setDomain((prev) => (prev.kind === "ready" && prev.value.id === id ? prev : failure(err, t("domain.failed"))));
      });
    return () => controller.abort();
  }, [id, enabled, domainAttempt, failure, t]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setOperations((prev) => (prev.kind === "ready" ? prev : { kind: "loading" }));
    apiRequest<OperationDto[]>("GET", `/services/domains/${encodeURIComponent(id)}/operations`, { signal: controller.signal })
      .then((value) => setOperations({ kind: "ready", value }))
      .catch((err: unknown) => {
        if (!isAbort(err, controller.signal)) setOperations(failure(err, t("operations.failed")));
      });
    return () => controller.abort();
  }, [id, enabled, opsAttempt, failure, t]);

  // The editor reports its operation as it moves; fold it into the log so the
  // two never disagree, and refresh the domain once it settles (zone state).
  const onOperation = useCallback((op: OperationDto) => {
    setOperations((prev) => {
      if (prev.kind !== "ready") return { kind: "ready", value: [op] };
      const rest = prev.value.filter((existing) => existing.id !== op.id);
      return { kind: "ready", value: [op, ...rest] };
    });
    if (op.status === "succeeded" || op.status === "failed" || op.status === "manual_review") {
      setDomainAttempt((n) => n + 1);
    }
  }, []);

  const title = domain.kind === "ready" ? domain.value.displayName : t("domain.heading");

  return (
    <div className="mx-auto max-w-[1200px] space-y-8 px-4 py-16 lg:px-6">
      <Helmet>
        <title>{`${title} — ${t("meta.title")} — TNP`}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <Link to="/services" className="inline-block font-mono text-sm text-muted-foreground/70 transition-colors hover:text-muted-foreground">
        [← {t("domain.back")}]
      </Link>

      {availability.kind === "loading" && (
        <p aria-live="polite" className="font-mono text-sm text-muted-foreground/70">{t("status.checking")}</p>
      )}
      {availability.kind === "not_available" && <ServicesNotAvailable availability={availability} onRecheck={recheck} />}

      {enabled && (
        <div aria-live="polite" aria-busy={domain.kind === "loading"}>
          {domain.kind === "loading" && <p className="font-mono text-sm text-muted-foreground/70">{t("domain.loading")}</p>}
          {domain.kind === "error" &&
            (domain.notFound ? (
              <Card>
                <p className="font-mono text-sm text-muted-foreground">{t("domain.notFound")}</p>
              </Card>
            ) : (
              <ErrorPanel message={domain.message} onRetry={() => setDomainAttempt((n) => n + 1)} />
            ))}
        </div>
      )}

      {enabled && domain.kind === "ready" && availability.kind === "available" && (
        <>
          <header className="space-y-3">
            <h1 className="font-pixel text-xl text-primary-text">
              <DomainName name={domain.value.name} displayName={domain.value.displayName} />
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <NamespaceBadge namespace="public-dns" />
              <StatusBadge presentation={lifecyclePresentation(domain.value.lifecycle)} />
              {domain.value.provider.environment === "sandbox" && <SandboxBadge />}
            </div>
            <p className="font-mono text-xs text-muted-foreground/70">{t("namespace.notNative")}</p>
          </header>

          <Card>
            <dl className="grid grid-cols-1 gap-x-8 gap-y-3 font-mono text-sm sm:grid-cols-2">
              <Fact label={t("domain.expires")}>
                {domain.value.expiresAt ? formatDate(domain.value.expiresAt) : t("domain.expiresUnknown")}
              </Fact>
              <Fact label={t("domain.provider")}>
                {domain.value.provider.adapter} · {t(`provider.environment.${domain.value.provider.environment}`)}
              </Fact>
              <Fact label={t("domain.locked")}>
                {domain.value.locked === null ? t("domain.unknownValue") : domain.value.locked ? t("domain.yes") : t("domain.no")}
              </Fact>
              <Fact label={t("domain.renewal")}>{t(`domain.renewalOwner.${domain.value.renewalOwner}`)}</Fact>
              <Fact label={t("domain.lastSynced")}>
                {domain.value.lastSyncedAt ? formatRelativeTime(domain.value.lastSyncedAt) : t("domain.neverSynced")}
              </Fact>
              <Fact label={t("domain.lifecycleLabel")}>{t(`lifecycle.explain.${domain.value.lifecycle}`)}</Fact>
            </dl>
          </Card>

          <section aria-labelledby="services-zone-heading" className="space-y-4">
            <h2 id="services-zone-heading" className="font-pixel text-lg text-primary-text">
              {t("zone.heading")}
            </h2>
            {!domain.value.zone ? (
              <Card>
                <p className="font-mono text-sm text-muted-foreground">{t("zone.none")}</p>
              </Card>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 font-mono text-sm text-muted-foreground">
                  <span>{t(`zone.authority.${domain.value.zone.authority}`)}</span>
                  <StatusBadge presentation={zoneStatePresentation(domain.value.zone.state)} />
                  {domain.value.zone.lastVerifiedAt && (
                    <span className="text-xs text-muted-foreground/70">
                      {t("zone.lastVerified", { time: formatRelativeTime(domain.value.zone.lastVerifiedAt) })}
                    </span>
                  )}
                </div>
                {domain.value.zone.state === "conflict" && (
                  <p className="font-mono text-xs text-warning-text">{t("zone.conflictState")}</p>
                )}
                {domain.value.zone.authority === "external" ? (
                  <Card>
                    <p className="font-mono text-sm text-muted-foreground">{t("zone.external")}</p>
                  </Card>
                ) : availability.status.dnsWrite ? (
                  <ZoneEditor domainId={domain.value.id} onOperation={onOperation} />
                ) : (
                  <Card>
                    <p className="font-mono text-sm text-muted-foreground">{t("zone.editingDisabled")}</p>
                  </Card>
                )}
              </>
            )}
          </section>

          <section aria-labelledby="services-ops-heading" className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="services-ops-heading" className="font-pixel text-lg text-primary-text">
                {t("operations.heading")}
              </h2>
              <button
                type="button"
                onClick={() => setOpsAttempt((n) => n + 1)}
                className={LINK_BUTTON_CLASSES}
              >
                [{t("operations.refresh")}]
              </button>
            </div>
            <div aria-live="polite" aria-busy={operations.kind === "loading"}>
              {operations.kind === "loading" && (
                <p className="font-mono text-sm text-muted-foreground/70">{t("operations.loading")}</p>
              )}
              {operations.kind === "error" && (
                <ErrorPanel message={operations.message} onRetry={() => setOpsAttempt((n) => n + 1)} />
              )}
              {operations.kind === "ready" && <OperationLog operations={operations.value} />}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground/70">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}
