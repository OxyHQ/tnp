import { useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";

const tlds = [
  { name: "ox", description: "Short, sharp, Oxy-native" },
  { name: "app", description: "For web apps and developer projects" },
  { name: "com", description: "The classic, now on TNP" },
];

const steps = [
  { number: "01", title: "Install TNP", description: "One command configures your system DNS to resolve TNP domains." },
  { number: "02", title: "Register your domain", description: "Pick a name, pick a TLD, and it is yours. Linked to your Oxy account." },
  { number: "03", title: "It just works", description: "Your domain resolves natively on any device running TNP." },
];

export default function Home() {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ domain: string; available: boolean } | null>(null);
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
      <section className="py-24 sm:py-32">
        <div className="mx-auto max-w-3xl px-4 text-center">
          <p className="mb-4 font-mono text-xs uppercase tracking-widest text-muted">
            The Network Protocol
          </p>
          <h1 className="mb-6 text-4xl font-bold tracking-tight sm:text-6xl">
            <span className="bg-gradient-to-r from-primary to-emerald-300 bg-clip-text text-transparent">
              Your internet. Your rules.
            </span>
          </h1>
          <p className="mb-8 text-lg text-muted">
            TNP is an alternative internet namespace controlled by Oxy. Register domains on
            TLDs that no one else can offer.
          </p>

          {/* Domain search */}
          <form onSubmit={checkDomain} className="mb-4 flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="yourname.ox"
              className="flex-1 rounded-full border border-border bg-surface px-5 py-3 text-foreground placeholder:text-muted focus:border-primary focus:outline-none"
            />
            <button
              type="submit"
              disabled={checking}
              className="cursor-pointer rounded-full bg-primary px-6 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {checking ? "Checking..." : "Check"}
            </button>
          </form>
          {result && (
            <p className={`text-sm ${result.available ? "text-primary" : "text-red-400"}`}>
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

          {/* Install command */}
          <div className="mt-8 rounded-xl border border-border bg-surface px-5 py-3 font-mono text-sm text-primary">
            curl -fsSL https://get.tnp.network | sh
          </div>
        </div>
      </section>

      {/* TLDs */}
      <section className="border-t border-border py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-4 lg:px-6">
          <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
            [ Domains ]
          </p>
          <h2 className="mb-12 text-3xl font-bold tracking-tight">
            TLDs available at launch
          </h2>
          <div className="grid gap-6 md:grid-cols-3">
            {tlds.map((tld) => (
              <div
                key={tld.name}
                className="rounded-xl border border-border bg-surface p-6 transition-colors hover:border-primary/30"
              >
                <p className="mb-2 font-mono text-2xl text-primary">.{tld.name}</p>
                <p className="text-sm text-muted">{tld.description}</p>
              </div>
            ))}
          </div>
          <div className="mt-6 text-center">
            <Link
              to="/propose"
              className="text-sm text-primary transition-colors hover:text-primary/80"
            >
              Want a different TLD? Propose one to the community.
            </Link>
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-border py-16 sm:py-24">
        <div className="mx-auto max-w-7xl px-4 lg:px-6">
          <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
            [ How it works ]
          </p>
          <h2 className="mb-12 text-3xl font-bold tracking-tight">
            Three steps. No configuration.
          </h2>
          <div className="grid gap-8 md:grid-cols-3">
            {steps.map((step) => (
              <div key={step.number}>
                <p className="mb-2 font-mono text-sm text-primary">{step.number}</p>
                <h3 className="mb-2 text-lg font-semibold">{step.title}</h3>
                <p className="text-sm text-muted">{step.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border py-24 text-center">
        <div className="mx-auto max-w-lg px-4">
          <h2 className="mb-4 text-3xl font-bold tracking-tight">
            Claim your namespace.
          </h2>
          <p className="mb-8 text-muted">
            Registration is free and requires an Oxy account.
          </p>
          <Link
            to="/register"
            className="inline-flex rounded-full bg-primary px-6 py-3 font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Register a Domain
          </Link>
        </div>
      </section>
    </div>
  );
}
