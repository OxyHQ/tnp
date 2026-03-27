import { useState } from "react";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import { useAuth } from "../lib/auth";
import CodeBlock from "../components/CodeBlock";

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
      {/* Hero */}
      <section className="py-24 sm:py-36">
        <div className="mx-auto max-w-[640px] px-4 text-center">
          <h1 className="mb-2 font-mono text-[clamp(3rem,2.5rem+2.5vw,5rem)] font-bold tracking-tight text-primary">
            TNP
          </h1>
          <p className="mb-2 text-[clamp(1.125rem,1rem+0.5vw,1.5rem)] font-medium text-foreground">
            The Network Protocol
          </p>
          <p className="mb-10 text-[15px] text-muted-foreground">
            Your internet. Your rules.
          </p>

          <CodeBlock code="curl -fsSL https://get.tnp.network | sh" className="mb-8" />

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
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-border py-16">
        <div className="mx-auto max-w-[1200px] px-4 lg:px-6">
          <h2 className="mb-8 text-center text-lg font-semibold">How it works</h2>
          <div className="grid gap-6 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-surface p-6">
              <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-[10px] bg-primary/10 font-mono text-sm font-bold text-primary">
                1
              </div>
              <h3 className="mb-2 text-[15px] font-medium">Install</h3>
              <p className="text-sm text-muted-foreground">
                Run a single command. The TNP daemon configures your system DNS to resolve
                TNP domains natively.
              </p>
            </div>
            <div className="rounded-xl border border-border bg-surface p-6">
              <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-[10px] bg-primary/10 font-mono text-sm font-bold text-primary">
                2
              </div>
              <h3 className="mb-2 text-[15px] font-medium">Register</h3>
              <p className="text-sm text-muted-foreground">
                Pick a name, choose a TLD, and register your domain. It is linked to your
                Oxy account instantly.
              </p>
            </div>
            <div className="rounded-xl border border-border bg-surface p-6">
              <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-[10px] bg-primary/10 font-mono text-sm font-bold text-primary">
                3
              </div>
              <h3 className="mb-2 text-[15px] font-medium">Resolve</h3>
              <p className="text-sm text-muted-foreground">
                Your domain resolves everywhere -- browsers, CLI tools, APIs. No VPN, no
                proxy, just DNS.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* TLD showcase */}
      <section className="border-t border-border py-16">
        <div className="mx-auto max-w-[1200px] px-4 lg:px-6">
          <h2 className="mb-8 text-center text-lg font-semibold">Available TLDs</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { tld: ".ox", desc: "The native TNP domain. Short, sharp, yours." },
              { tld: ".app", desc: "For applications, tools, and services." },
              { tld: ".com", desc: "The classic, reimagined on TNP." },
              { tld: ".???", desc: "Propose your own TLD and let the community vote.", link: "/propose" },
            ].map((item) => (
              <Link
                key={item.tld}
                to={item.link || "/register"}
                className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-primary/20"
              >
                <span className="mb-2 block font-mono text-xl font-bold text-primary">
                  {item.tld}
                </span>
                <p className="text-sm text-muted-foreground">{item.desc}</p>
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Why TNP */}
      <section className="border-t border-border py-16">
        <div className="mx-auto max-w-[1200px] px-4 lg:px-6">
          <h2 className="mb-8 text-center text-lg font-semibold">Why TNP</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-surface p-5">
              <h3 className="mb-1 text-[15px] font-medium text-foreground">
                Own your namespace
              </h3>
              <p className="text-sm text-muted-foreground">
                TNP domains exist outside ICANN. No registrar middlemen, no annual renewal
                fees to third parties.
              </p>
            </div>
            <div className="rounded-xl border border-border bg-surface p-5">
              <h3 className="mb-1 text-[15px] font-medium text-foreground">
                Linked to Oxy identity
              </h3>
              <p className="text-sm text-muted-foreground">
                Every domain is tied to your Oxy account via SSO. One identity, every
                service.
              </p>
            </div>
            <div className="rounded-xl border border-border bg-surface p-5">
              <h3 className="mb-1 text-[15px] font-medium text-foreground">
                Open by design
              </h3>
              <p className="text-sm text-muted-foreground">
                Propose new TLDs, vote on community proposals, and help shape the
                namespace.
              </p>
            </div>
            <div className="rounded-xl border border-border bg-surface p-5">
              <h3 className="mb-1 text-[15px] font-medium text-foreground">
                DNS only
              </h3>
              <p className="text-sm text-muted-foreground">
                TNP is not a VPN. It does not route traffic. It only touches name
                resolution -- nothing more.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border py-16">
        <div className="mx-auto max-w-[480px] px-4 text-center">
          <h2 className="mb-4 text-lg font-semibold">
            Register your domain
          </h2>
          <p className="mb-6 text-[15px] text-muted-foreground">
            Claim your name on the TNP network. It takes seconds.
          </p>
          <div className="flex items-center justify-center gap-3">
            {isAuthenticated ? (
              <Link
                to="/register"
                className="inline-flex h-9 items-center justify-center rounded-[10px] border border-primary bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Register a domain
              </Link>
            ) : (
              <button
                onClick={() => signIn()}
                className="inline-flex h-9 cursor-pointer items-center justify-center rounded-[10px] border border-primary bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                Sign in with Oxy
              </button>
            )}
            <Link
              to="/install"
              className="inline-flex h-9 items-center justify-center rounded-[10px] border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-surface"
            >
              Install TNP
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
