import { useState, useEffect, useCallback } from "react";
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
  const [domains, setDomains] = useState<Domain[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const fetchDomains = useCallback(() => {
    apiFetch<Domain[]>("/domains/mine")
      .then(setDomains)
      .catch(() => {});
  }, []);

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
    });
    fetchDomains();
  };

  const deleteRecord = async (domainId: string, recordId: string) => {
    await apiFetch(`/domains/${domainId}/records/${recordId}`, {
      method: "DELETE",
    });
    fetchDomains();
  };

  const releaseDomain = async (domainId: string) => {
    if (!confirm("Are you sure you want to release this domain?")) return;
    await apiFetch(`/domains/${domainId}`, { method: "DELETE" });
    fetchDomains();
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-16 lg:px-6">
      <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
        [ Dashboard ]
      </p>
      <h1 className="mb-8 text-3xl font-bold tracking-tight">Your Domains</h1>

      {domains.length === 0 ? (
        <p className="text-muted">
          You have not registered any domains yet.
        </p>
      ) : (
        <div className="space-y-4">
          {domains.map((domain) => (
            <div
              key={domain._id}
              className="rounded-xl border border-border bg-surface"
            >
              <button
                onClick={() =>
                  setExpanded(expanded === domain._id ? null : domain._id)
                }
                className="flex w-full cursor-pointer items-center justify-between p-5 text-left"
              >
                <div>
                  <span className="font-mono text-lg">
                    {domain.name}
                    <span className="text-primary">.{domain.tld}</span>
                  </span>
                  <span
                    className={`ml-3 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      domain.status === "active"
                        ? "bg-primary/10 text-primary"
                        : "bg-muted/10 text-muted"
                    }`}
                  >
                    {domain.status}
                  </span>
                </div>
                <span className="text-sm text-muted">
                  {domain.records.length} records
                </span>
              </button>

              {expanded === domain._id && (
                <div className="border-t border-border p-5 space-y-6">
                  {/* Records table */}
                  {domain.records.length > 0 && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-xs text-muted">
                            <th className="pb-2 pr-4">Type</th>
                            <th className="pb-2 pr-4">Name</th>
                            <th className="pb-2 pr-4">Value</th>
                            <th className="pb-2 pr-4">TTL</th>
                            <th className="pb-2"></th>
                          </tr>
                        </thead>
                        <tbody>
                          {domain.records.map((record) => (
                            <tr key={record._id} className="border-t border-border/50">
                              <td className="py-2 pr-4 font-mono text-xs">
                                {record.type}
                              </td>
                              <td className="py-2 pr-4">{record.name}</td>
                              <td className="py-2 pr-4 font-mono text-xs text-muted">
                                {record.value}
                              </td>
                              <td className="py-2 pr-4 text-muted">
                                {record.ttl}
                              </td>
                              <td className="py-2">
                                <button
                                  onClick={() =>
                                    deleteRecord(domain._id, record._id)
                                  }
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

                  {/* Add record */}
                  <div>
                    <h4 className="mb-3 text-sm font-semibold">Add Record</h4>
                    <RecordEditor
                      onSubmit={(record) => addRecord(domain._id, record)}
                    />
                  </div>

                  {/* Release domain */}
                  <div className="flex justify-end">
                    <button
                      onClick={() => releaseDomain(domain._id)}
                      className="cursor-pointer rounded-full border border-red-400/30 px-4 py-2 text-xs text-red-400 transition-colors hover:bg-red-400/10"
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
