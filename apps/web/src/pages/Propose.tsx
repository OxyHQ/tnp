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
  const { isAuthenticated, signIn } = useAuth();
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
      const updated = await apiFetch<Proposal[]>("/tlds/proposals");
      setProposals(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to propose TLD");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-[640px] px-4 py-16">
      <h1 className="mb-2 font-pixel text-xl text-accent">
        Propose a TLD
      </h1>
      <p className="mb-8 font-mono text-sm text-muted">
        Think the world needs .dev, .music, or .pizza? Propose it and let the community vote.
      </p>

      {isAuthenticated ? (
        <form onSubmit={handleSubmit} className="mb-12 space-y-4">
          <div className="flex gap-2">
            <div className="flex items-center rounded-md border border-edge bg-surface-raised">
              <span className="pl-4 font-mono text-muted">.</span>
              <input
                type="text"
                value={tld}
                onChange={(e) => setTld(e.target.value.toLowerCase())}
                placeholder="music"
                className="rounded-r-md bg-transparent px-2 py-2.5 font-mono text-sm text-primary placeholder:text-muted focus:outline-none"
                required
              />
            </div>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why should this TLD exist?"
              className="flex-1 rounded-md border border-edge bg-surface-raised px-4 py-2.5 font-mono text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none transition-colors"
              required
              maxLength={500}
            />
          </div>
          {error && <p className="font-mono text-sm text-red-400">{error}</p>}
          {success && <p className="font-mono text-sm text-accent">{success}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="cursor-pointer rounded-md border border-accent/30 bg-accent/10 px-4 py-2.5 font-mono text-sm text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
          >
            {submitting ? "Proposing..." : "Propose TLD"}
          </button>
        </form>
      ) : (
        <div className="mb-12 rounded-lg border border-edge bg-surface-card p-6 text-center">
          <p className="mb-4 font-mono text-sm text-muted">Sign in to propose a new TLD.</p>
          <button
            onClick={() => signIn()}
            className="cursor-pointer rounded-md border border-accent/30 bg-accent/10 px-4 py-2.5 font-mono text-sm text-accent transition-colors hover:bg-accent/20"
          >
            [sign in with oxy]
          </button>
        </div>
      )}

      <h2 className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">Open Proposals</h2>
      {proposals.length === 0 ? (
        <p className="font-mono text-sm text-muted">No proposals yet. Be the first!</p>
      ) : (
        <div className="space-y-3">
          {proposals.map((p) => (
            <div
              key={p._id}
              className="flex items-center justify-between rounded-lg border border-edge bg-surface-card p-4"
            >
              <div>
                <span className="font-mono text-accent">.{p.tld}</span>
                <p className="mt-1 font-mono text-xs text-muted">{p.reason}</p>
              </div>
              <div className="flex items-center gap-3 font-mono text-xs">
                <span
                  className={`rounded-md px-2.5 py-0.5 font-medium ${
                    p.status === "open"
                      ? "bg-accent/10 text-accent"
                      : p.status === "approved"
                        ? "bg-green-500/10 text-green-400"
                        : "bg-red-500/10 text-red-400"
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
