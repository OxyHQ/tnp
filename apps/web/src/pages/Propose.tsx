import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { apiFetch } from "../lib/api";

interface Proposal {
  _id: string;
  tld: string;
  reason: string;
  score: number;
  userVote: "up" | "down" | null;
  status: "open" | "approved" | "rejected";
  proposedBy: { _id: string; oxyUserId: string };
  createdAt: string;
}

const STATUS_KEYS = {
  open: "statusOpen",
  approved: "statusApproved",
  rejected: "statusRejected",
} as const;

export default function Propose() {
  const { t } = useTranslation(["propose", "common"]);
  const { isAuthenticated, signIn, user } = useAuth();
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
      setSuccess(t("propose:proposeSuccess", { tld }));
      setTld("");
      setReason("");
      const updated = await apiFetch<Proposal[]>("/tlds/proposals");
      setProposals(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("propose:proposeFailed"));
    } finally {
      setSubmitting(false);
    }
  };

  const handleVote = async (proposalId: string, direction: "up" | "down") => {
    const proposal = proposals.find((p) => p._id === proposalId);
    if (!proposal) return;

    const isToggle = proposal.userVote === direction;

    // Optimistic update
    setProposals((prev) =>
      prev.map((p) => {
        if (p._id !== proposalId) return p;
        const currentScore = p.score ?? 0;
        if (isToggle) {
          return {
            ...p,
            score: currentScore + (direction === "up" ? -1 : 1),
            userVote: null,
          };
        }
        const scoreDelta =
          direction === "up"
            ? p.userVote === "down" ? 2 : 1
            : p.userVote === "up" ? -2 : -1;
        return { ...p, score: currentScore + scoreDelta, userVote: direction };
      })
    );

    try {
      if (isToggle) {
        await apiFetch(`/tlds/proposals/${proposalId}/vote`, { method: "DELETE" });
      } else {
        await apiFetch(`/tlds/proposals/${proposalId}/vote`, {
          method: "POST",
          body: JSON.stringify({ direction }),
        });
      }
    } catch {
      // Revert on error
      const updated = await apiFetch<Proposal[]>("/tlds/proposals");
      setProposals(updated);
    }
  };

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>{t("propose:meta.title")} — TNP</title>
        <meta name="description" content={t("propose:meta.description")} />
        <link rel="canonical" href="https://tnp.network/propose" />
        <meta property="og:title" content={`${t("propose:meta.title")} — TNP`} />
        <meta property="og:description" content={t("propose:meta.ogDescription")} />
        <meta property="og:url" content="https://tnp.network/propose" />
      </Helmet>
      <h1 className="mb-2 font-pixel text-xl text-accent">
        {t("propose:title")}
      </h1>
      <p className="mb-8 font-mono text-sm text-muted">
        {t("propose:subtitle")}
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
                placeholder={t("propose:tldPlaceholder")}
                className="rounded-r-md bg-transparent px-2 py-2.5 font-mono text-sm text-primary placeholder:text-muted focus:outline-none"
                required
              />
            </div>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("propose:reasonPlaceholder")}
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
            {submitting ? t("propose:proposing") : t("propose:proposeTld")}
          </button>
        </form>
      ) : (
        <div className="mb-12 rounded-lg border border-edge bg-surface-card p-6 text-center">
          <p className="mb-4 font-mono text-sm text-muted">{t("propose:signInPrompt")}</p>
          <button
            onClick={() => signIn()}
            className="cursor-pointer rounded-md border border-accent/30 bg-accent/10 px-4 py-2.5 font-mono text-sm text-accent transition-colors hover:bg-accent/20"
          >
            [{t("common:auth.signInWithOxy")}]
          </button>
        </div>
      )}

      <h2 className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">{t("propose:openProposals")}</h2>
      {proposals.length === 0 ? (
        <p className="font-mono text-sm text-muted">{t("propose:noProposals")}</p>
      ) : (
        <div className="space-y-3">
          {proposals.map((p) => (
            <div
              key={p._id}
              className="flex items-center gap-4 rounded-lg border border-edge bg-surface-card p-4"
            >
              {(() => {
                const canVote = p.status === "open" && isAuthenticated && user?.id !== p.proposedBy?.oxyUserId;
                const score = p.score ?? 0;
                const formattedScore = score > 0 ? `+${score}` : `${score}`;
                return (
                  <div className={`flex w-10 flex-col items-center gap-0.5${!canVote ? " justify-center" : ""}`}>
                    {canVote && (
                      <button
                        onClick={() => handleVote(p._id, "up")}
                        className={`cursor-pointer rounded p-1.5 transition-all duration-150 ${
                          p.userVote === "up"
                            ? "bg-accent/10 text-accent"
                            : "text-muted hover:bg-white/5 hover:text-primary"
                        }`}
                        aria-label={t("propose:upvote")}
                      >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 4l-8 8h5v8h6v-8h5z" />
                        </svg>
                      </button>
                    )}
                    <span className={`font-mono text-xs font-medium ${
                      score > 0 ? "text-accent" : score < 0 ? "text-red-400" : "text-muted"
                    }${!canVote ? " cursor-default" : ""}`}>
                      {formattedScore}
                    </span>
                    {canVote && (
                      <button
                        onClick={() => handleVote(p._id, "down")}
                        className={`cursor-pointer rounded p-1.5 transition-all duration-150 ${
                          p.userVote === "down"
                            ? "bg-red-400/10 text-red-400"
                            : "text-muted hover:bg-white/5 hover:text-primary"
                        }`}
                        aria-label={t("propose:downvote")}
                      >
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M12 20l8-8h-5V4H9v8H4z" />
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })()}
              <div className="flex-1">
                <span className="font-mono text-accent">.{p.tld}</span>
                <p className="mt-1 font-mono text-xs text-muted">{p.reason}</p>
              </div>
              <span
                className={`rounded-md px-2.5 py-0.5 font-mono text-xs font-medium ${
                  p.status === "open"
                    ? "bg-accent/10 text-accent"
                    : p.status === "approved"
                      ? "bg-green-500/10 text-green-400"
                      : "bg-red-500/10 text-red-400"
                }`}
              >
                {t(`propose:${STATUS_KEYS[p.status]}`)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
