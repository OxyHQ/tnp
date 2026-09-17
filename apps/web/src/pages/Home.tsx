import { useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiFetch, errorStatus } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  availabilityMessageKey,
  parentDomain,
  type AvailabilityResult,
} from "../lib/availability";

const QUICK_LINKS = [
  { to: "/explore", key: "explore" },
  { to: "/register", key: "register" },
  { to: "/propose", key: "propose" },
  { to: "/install", key: "install" },
] as const;

export default function Home() {
  const { t } = useTranslation(["home", "common"]);
  const { isAuthenticated, signIn } = useAuth();
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<AvailabilityResult | null>(null);
  const [checking, setChecking] = useState(false);

  const checkDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.includes(".")) return;
    setChecking(true);
    const input = query.trim().toLowerCase();
    try {
      const data = await apiFetch<AvailabilityResult>(
        `/domains/check/${encodeURIComponent(input)}`
      );
      setResult(data);
    } catch (err) {
      // An API image older than this build answers a malformed name (a
      // subdomain, say) with a 400 instead of `reason: "invalid"`. Say the
      // same thing either way. Remove once that image is no longer served.
      setResult(errorStatus(err) === 400 ? { domain: input, available: false, reason: "invalid" } : null);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div>
      <Helmet>
        <title>{t("home:meta.title")}</title>
        <meta name="description" content={t("home:meta.description")} />
        <link rel="canonical" href="https://tnp.network/" />
        <meta property="og:url" content="https://tnp.network/" />
      </Helmet>
      {/* Hero */}
      <section className="py-24 sm:py-36">
        <div className="mx-auto max-w-[600px] px-4 text-center">
          <h1 className="mb-6 font-pixel text-3xl tracking-tight text-primary-text sm:text-4xl">
            {t("home:heroTitle")}
          </h1>
          <p className="mb-10 font-mono text-sm leading-relaxed text-muted-foreground">
            {t("home:heroDescription")}
          </p>

          {/* Domain search */}
          <form onSubmit={checkDomain} className="mb-3 flex gap-2">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("home:searchPlaceholder")}
              className="flex-1 rounded-md border border-border bg-surface px-4 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-primary focus:outline-none transition-colors"
            />
            <button
              type="submit"
              disabled={checking}
              className="cursor-pointer rounded-md border border-primary/30 bg-primary/10 px-5 py-2.5 font-mono text-sm text-primary-text transition-colors hover:bg-primary/20 disabled:opacity-50"
            >
              {checking ? t("home:checking") : t("home:check")}
            </button>
          </form>
          {result && (
            <p
              role="status"
              className={`mb-6 font-mono text-sm ${result.available ? "text-primary-text" : "text-error-text"}`}
            >
              {t(availabilityMessageKey(result), {
                domain: result.domain,
                parent: parentDomain(result.domain),
              })}
              {result.available && (
                <>
                  {" "}
                  <Link to="/register" className="underline">
                    {t("home:registerNow")}
                  </Link>
                </>
              )}
            </p>
          )}

          <div className="flex items-center justify-center gap-3 mt-6">
            {isAuthenticated ? (
              <Link
                to="/dashboard"
                className="font-mono text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                [dashboard]
              </Link>
            ) : (
              <button
                onClick={() => signIn()}
                className="cursor-pointer font-mono text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                [{t("home:signInWithOxy")}]
              </button>
            )}
            <a
              href="https://oxy.so/tnp"
              className="font-mono text-sm text-muted-foreground/70 transition-colors hover:text-muted-foreground"
            >
              [{t("home:learnMore")}]
            </a>
          </div>
        </div>
      </section>

      {/* Quick links */}
      <section className="border-t border-border py-16">
        <div className="mx-auto max-w-[1200px] px-4 lg:px-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {QUICK_LINKS.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="group rounded-lg border border-border bg-card p-5 transition-colors hover:border-border hover:bg-accent"
              >
                <h3 className="mb-1 font-mono text-sm font-medium text-foreground group-hover:text-primary-text transition-colors">
                  {t(`home:quickLinks.${item.key}.title`)}
                </h3>
                <p className="font-mono text-xs text-muted-foreground/70">
                  {t(`home:quickLinks.${item.key}.desc`)}
                </p>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
