import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";

const NAV_LINKS = [
  { key: "nav.explore", href: "/explore" },
  { key: "nav.domains", href: "/domains" },
  { key: "nav.network", href: "/network" },
  { key: "nav.propose", href: "/propose" },
  { key: "nav.install", href: "/install" },
] as const;

const LANGUAGES = [
  { code: "en", label: "EN" },
  { code: "zh", label: "中文" },
  { code: "es", label: "ES" },
  { code: "hi", label: "हि" },
  { code: "fr", label: "FR" },
] as const;

export default function Layout() {
  const { t, i18n } = useTranslation("common");
  const { isAuthenticated, signIn, signOut } = useAuth();
  const location = useLocation();

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto w-full max-w-[1200px] px-4 lg:px-6">
          <nav aria-label="Main navigation" className="flex items-center justify-between py-3 lg:py-4">
            <div className="flex items-center gap-6">
              <Link
                to="/"
                className="font-pixel text-sm text-primary-text transition-colors hover:text-foreground"
              >
                TNP
              </Link>
              <ul className="hidden items-center gap-1 lg:flex">
                {NAV_LINKS.map((link) => (
                  <li key={link.href}>
                    <Link
                      to={link.href}
                      className={`font-mono text-sm transition-colors ${
                        location.pathname === link.href
                          ? "text-primary-text"
                          : "text-muted-foreground/70 hover:text-muted-foreground"
                      }`}
                    >
                      [{t(link.key)}]
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex items-center gap-3">
              <select
                value={i18n.language}
                onChange={(e) => i18n.changeLanguage(e.target.value)}
                className="rounded-md border border-border bg-surface px-2 py-1.5 font-mono text-xs text-muted-foreground"
                aria-label="Select language"
              >
                {LANGUAGES.map((lang) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
              {isAuthenticated ? (
                <>
                  <Link
                    to="/dashboard"
                    className="font-mono text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    [{t("nav.dashboard")}]
                  </Link>
                  <button
                    onClick={signOut}
                    className="cursor-pointer font-mono text-sm text-muted-foreground/70 transition-colors hover:text-muted-foreground"
                  >
                    [{t("auth.signOut")}]
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => signIn()}
                    className="cursor-pointer font-mono text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    [{t("auth.signIn")}]
                  </button>
                  <button
                    onClick={() => signIn()}
                    className="inline-flex h-8 cursor-pointer items-center justify-center rounded-md border border-primary/30 bg-primary/10 px-3 font-mono text-sm text-primary-text transition-colors hover:bg-primary/20"
                  >
                    {t("auth.startForFree")}
                  </button>
                </>
              )}
            </div>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer role="contentinfo" className="border-t border-border">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-12 lg:px-6">
          <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
            <div>
              <p className="mb-4 font-mono text-xs uppercase tracking-wider text-muted-foreground/70">{t("footer.tnp")}</p>
              <div className="space-y-2.5 font-mono text-sm">
                <Link to="/" className="block text-muted-foreground transition-colors hover:text-foreground">{t("footer.home")}</Link>
                <Link to="/explore" className="block text-muted-foreground transition-colors hover:text-foreground">{t("footer.explore")}</Link>
                <Link to="/domains" className="block text-muted-foreground transition-colors hover:text-foreground">{t("footer.domains")}</Link>
                <a href="https://oxy.so/tnp" className="block text-muted-foreground transition-colors hover:text-foreground">{t("footer.aboutTnp")}</a>
              </div>
            </div>
            <div>
              <p className="mb-4 font-mono text-xs uppercase tracking-wider text-muted-foreground/70">{t("footer.resources")}</p>
              <div className="space-y-2.5 font-mono text-sm">
                <Link to="/install" className="block text-muted-foreground transition-colors hover:text-foreground">{t("footer.install")}</Link>
                <Link to="/propose" className="block text-muted-foreground transition-colors hover:text-foreground">{t("footer.proposeTld")}</Link>
                <a href="https://github.com/OxyHQ/tnp" target="_blank" rel="noopener noreferrer" className="block text-muted-foreground transition-colors hover:text-foreground">{t("footer.github")}</a>
              </div>
            </div>
            <div>
              <p className="mb-4 font-mono text-xs uppercase tracking-wider text-muted-foreground/70">{t("footer.oxy")}</p>
              <div className="space-y-2.5 font-mono text-sm">
                <a href="https://oxy.so" target="_blank" rel="noopener noreferrer" className="block text-muted-foreground transition-colors hover:text-foreground">{t("footer.oxySo")}</a>
                <a href="https://accounts.oxy.so" target="_blank" rel="noopener noreferrer" className="block text-muted-foreground transition-colors hover:text-foreground">{t("footer.accounts")}</a>
                <a href="https://oxy.so/tnp" className="block text-muted-foreground transition-colors hover:text-foreground">{t("footer.tnpOnOxy")}</a>
              </div>
            </div>
            <div>
              <p className="mb-4 font-mono text-xs uppercase tracking-wider text-muted-foreground/70">{t("footer.legal")}</p>
              <div className="space-y-2.5 font-mono text-sm">
                <a href="https://oxy.so/privacy" className="block text-muted-foreground transition-colors hover:text-foreground">{t("footer.privacy")}</a>
                <a href="https://oxy.so/terms" className="block text-muted-foreground transition-colors hover:text-foreground">{t("footer.terms")}</a>
              </div>
            </div>
          </div>
          <div className="mt-12 text-center font-mono text-xs text-muted-foreground/70">
            {t("footer.madeWithLove")}
          </div>
        </div>
      </footer>
    </div>
  );
}
