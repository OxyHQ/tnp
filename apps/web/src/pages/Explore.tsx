import { useState, useEffect } from "react";
import { apiFetch } from "../lib/api";
import TLDBadge from "../components/TLDBadge";
import DomainCard from "../components/DomainCard";

interface TLD {
  _id: string;
  name: string;
  status: "active" | "proposed" | "pending";
}

interface Domain {
  _id: string;
  name: string;
  tld: string;
  status: string;
  oxyUserId: string;
}

export default function Explore() {
  const [tlds, setTlds] = useState<TLD[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<Domain[] | null>(null);

  useEffect(() => {
    let ignore = false;
    apiFetch<TLD[]>("/tlds").then((data) => {
      if (!ignore) setTlds(data);
    }).catch(() => {});
    apiFetch<{ domains: Domain[] }>("/domains?limit=20").then((data) => {
      if (!ignore) setDomains(data.domains);
    }).catch(() => {});
    return () => { ignore = true; };
  }, []);

  useEffect(() => {
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    let ignore = false;
    const timer = setTimeout(() => {
      apiFetch<Domain[]>(`/domains/search?q=${encodeURIComponent(query)}`)
        .then((data) => {
          if (!ignore) setSearchResults(data);
        })
        .catch(() => {});
    }, 300);
    return () => { ignore = true; clearTimeout(timer); };
  }, [query]);

  const displayDomains = searchResults ?? domains;

  return (
    <div className="mx-auto max-w-7xl px-4 py-16 lg:px-6">
      <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
        [ Explore ]
      </p>
      <h1 className="mb-8 text-3xl font-bold tracking-tight">
        Browse TLDs and domains
      </h1>

      {/* Active TLDs */}
      <div className="mb-12">
        <h2 className="mb-4 text-lg font-semibold">Active TLDs</h2>
        <div className="flex flex-wrap gap-3">
          {tlds.map((tld) => (
            <TLDBadge key={tld._id} name={tld.name} status={tld.status} />
          ))}
        </div>
      </div>

      {/* Search */}
      <div className="mb-8">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search domains..."
          className="w-full rounded-xl border border-border bg-surface px-5 py-3 text-foreground placeholder:text-muted focus:border-primary focus:outline-none"
        />
      </div>

      {/* Domains */}
      <div className="space-y-3">
        {displayDomains.length === 0 ? (
          <p className="text-sm text-muted">
            {searchResults !== null ? "No domains found" : "No domains registered yet"}
          </p>
        ) : (
          displayDomains.map((d) => (
            <DomainCard
              key={d._id}
              name={d.name}
              tld={d.tld}
              status={d.status}
              oxyUserId={d.oxyUserId}
            />
          ))
        )}
      </div>
    </div>
  );
}
