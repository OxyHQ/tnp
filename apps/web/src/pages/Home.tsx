import { useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";

export default function Home() {
  const { isAuthenticated, login } = useAuth();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{
    domain: string;
    available: boolean;
  } | null>(null);
  const [checking, setChecking] = useState(false);

  const checkDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.includes(".")) return;
    setChecking(true);
    try {
      const data = await apiFetch<{ domain: string; available: boolean }>(
        `/domains/check/${query}`
      );
      setResult(data);
    } catch {
      setResult(null);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div>
      {/* Hero */}
      <section className="py-24 sm:py-36">
        <div className="mx-auto max-w-[600px] px-4 text-center">
          <h1 className="mb-6 text-[clamp(2.5rem,2rem+2vw,3.5rem)] font-semibold leading-[1.05] tracking-tight">
            The Network Protocol
          </h1>
          <p className="mb-10 text-[clamp(0.9375rem,0.875rem+0.25vw,1.0625rem)] leading-relaxed text-muted-foreground">
            Register domains on an alternative internet namespace. Explore TLDs,
            manage DNS records, and claim your space on TNP.
          </p>

          {/* Domain search */}
          <form onSubmit={checkDomain} className="mb-3 flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="yourname.ox"
              className="flex-1 rounded-[10px] border border-border bg-surface px-4 py-2.5 text-[15px] text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none transition-colors"
            />
            <button
              type="submit"
              disabled={checking}
              className="cursor-pointer rounded-[10px] border border-primary bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {checking ? "Checking..." : "Check availability"}
            </button>
          </form>
          {result && (
            <p
              className={`mb-6 text-sm ${result.available ? "text-primary" : "text-red-400"}`}
            >
              {result.domain} is {result.available ? "available" : "taken"}
              {result.available && (
                <>
                  {" "}
                  <Link to="/register" className="underline">
                    Register it now
                  </Link>
                </>
              )}
            </p>
          )}

          <div className="flex items-center justify-center gap-3 mt-6">
            {isAuthenticated ? (
              <Link
                to="/dashboard"
                className="inline-flex h-9 items-center justify-center rounded-[10px] border border-border px-4 text-[15px] font-medium text-foreground transition-colors hover:bg-surface"
              >
                Go to Dashboard
              </Link>
            ) : (
              <button
                onClick={login}
                className="inline-flex h-9 cursor-pointer items-center justify-center rounded-[10px] border border-border px-4 text-[15px] font-medium text-foreground transition-colors hover:bg-surface"
              >
                Sign in with Oxy
              </button>
            )}
            <a
              href="https://oxy.so/tnp"
              className="inline-flex h-9 items-center justify-center rounded-[10px] border border-transparent px-4 text-[15px] font-medium text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
            >
              Learn more about TNP
            </a>
          </div>
        </div>
      </section>

      {/* Quick links */}
      <section className="border-t border-border py-16">
        <div className="mx-auto max-w-[1200px] px-4 lg:px-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Link
              to="/explore"
              className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-primary/20"
            >
              <h3 className="mb-1 text-[15px] font-medium text-foreground group-hover:text-primary transition-colors">
                Explore TLDs
              </h3>
              <p className="text-sm text-muted-foreground">
                Browse available TLDs and recently registered domains.
              </p>
            </Link>
            <Link
              to="/register"
              className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-primary/20"
            >
              <h3 className="mb-1 text-[15px] font-medium text-foreground group-hover:text-primary transition-colors">
                Register a Domain
              </h3>
              <p className="text-sm text-muted-foreground">
                Claim your name on .ox, .app, .com, or any active TLD.
              </p>
            </Link>
            <Link
              to="/propose"
              className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-primary/20"
            >
              <h3 className="mb-1 text-[15px] font-medium text-foreground group-hover:text-primary transition-colors">
                Propose a TLD
              </h3>
              <p className="text-sm text-muted-foreground">
                Suggest a new TLD and let the community vote on it.
              </p>
            </Link>
            <Link
              to="/install"
              className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-primary/20"
            >
              <h3 className="mb-1 text-[15px] font-medium text-foreground group-hover:text-primary transition-colors">
                Install TNP
              </h3>
              <p className="text-sm text-muted-foreground">
                One command to resolve TNP domains on your device.
              </p>
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
