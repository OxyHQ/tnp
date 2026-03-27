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
  const { user, isAuthenticated, signIn } = useAuth();
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
        oxyUserId: user?._id as string,
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
      <h1 className="mb-2 text-[clamp(1.5rem,1.25rem+1vw,2rem)] font-semibold tracking-tight">
        Propose a TLD
      </h1>
      <p className="mb-8 text-[15px] text-muted-foreground">
        Think the world needs .dev, .music, or .pizza? Propose it and let the community vote.
      </p>

      {isAuthenticated ? (
        <form onSubmit={handleSubmit} className="mb-12 space-y-4">
          <div className="flex gap-2">
            <div className="flex items-center rounded-[10px] border border-border bg-surface">
              <span className="pl-4 font-mono text-muted-foreground">.</span>
              <input
                type="text"
                value={tld}
                onChange={(e) => setTld(e.target.value.toLowerCase())}
                placeholder="music"
                className="rounded-r-[10px] bg-transparent px-2 py-2.5 font-mono text-[15px] text-foreground placeholder:text-muted-foreground focus:outline-none"
                required
              />
            </div>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why should this TLD exist?"
              className="flex-1 rounded-[10px] border border-border bg-surface px-4 py-2.5 text-[15px] text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none transition-colors"
              required
              maxLength={500}
            />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          {success && <p className="text-sm text-primary">{success}</p>}
          <button
            type="submit"
            disabled={submitting}
            className="cursor-pointer rounded-[10px] border border-primary bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting ? "Proposing..." : "Propose TLD"}
          </button>
        </form>
      ) : (
        <div className="mb-12 rounded-xl border border-border bg-surface p-6 text-center">
          <p className="mb-4 text-[15px] text-muted-foreground">Sign in to propose a new TLD.</p>
          <button
            onClick={() => signIn()}
            className="cursor-pointer rounded-[10px] border border-primary bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Sign in with Oxy
          </button>
        </div>
      )}

      <h2 className="mb-4 text-lg font-semibold">Open Proposals</h2>
      {proposals.length === 0 ? (
        <p className="text-sm text-muted-foreground">No proposals yet. Be the first!</p>
      ) : (
        <div className="space-y-3">
          {proposals.map((p) => (
            <div
              key={p._id}
              className="flex items-center justify-between rounded-xl border border-border bg-surface p-4"
            >
              <div>
                <span className="font-mono text-primary">.{p.tld}</span>
                <p className="mt-1 text-sm text-muted-foreground">{p.reason}</p>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <span
                  className={`rounded-[10px] px-2.5 py-0.5 text-xs font-medium ${
                    p.status === "open"
                      ? "bg-primary/10 text-primary"
                      : p.status === "approved"
                        ? "bg-green-500/10 text-green-400"
                        : "bg-red-500/10 text-red-400"
                  }`}
                >
                  {p.status}
                </span>
                <span className="text-muted-foreground">{p.votes} votes</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
