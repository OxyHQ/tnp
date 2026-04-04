import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { Link, useParams } from "react-router-dom";
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
        <p className="font-mono text-sm text-muted">{t("common:loading")}</p>
      </div>
    );
  }

  if (error || !domain) {
    return (
      <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
        <nav className="mb-6 font-mono text-xs text-muted">
          <Link to="/" className="transition-colors hover:text-secondary">{t("domainDetail:breadcrumb.home")}</Link>
          <span className="mx-1.5">/</span>
          <Link to="/explore" className="transition-colors hover:text-secondary">{t("domainDetail:breadcrumb.explore")}</Link>
          <span className="mx-1.5">/</span>
          <span className="text-primary">{domainParam}</span>
        </nav>
        <h1 className="mb-2 font-pixel text-xl text-accent">{t("domainDetail:notFound.title")}</h1>
        <p className="mb-6 font-mono text-sm text-muted">
          {t("domainDetail:notFound.description", { domain: domainParam })}
        </p>
        <Link to="/register" className="font-mono text-sm text-accent transition-colors hover:text-accent/80">
          [{t("domainDetail:notFound.registerLink")}]
        </Link>
      </div>
    );
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
      <nav className="mb-6 font-mono text-xs text-muted">
        <Link to="/" className="transition-colors hover:text-secondary">{t("domainDetail:breadcrumb.home")}</Link>
        <span className="mx-1.5">/</span>
        <Link to="/explore" className="transition-colors hover:text-secondary">{t("domainDetail:breadcrumb.explore")}</Link>
        <span className="mx-1.5">/</span>
        <span className="text-primary">{fullDomain}</span>
      </nav>

      {/* Header */}
      <div className="mb-8">
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <h1 className="font-pixel text-xl text-accent">
            {domain.name}<span className="text-primary">.{domain.tld}</span>
          </h1>
          <span
            className={`rounded-md px-2.5 py-0.5 font-mono text-xs font-medium ${
              domain.status === "active"
                ? "bg-accent/10 text-accent"
                : domain.status === "pending"
                  ? "bg-amber-400/10 text-amber-400"
                  : "bg-red-400/10 text-red-400"
            }`}
          >
            {domain.status}
          </span>
          <TLDBadge name={domain.tld} status="active" />
        </div>
        <p className="font-mono text-sm text-muted">
          {t("domainDetail:registeredOnTnp")}
        </p>
      </div>

      {/* Specs grid */}
      <div className="mb-10">
        <h2 className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">{t("domainDetail:sections.details")}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {specs.map((spec) => (
            <div key={spec.label} className="rounded-lg border border-edge bg-surface-card p-3">
              <p className="font-mono text-[11px] uppercase tracking-wider text-muted">{spec.label}</p>
              <p className="mt-1 font-mono text-sm font-medium text-primary">{spec.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* DNS Records */}
      <div className="mb-10">
        <h2 className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">{t("domainDetail:sections.dnsRecords")}</h2>
        {domain.records.length === 0 ? (
          <div className="rounded-lg border border-edge bg-surface-card p-6 text-center">
            <p className="font-mono text-sm text-muted">{t("domainDetail:noDnsRecords")}</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-edge bg-surface-card">
            <table className="w-full font-mono text-sm">
              <thead>
                <tr className="border-b border-edge text-left text-xs text-muted">
                  <th className="px-4 py-3">{t("common:form.type")}</th>
                  <th className="px-4 py-3">{t("common:form.name")}</th>
                  <th className="px-4 py-3">{t("common:form.value")}</th>
                  <th className="px-4 py-3">{t("common:form.ttl")}</th>
                </tr>
              </thead>
              <tbody>
                {domain.records.map((record) => (
                  <tr key={record._id} className="border-t border-edge-subtle">
                    <td className="px-4 py-2.5 text-xs text-secondary">{record.type}</td>
                    <td className="px-4 py-2.5 text-primary">{record.name}</td>
                    <td className="px-4 py-2.5 text-xs text-muted">{record.value}</td>
                    <td className="px-4 py-2.5 text-muted">{record.ttl}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* How to resolve */}
      <div>
        <h2 className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">{t("domainDetail:sections.howToResolve")}</h2>
        <div className="rounded-lg border border-edge bg-surface-card p-5 space-y-3">
          <p className="font-mono text-sm text-secondary">
            <Trans
              i18nKey="domainDetail:howToResolveDesc"
              t={t}
              values={{ domain: fullDomain }}
              components={{ accent: <span className="text-accent" /> }}
            />
          </p>
          <Link
            to="/install"
            className="inline-block font-mono text-sm text-accent transition-colors hover:text-accent/80"
          >
            [{t("domainDetail:installResolver")}]
          </Link>
        </div>
      </div>
    </div>
  );
}
