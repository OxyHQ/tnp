import { useState, useEffect } from "react";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";

interface Proposal {
  _id: string;
  tld: string;
  reason: string;
  votes: number;
  status: "open" | "approved" | "rejected";
  createdAt: string;
}

export default function Propose() {
  const { isAuthenticated, login } = useAuth();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [tld, setTld] = useState("");
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    apiFetch<Proposal[]>("/tlds/proposals")
      .then((data) => {
        if (!ignore) setProposals(data);
      })
      .catch(() => {});
    return () => { ignore = true; };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      await apiFetch("/tlds/propose", {
        method: "POST",
        body: JSON.stringify({ tld, reason }),
      });
      setSuccess(`.${tld} proposed successfully!`);
      setTld("");
      setReason("");
      // Refresh proposals
      const updated = await apiFetch<Proposal[]>("/tlds/proposals");
      setProposals(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to propose TLD");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
        [ Propose ]
      </p>
      <h1 className="mb-2 text-3xl font-bold tracking-tight">
        Propose a TLD
      </h1>
      <p className="mb-8 text-muted">
        Think the world needs .dev, .music, or .pizza? Propose it and let the community vote.
      </p>

      {isAuthenticated ? (
        <form onSubmit={handleSubmit} className="mb-12 space-y-4">
          <div className="flex gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted">TLD</label>
              <div className="flex items-center rounded-xl border border-border bg-surface">
                <span className="pl-4 font-mono text-muted">.</span>
                <input
                  type="text"
                  value={tld}
                  onChange={(e) => setTld(e.target.value.toLowerCase())}
                  placeholder="music"
                  className="rounded-r-xl bg-transparent px-2 py-3 font-mono text-foreground placeholder:text-muted focus:outline-none"
                  required
                />
              </div>
            </div>
            <div className="flex-1 space-y-1">
              <label className="text-xs text-muted">Reason</label>
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why should this TLD exist?"
                className="w-full rounded-xl border border-border bg-surface px-4 py-3 text-foreground placeholder:text-muted focus:border-primary focus:outline-none"
                required
                maxLength={500}
              />
            </div>
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          {success && <p className="text-sm text-primary">{success}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="cursor-pointer rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? "Proposing..." : "Propose TLD"}
          </button>
        </form>
      ) : (
        <div className="mb-12 rounded-xl border border-border bg-surface p-6 text-center">
          <p className="mb-4 text-muted">Sign in to propose a new TLD.</p>
          <button
            onClick={() => login("demo-user")}
            className="cursor-pointer rounded-full bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Sign in with Oxy
          </button>
        </div>
      )}

      {/* Proposals list */}
      <h2 className="mb-4 text-lg font-semibold">Open Proposals</h2>
      {proposals.length === 0 ? (
        <p className="text-sm text-muted">No proposals yet. Be the first!</p>
      ) : (
        <div className="space-y-3">
          {proposals.map((p) => (
            <div
              key={p._id}
              className="flex items-center justify-between rounded-xl border border-border bg-surface p-4"
            >
              <div>
                <span className="font-mono text-primary">.{p.tld}</span>
                <p className="mt-1 text-sm text-muted">{p.reason}</p>
              </div>
              <div className="flex items-center gap-4 text-sm">
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    p.status === "open"
                      ? "bg-primary/10 text-primary"
                      : p.status === "approved"
                        ? "bg-green-500/10 text-green-500"
                        : "bg-red-500/10 text-red-500"
                  }`}
                >
                  {p.status}
                </span>
                <span className="text-muted">{p.votes} votes</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
