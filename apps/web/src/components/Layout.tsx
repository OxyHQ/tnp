import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";

const navLinks = [
  { label: "Explore", href: "/explore" },
  { label: "Domains", href: "/domains" },
  { label: "Propose", href: "/propose" },
  { label: "Install", href: "/install" },
];

export default function Layout() {
  const { isAuthenticated, logout } = useAuth();
  const location = useLocation();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto w-full max-w-7xl px-4 lg:px-6">
          <nav className="flex items-center justify-between gap-4 py-4">
            <div className="flex items-center gap-8">
              <Link to="/" className="text-lg font-bold tracking-tight text-primary">
                TNP
              </Link>
              <ul className="hidden items-center gap-1 md:flex">
                {navLinks.map((link) => (
                  <li key={link.href}>
                    <Link
                      to={link.href}
                      className={`rounded-full px-3 py-1.5 text-sm transition-colors ${
                        location.pathname === link.href
                          ? "bg-primary/10 text-primary"
                          : "text-muted hover:text-foreground"
                      }`}
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex items-center gap-3">
              {isAuthenticated ? (
                <>
                  <Link
                    to="/dashboard"
                    className="rounded-full border border-border px-4 py-1.5 text-sm text-foreground transition-colors hover:bg-surface"
                  >
                    Dashboard
                  </Link>
                  <button
                    onClick={logout}
                    className="cursor-pointer rounded-full px-4 py-1.5 text-sm text-muted transition-colors hover:text-foreground"
                  >
                    Sign out
                  </button>
                </>
              ) : (
                <>
                  <Link
                    to="/register"
                    className="rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    Register a Domain
                  </Link>
                </>
              )}
            </div>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-border py-12">
        <div className="mx-auto w-full max-w-7xl px-4 lg:px-6">
          <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                TNP
              </p>
              <div className="space-y-2 text-sm">
                <Link to="/" className="block text-muted hover:text-foreground transition-colors">Home</Link>
                <Link to="/explore" className="block text-muted hover:text-foreground transition-colors">Explore</Link>
                <Link to="/domains" className="block text-muted hover:text-foreground transition-colors">Domains</Link>
              </div>
            </div>
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                Resources
              </p>
              <div className="space-y-2 text-sm">
                <Link to="/install" className="block text-muted hover:text-foreground transition-colors">Install</Link>
                <Link to="/propose" className="block text-muted hover:text-foreground transition-colors">Propose a TLD</Link>
                <a href="https://github.com/OxyHQ/tnp" target="_blank" rel="noopener noreferrer" className="block text-muted hover:text-foreground transition-colors">GitHub</a>
              </div>
            </div>
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                Oxy
              </p>
              <div className="space-y-2 text-sm">
                <a href="https://oxy.so" target="_blank" rel="noopener noreferrer" className="block text-muted hover:text-foreground transition-colors">oxy.so</a>
                <a href="https://accounts.oxy.so" target="_blank" rel="noopener noreferrer" className="block text-muted hover:text-foreground transition-colors">Accounts</a>
              </div>
            </div>
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">
                Legal
              </p>
              <div className="space-y-2 text-sm">
                <a href="#" className="block text-muted hover:text-foreground transition-colors">Privacy</a>
                <a href="#" className="block text-muted hover:text-foreground transition-colors">Terms</a>
              </div>
            </div>
          </div>
          <div className="mt-12 text-center text-xs text-muted">
            Made with love by Oxy.
          </div>
        </div>
      </footer>
    </div>
  );
}
