import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
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
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>Explore Domains — TNP</title>
        <meta name="description" content="Browse available TLDs and recently registered domains on The Network Protocol. Search the TNP namespace." />
        <link rel="canonical" href="https://tnp.network/explore" />
        <meta property="og:title" content="Explore Domains — TNP" />
        <meta property="og:description" content="Browse available TLDs and recently registered domains on The Network Protocol." />
        <meta property="og:url" content="https://tnp.network/explore" />
      </Helmet>
      <h1 className="mb-2 font-pixel text-xl text-accent">
        Explore
      </h1>
      <p className="mb-8 font-mono text-sm text-muted">
        Browse TLDs and recently registered domains.
      </p>

      <div className="mb-12">
        <h2 className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">Active TLDs</h2>
        <div className="flex flex-wrap gap-2">
          {tlds.map((tld) => (
            <TLDBadge key={tld._id} name={tld.name} status={tld.status} />
          ))}
        </div>
      </div>

      <div className="mb-8">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search domains..."
          className="w-full rounded-md border border-edge bg-surface-raised px-4 py-2.5 font-mono text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none transition-colors"
        />
      </div>

      <div className="space-y-2">
        {displayDomains.length === 0 ? (
          <p className="font-mono text-sm text-muted">
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
