import { useState, useEffect } from "react";
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
      <h1 className="mb-2 text-[clamp(1.5rem,1.25rem+1vw,2rem)] font-semibold tracking-tight">
        All Domains
      </h1>
      <p className="mb-8 text-sm text-muted-foreground">{total} domains registered</p>

      <input
        type="text"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setPage(1); }}
        placeholder="Search domains..."
        className="mb-8 w-full rounded-[10px] border border-border bg-surface px-4 py-2.5 text-[15px] text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none transition-colors"
      />

      <div className="space-y-2">
        {domains.length === 0 ? (
          <p className="text-sm text-muted-foreground">No domains found</p>
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
            className="inline-flex h-8 cursor-pointer items-center justify-center rounded-[10px] border border-border px-3 text-sm text-foreground transition-colors hover:bg-surface disabled:opacity-50"
          >
            Previous
          </button>
          <span className="text-sm text-muted-foreground">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="inline-flex h-8 cursor-pointer items-center justify-center rounded-[10px] border border-border px-3 text-sm text-foreground transition-colors hover:bg-surface disabled:opacity-50"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
