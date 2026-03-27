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
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <h1 className="mb-8 text-[clamp(1.5rem,1.25rem+1vw,2rem)] font-semibold tracking-tight">
        Explore
      </h1>

      <div className="mb-12">
        <h2 className="mb-4 text-[15px] font-medium">Active TLDs</h2>
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
          className="w-full rounded-[10px] border border-border bg-surface px-4 py-2.5 text-[15px] text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none transition-colors"
        />
      </div>

      <div className="space-y-2">
        {displayDomains.length === 0 ? (
          <p className="text-sm text-muted-foreground">
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
