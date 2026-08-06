import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { Link, Navigate, useParams } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { apiFetch } from "../lib/api";
import { useLocaleFormatter } from "../lib/useLocaleFormatter";
import TLDBadge from "../components/TLDBadge";

interface DnsRecord {
  _id: string;
  type: string;
  name: string;
  value: string;
  ttl: number;
}

interface DomainData {
  _id: string;
  name: string;
  tld: string;
  oxyUserId: string;
  status: string;
  records: DnsRecord[];
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
}

export default function DomainDetail() {
  const { domain: domainParam } = useParams<{ domain: string }>();
  const { t } = useTranslation(["domainDetail", "common"]);
  const { formatDate } = useLocaleFormatter();
  const [domain, setDomain] = useState<DomainData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!domainParam) return;
    let ignore = false;
    setLoading(true);
    setError(null);
    apiFetch<DomainData>(`/domains/lookup/${domainParam}`)
      .then((data) => {
        if (!ignore) setDomain(data);
      })
      .catch((err) => {
        if (!ignore) setError(err instanceof Error ? err.message : t("common:errors.loadFailed"));
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
  }, [domainParam, t]);

  if (loading) {
    return (
      <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
        <p className="font-mono text-sm text-muted-foreground/70">{t("common:loading")}</p>
      </div>
    );
  }

  if (domain && domain.records.length === 0) {
    return <Navigate to={`/park/${domain.name}.${domain.tld}`} replace />;
  }

  if (error || !domain) {
    return <Navigate to={`/park/${domainParam}`} replace />;
  }

  const fullDomain = `${domain.name}.${domain.tld}`;

  const specs = [
    { label: t("domainDetail:specs.status"), value: domain.status },
    { label: t("domainDetail:specs.tld"), value: `.${domain.tld}` },
    { label: t("domainDetail:specs.records"), value: `${domain.records.length}` },
    { label: t("domainDetail:specs.registered"), value: formatDate(domain.createdAt) },
    { label: t("domainDetail:specs.expires"), value: domain.expiresAt ? formatDate(domain.expiresAt) : t("domainDetail:neverExpires") },
    { label: t("domainDetail:specs.lastUpdated"), value: formatDate(domain.updatedAt) },
  ];

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>{t("domainDetail:meta.title", { domain: domainParam ?? "Domain" })}</title>
        <meta name="description" content={t("domainDetail:meta.description", { domain: domainParam ?? "domain" })} />
        <link rel="canonical" href={`https://tnp.network/d/${domainParam}`} />
        <meta property="og:title" content={t("domainDetail:meta.ogTitle", { domain: domainParam ?? "Domain" })} />
        <meta property="og:description" content={t("domainDetail:meta.ogDescription", { domain: domainParam ?? "domain" })} />
        <meta property="og:url" content={`https://tnp.network/d/${domainParam}`} />
      </Helmet>
      {/* Breadcrumb */}
      <nav className="mb-6 font-mono text-xs text-muted-foreground/70">
        <Link to="/" className="transition-colors hover:text-muted-foreground">{t("domainDetail:breadcrumb.home")}</Link>
        <span className="mx-1.5">/</span>
        <Link to="/explore" className="transition-colors hover:text-muted-foreground">{t("domainDetail:breadcrumb.explore")}</Link>
        <span className="mx-1.5">/</span>
        <span className="text-foreground">{fullDomain}</span>
      </nav>

      {/* Header */}
      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h1 className="font-pixel text-xl text-primary-text">
            {domain.name}<span className="text-foreground">.{domain.tld}</span>
          </h1>
          <span
            className={`rounded-md px-2.5 py-0.5 font-mono text-xs font-medium ${
              domain.status === "active"
                ? "bg-primary/10 text-primary-text"
                : domain.status === "pending"
                  ? "bg-warning-subtle text-warning-text"
                  : "bg-error-subtle text-error-text"
            }`}
          >
            {domain.status}
          </span>
          <TLDBadge name={domain.tld} status="active" />
        </div>
        <p className="font-mono text-sm text-muted-foreground/70">
          {t("domainDetail:registeredOnTnp")}
        </p>
      </div>

      {/* Specs grid */}
      <div className="mb-10">
        <h2 className="mb-4 font-mono text-xs uppercase tracking-wider text-muted-foreground/70">{t("domainDetail:sections.details")}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {specs.map((spec) => (
            <div key={spec.label} className="rounded-lg border border-border bg-card p-3">
              <p className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">{spec.label}</p>
              <p className="mt-1 font-mono text-sm font-medium text-foreground">{spec.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* DNS Records */}
      <div className="mb-10">
        <h2 className="mb-4 font-mono text-xs uppercase tracking-wider text-muted-foreground/70">{t("domainDetail:sections.dnsRecords")}</h2>
        {domain.records.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-6 text-center">
            <p className="font-mono text-sm text-muted-foreground/70">{t("domainDetail:noDnsRecords")}</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full font-mono text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground/70">
                  <th className="px-4 py-3">{t("common:form.type")}</th>
                  <th className="px-4 py-3">{t("common:form.name")}</th>
                  <th className="px-4 py-3">{t("common:form.value")}</th>
                  <th className="px-4 py-3">{t("common:form.ttl")}</th>
                </tr>
              </thead>
              <tbody>
                {domain.records.map((record) => (
                  <tr key={record._id} className="border-t border-muted">
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">{record.type}</td>
                    <td className="px-4 py-2.5 text-foreground">{record.name}</td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground/70">{record.value}</td>
                    <td className="px-4 py-2.5 text-muted-foreground/70">{record.ttl}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* How to resolve */}
      <div>
        <h2 className="mb-4 font-mono text-xs uppercase tracking-wider text-muted-foreground/70">{t("domainDetail:sections.howToResolve")}</h2>
        <div className="rounded-lg border border-border bg-card p-5 space-y-3">
          <p className="font-mono text-sm text-muted-foreground">
            <Trans
              i18nKey="domainDetail:howToResolveDesc"
              t={t}
              values={{ domain: fullDomain }}
              components={{ accent: <span className="text-primary-text" /> }}
            />
          </p>
          <Link
            to="/install"
            className="inline-block font-mono text-sm text-primary-text transition-colors hover:text-primary-text/80"
          >
            [{t("domainDetail:installResolver")}]
          </Link>
        </div>
      </div>
    </div>
  );
}
