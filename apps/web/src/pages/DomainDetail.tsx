import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { Link, useParams } from "react-router-dom";
import { apiFetch } from "../lib/api";
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function DomainDetail() {
  const { domain: domainParam } = useParams<{ domain: string }>();
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
        if (!ignore) setError(err instanceof Error ? err.message : "Failed to load domain");
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => { ignore = true; };
  }, [domainParam]);

  if (loading) {
    return (
      <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
        <p className="font-mono text-sm text-muted">Loading...</p>
      </div>
    );
  }

  if (error || !domain) {
    return (
      <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
        <nav className="mb-6 font-mono text-xs text-muted">
          <Link to="/" className="transition-colors hover:text-secondary">Home</Link>
          <span className="mx-1.5">/</span>
          <Link to="/explore" className="transition-colors hover:text-secondary">Explore</Link>
          <span className="mx-1.5">/</span>
          <span className="text-primary">{domainParam}</span>
        </nav>
        <h1 className="mb-2 font-pixel text-xl text-accent">Domain not found</h1>
        <p className="mb-6 font-mono text-sm text-muted">
          {domainParam} is not registered on TNP or may have been released.
        </p>
        <Link to="/register" className="font-mono text-sm text-accent transition-colors hover:text-accent/80">
          [register this domain]
        </Link>
      </div>
    );
  }

  const specs = [
    { label: "Status", value: domain.status },
    { label: "TLD", value: `.${domain.tld}` },
    { label: "Records", value: `${domain.records.length}` },
    { label: "Registered", value: formatDate(domain.createdAt) },
    { label: "Expires", value: domain.expiresAt ? formatDate(domain.expiresAt) : "—" },
    { label: "Last Updated", value: formatDate(domain.updatedAt) },
  ];

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>{domainParam ?? "Domain"} — TNP</title>
        <meta name="description" content={`DNS records, status, and details for ${domainParam ?? "domain"} on The Network Protocol.`} />
        <link rel="canonical" href={`https://tnp.network/d/${domainParam}`} />
        <meta property="og:title" content={`${domainParam ?? "Domain"} — TNP`} />
        <meta property="og:description" content={`Details for ${domainParam ?? "domain"} on The Network Protocol.`} />
        <meta property="og:url" content={`https://tnp.network/d/${domainParam}`} />
      </Helmet>
      {/* Breadcrumb */}
      <nav className="mb-6 font-mono text-xs text-muted">
        <Link to="/" className="transition-colors hover:text-secondary">Home</Link>
        <span className="mx-1.5">/</span>
        <Link to="/explore" className="transition-colors hover:text-secondary">Explore</Link>
        <span className="mx-1.5">/</span>
        <span className="text-primary">{domain.name}.{domain.tld}</span>
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
          Registered on The Network Protocol
        </p>
      </div>

      {/* Specs grid */}
      <div className="mb-10">
        <h2 className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">Details</h2>
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
        <h2 className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">DNS Records</h2>
        {domain.records.length === 0 ? (
          <div className="rounded-lg border border-edge bg-surface-card p-6 text-center">
            <p className="font-mono text-sm text-muted">No DNS records configured</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-edge bg-surface-card">
            <table className="w-full font-mono text-sm">
              <thead>
                <tr className="border-b border-edge text-left text-xs text-muted">
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Value</th>
                  <th className="px-4 py-3">TTL</th>
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
        <h2 className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">How to resolve</h2>
        <div className="rounded-lg border border-edge bg-surface-card p-5 space-y-3">
          <p className="font-mono text-sm text-secondary">
            To resolve <span className="text-accent">{domain.name}.{domain.tld}</span> on your device,
            install the TNP resolver. It configures your system DNS to query TNP nameservers for
            TNP domains while forwarding everything else to your default resolver.
          </p>
          <Link
            to="/install"
            className="inline-block font-mono text-sm text-accent transition-colors hover:text-accent/80"
          >
            [install tnp resolver]
          </Link>
        </div>
      </div>
    </div>
  );
}
