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
      <header className="sticky top-0 z-50 border-b border-edge bg-background/80 backdrop-blur-md">
        <div className="mx-auto w-full max-w-[1200px] px-4 lg:px-6">
          <nav aria-label="Main navigation" className="flex items-center justify-between py-3 lg:py-4">
            <div className="flex items-center gap-6">
              <Link
                to="/"
                className="font-pixel text-sm text-accent transition-colors hover:text-primary"
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
                          ? "text-accent"
                          : "text-muted hover:text-secondary"
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
                className="rounded-md border border-edge bg-surface-raised px-2 py-1.5 font-mono text-xs text-secondary"
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
                    className="font-mono text-sm text-secondary transition-colors hover:text-primary"
                  >
                    [{t("nav.dashboard")}]
                  </Link>
                  <button
                    onClick={signOut}
                    className="cursor-pointer font-mono text-sm text-muted transition-colors hover:text-secondary"
                  >
                    [{t("auth.signOut")}]
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => signIn()}
                    className="cursor-pointer font-mono text-sm text-secondary transition-colors hover:text-primary"
                  >
                    [{t("auth.signIn")}]
                  </button>
                  <button
                    onClick={() => signIn()}
                    className="inline-flex h-8 cursor-pointer items-center justify-center rounded-md border border-accent/30 bg-accent/10 px-3 font-mono text-sm text-accent transition-colors hover:bg-accent/20"
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

      <footer role="contentinfo" className="border-t border-edge">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-12 lg:px-6">
          <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
            <div>
              <p className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">{t("footer.tnp")}</p>
              <div className="space-y-2.5 font-mono text-sm">
                <Link to="/" className="block text-secondary transition-colors hover:text-primary">{t("footer.home")}</Link>
                <Link to="/explore" className="block text-secondary transition-colors hover:text-primary">{t("footer.explore")}</Link>
                <Link to="/domains" className="block text-secondary transition-colors hover:text-primary">{t("footer.domains")}</Link>
                <a href="https://oxy.so/tnp" className="block text-secondary transition-colors hover:text-primary">{t("footer.aboutTnp")}</a>
              </div>
            </div>
            <div>
              <p className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">{t("footer.resources")}</p>
              <div className="space-y-2.5 font-mono text-sm">
                <Link to="/install" className="block text-secondary transition-colors hover:text-primary">{t("footer.install")}</Link>
                <Link to="/propose" className="block text-secondary transition-colors hover:text-primary">{t("footer.proposeTld")}</Link>
                <a href="https://github.com/OxyHQ/tnp" target="_blank" rel="noopener noreferrer" className="block text-secondary transition-colors hover:text-primary">{t("footer.github")}</a>
              </div>
            </div>
            <div>
              <p className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">{t("footer.oxy")}</p>
              <div className="space-y-2.5 font-mono text-sm">
                <a href="https://oxy.so" target="_blank" rel="noopener noreferrer" className="block text-secondary transition-colors hover:text-primary">{t("footer.oxySo")}</a>
                <a href="https://accounts.oxy.so" target="_blank" rel="noopener noreferrer" className="block text-secondary transition-colors hover:text-primary">{t("footer.accounts")}</a>
                <a href="https://oxy.so/tnp" className="block text-secondary transition-colors hover:text-primary">{t("footer.tnpOnOxy")}</a>
              </div>
            </div>
            <div>
              <p className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">{t("footer.legal")}</p>
              <div className="space-y-2.5 font-mono text-sm">
                <a href="https://oxy.so/privacy" className="block text-secondary transition-colors hover:text-primary">{t("footer.privacy")}</a>
                <a href="https://oxy.so/terms" className="block text-secondary transition-colors hover:text-primary">{t("footer.terms")}</a>
              </div>
            </div>
          </div>
          <div className="mt-12 text-center font-mono text-xs text-muted">
            {t("footer.madeWithLove")}
          </div>
        </div>
      </footer>
    </div>
  );
}
