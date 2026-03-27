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
      <h1 className="mb-8 font-pixel text-xl text-accent">
        Your Domains
      </h1>

      {domains.length === 0 ? (
        <p className="font-mono text-sm text-muted">
          You have not registered any domains yet.
        </p>
      ) : (
        <div className="space-y-3">
          {domains.map((domain) => (
            <div key={domain._id} className="rounded-lg border border-edge bg-surface-card">
              <button
                onClick={() => setExpanded(expanded === domain._id ? null : domain._id)}
                className="flex w-full cursor-pointer items-center justify-between p-4 text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm">
                    {domain.name}
                    <span className="text-accent">.{domain.tld}</span>
                  </span>
                  <span
                    className={`rounded-md px-2.5 py-0.5 font-mono text-xs font-medium ${
                      domain.status === "active"
                        ? "bg-accent/10 text-accent"
                        : "bg-surface-hover text-muted"
                    }`}
                  >
                    {domain.status}
                  </span>
                </div>
                <span className="font-mono text-xs text-muted">
                  {domain.records.length} record{domain.records.length !== 1 ? "s" : ""}
                </span>
              </button>

              {expanded === domain._id && (
                <div className="border-t border-edge p-4 space-y-6">
                  {domain.records.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full font-mono text-sm">
                        <thead>
                          <tr className="text-left text-xs text-muted">
                            <th className="pb-2 pr-4">Type</th>
                            <th className="pb-2 pr-4">Name</th>
                            <th className="pb-2 pr-4">Value</th>
                            <th className="pb-2 pr-4">TTL</th>
                            <th className="pb-2" />
                          </tr>
                        </thead>
                        <tbody>
                          {domain.records.map((record) => (
                            <tr key={record._id} className="border-t border-edge-subtle">
                              <td className="py-2 pr-4 text-xs text-secondary">{record.type}</td>
                              <td className="py-2 pr-4 text-primary">{record.name}</td>
                              <td className="py-2 pr-4 text-xs text-muted">{record.value}</td>
                              <td className="py-2 pr-4 text-muted">{record.ttl}</td>
                              <td className="py-2">
                                <button
                                  onClick={() => deleteRecord(domain._id, record._id)}
                                  className="cursor-pointer text-xs text-red-400 transition-colors hover:text-red-300"
                                >
                                  [delete]
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div>
                    <h4 className="mb-3 font-mono text-xs uppercase tracking-wider text-muted">Add Record</h4>
                    <RecordEditor onSubmit={(record) => addRecord(domain._id, record)} />
                  </div>

                  <div className="flex justify-end">
                    <button
                      onClick={() => releaseDomain(domain._id)}
                      className="cursor-pointer font-mono text-xs text-red-400 transition-colors hover:text-red-300"
                    >
                      [release domain]
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
