import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { apiFetch } from "../lib/api";
import DomainCard from "../components/DomainCard";

interface Domain {
  _id: string;
  name: string;
  tld: string;
  status: string;
  oxyUserId: string;
}

interface DomainsResponse {
  domains: Domain[];
  total: number;
  page: number;
  pages: number;
}

export default function Domains() {
  const [domains, setDomains] = useState<Domain[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let ignore = false;
    if (query.trim()) {
      apiFetch<Domain[]>(`/domains/search?q=${encodeURIComponent(query)}`)
        .then((data) => {
          if (!ignore) {
            setDomains(data);
            setTotalPages(1);
            setTotal(data.length);
          }
        })
        .catch(() => {});
    } else {
      apiFetch<DomainsResponse>(`/domains?page=${page}&limit=50`)
        .then((data) => {
          if (!ignore) {
            setDomains(data.domains);
            setTotalPages(data.pages);
            setTotal(data.total);
          }
        })
        .catch(() => {});
    }
    return () => { ignore = true; };
  }, [query, page]);

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>All Domains — TNP</title>
        <meta name="description" content="View all registered domains on The Network Protocol. Search and browse the complete TNP domain directory." />
        <link rel="canonical" href="https://tnp.network/domains" />
        <meta property="og:title" content="All Domains — TNP" />
        <meta property="og:description" content="View all registered domains on The Network Protocol." />
        <meta property="og:url" content="https://tnp.network/domains" />
      </Helmet>
      <h1 className="mb-2 font-pixel text-xl text-accent">
        All Domains
      </h1>
      <p className="mb-8 font-mono text-sm text-muted">{total} domains registered</p>

      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setPage(1); }}
        placeholder="Search domains..."
        className="mb-8 w-full rounded-md border border-edge bg-surface-raised px-4 py-2.5 font-mono text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none transition-colors"
      />

      <div className="space-y-2">
        {domains.length === 0 ? (
          <p className="font-mono text-sm text-muted">No domains found</p>
        ) : (
          domains.map((d) => (
            <DomainCard key={d._id} name={d.name} tld={d.tld} status={d.status} oxyUserId={d.oxyUserId} />
          ))
        )}
      </div>

      {!query && totalPages > 1 && (
        <div className="mt-8 flex items-center justify-center gap-3">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            className="cursor-pointer font-mono text-sm text-secondary transition-colors hover:text-primary disabled:opacity-50"
          >
            [prev]
          </button>
          <span className="font-mono text-sm text-muted">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="cursor-pointer font-mono text-sm text-secondary transition-colors hover:text-primary disabled:opacity-50"
          >
            [next]
          </button>
        </div>
      )}
    </div>
  );
}
