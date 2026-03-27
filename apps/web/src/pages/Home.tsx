import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";

export default function Home() {
  const { isAuthenticated, signIn } = useAuth();
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
      <Helmet>
        <title>TNP — The Network Protocol</title>
        <meta name="description" content="Your internet. Your rules. Register domains on The Network Protocol — outside ICANN, linked to your Oxy identity." />
      </Helmet>
      {/* Hero */}
      <section className="py-24 sm:py-36">
        <div className="mx-auto max-w-[600px] px-4 text-center">
          <h1 className="mb-6 font-pixel text-3xl tracking-tight text-accent sm:text-4xl">
            The Network Protocol
          </h1>
          <p className="mb-10 font-mono text-sm leading-relaxed text-secondary">
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
              className="flex-1 rounded-md border border-edge bg-surface-raised px-4 py-2.5 font-mono text-sm text-primary placeholder:text-muted focus:border-accent focus:outline-none transition-colors"
            />
            <button
              type="submit"
              disabled={checking}
              className="cursor-pointer rounded-md border border-accent/30 bg-accent/10 px-5 py-2.5 font-mono text-sm text-accent transition-colors hover:bg-accent/20 disabled:opacity-50"
            >
              {checking ? "Checking..." : "Check"}
            </button>
          </form>
          {result && (
            <p
              className={`mb-6 font-mono text-sm ${result.available ? "text-accent" : "text-red-400"}`}
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
                className="font-mono text-sm text-secondary transition-colors hover:text-primary"
              >
                [dashboard]
              </Link>
            ) : (
              <button
                onClick={() => signIn()}
                className="cursor-pointer font-mono text-sm text-secondary transition-colors hover:text-primary"
              >
                [sign in with oxy]
              </button>
            )}
            <a
              href="https://oxy.so/tnp"
              className="font-mono text-sm text-muted transition-colors hover:text-secondary"
            >
              [learn more]
            </a>
          </div>
        </div>
      </section>

      {/* Quick links */}
      <section className="border-t border-edge py-16">
        <div className="mx-auto max-w-[1200px] px-4 lg:px-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                to: "/explore",
                title: "Explore TLDs",
                desc: "Browse available TLDs and recently registered domains.",
              },
              {
                to: "/register",
                title: "Register a Domain",
                desc: "Claim your name on .ox, .app, .com, or any active TLD.",
              },
              {
                to: "/propose",
                title: "Propose a TLD",
                desc: "Suggest a new TLD and let the community vote on it.",
              },
              {
                to: "/install",
                title: "Install TNP",
                desc: "One command to resolve TNP domains on your device.",
              },
            ].map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="group rounded-lg border border-edge bg-surface-card p-5 transition-colors hover:border-edge hover:bg-surface-hover"
              >
                <h3 className="mb-1 font-mono text-sm font-medium text-primary group-hover:text-accent transition-colors">
                  {item.title}
                </h3>
                <p className="font-mono text-xs text-muted">
                  {item.desc}
                </p>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
