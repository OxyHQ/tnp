import { useState, useEffect, useCallback } from "react";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";
import RecordEditor from "../components/RecordEditor";

interface Record {
  _id: string;
  type: string;
  name: string;
  value: string;
  ttl: number;
}

interface Domain {
  _id: string;
  name: string;
  tld: string;
  status: string;
  records: Record[];
  createdAt: string;
  expiresAt: string;
}

export default function Dashboard() {
  const { user } = useAuth();
  const [domains, setDomains] = useState<Domain[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchDomains = useCallback(() => {
    apiFetch<Domain[]>("/domains/mine", { oxyUserId: user?._id as string }).then(setDomains).catch(() => {});
  }, [user?._id as string]);

  useEffect(() => {
    fetchDomains();
  }, [fetchDomains]);

  const addRecord = async (
    domainId: string,
    record: { type: string; name: string; value: string; ttl: number }
  ) => {
    await apiFetch(`/domains/${domainId}/records`, {
      method: "POST",
      body: JSON.stringify(record),
      oxyUserId: user?._id as string,
    });
    fetchDomains();
  };

  const deleteRecord = async (domainId: string, recordId: string) => {
    await apiFetch(`/domains/${domainId}/records/${recordId}`, {
      method: "DELETE",
      oxyUserId: user?._id as string,
    });
    fetchDomains();
  };

  const releaseDomain = async (domainId: string) => {
    if (!confirm("Are you sure you want to release this domain?")) return;
    await apiFetch(`/domains/${domainId}`, { method: "DELETE", oxyUserId: user?._id as string });
    fetchDomains();
  };

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <h1 className="mb-8 text-[clamp(1.5rem,1.25rem+1vw,2rem)] font-semibold tracking-tight">
        Your Domains
      </h1>

      {domains.length === 0 ? (
        <p className="text-[15px] text-muted-foreground">
          You have not registered any domains yet.
        </p>
      ) : (
        <div className="space-y-3">
          {domains.map((domain) => (
            <div key={domain._id} className="rounded-xl border border-border bg-surface">
              <button
                onClick={() => setExpanded(expanded === domain._id ? null : domain._id)}
                className="flex w-full cursor-pointer items-center justify-between p-4 text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[15px]">
                    {domain.name}
                    <span className="text-primary">.{domain.tld}</span>
                  </span>
                  <span
                    className={`rounded-[10px] px-2.5 py-0.5 text-xs font-medium ${
                      domain.status === "active"
                        ? "bg-primary/10 text-primary"
                        : "bg-muted/20 text-muted-foreground"
                    }`}
                  >
                    {domain.status}
                  </span>
                </div>
                <span className="text-sm text-muted-foreground">
                  {domain.records.length} record{domain.records.length !== 1 ? "s" : ""}
                </span>
              </button>

              {expanded === domain._id && (
                <div className="border-t border-border p-4 space-y-6">
                  {domain.records.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-muted-foreground">
                            <th className="pb-2 pr-4">Type</th>
                            <th className="pb-2 pr-4">Name</th>
                            <th className="pb-2 pr-4">Value</th>
                            <th className="pb-2 pr-4">TTL</th>
                            <th className="pb-2" />
                          </tr>
                        </thead>
                        <tbody>
                          {domain.records.map((record) => (
                            <tr key={record._id} className="border-t border-border/50">
                              <td className="py-2 pr-4 font-mono text-xs">{record.type}</td>
                              <td className="py-2 pr-4">{record.name}</td>
                              <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{record.value}</td>
                              <td className="py-2 pr-4 text-muted-foreground">{record.ttl}</td>
                              <td className="py-2">
                                <button
                                  onClick={() => deleteRecord(domain._id, record._id)}
                                  className="cursor-pointer text-xs text-red-400 transition-colors hover:text-red-300"
                                >
                                  Delete
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div>
                    <h4 className="mb-3 text-sm font-medium">Add Record</h4>
                    <RecordEditor onSubmit={(record) => addRecord(domain._id, record)} />
                  </div>

                  <div className="flex justify-end">
                    <button
                      onClick={() => releaseDomain(domain._id)}
                      className="cursor-pointer rounded-[10px] border border-red-400/30 px-3 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-400/10"
                    >
                      Release Domain
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
