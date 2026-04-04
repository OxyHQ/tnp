import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";

const navLinks = [
  { label: "explore", href: "/explore" },
  { label: "domains", href: "/domains" },
  { label: "network", href: "/network" },
  { label: "propose", href: "/propose" },
  { label: "install", href: "/install" },
];

export default function Layout() {
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
                {navLinks.map((link) => (
                  <li key={link.href}>
                    <Link
                      to={link.href}
                      className={`font-mono text-sm transition-colors ${
                        location.pathname === link.href
                          ? "text-accent"
                          : "text-muted hover:text-secondary"
                      }`}
                    >
                      [{link.label}]
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
                    className="font-mono text-sm text-secondary transition-colors hover:text-primary"
                  >
                    [dashboard]
                  </Link>
                  <button
                    onClick={signOut}
                    className="cursor-pointer font-mono text-sm text-muted transition-colors hover:text-secondary"
                  >
                    [sign out]
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => signIn()}
                    className="cursor-pointer font-mono text-sm text-secondary transition-colors hover:text-primary"
                  >
                    [sign in]
                  </button>
                  <button
                    onClick={() => signIn()}
                    className="inline-flex h-8 cursor-pointer items-center justify-center rounded-md border border-accent/30 bg-accent/10 px-3 font-mono text-sm text-accent transition-colors hover:bg-accent/20"
                  >
                    Start for free
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
              <p className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">TNP</p>
              <div className="space-y-2.5 font-mono text-sm">
                <Link to="/" className="block text-secondary transition-colors hover:text-primary">Home</Link>
                <Link to="/explore" className="block text-secondary transition-colors hover:text-primary">Explore</Link>
                <Link to="/domains" className="block text-secondary transition-colors hover:text-primary">Domains</Link>
                <a href="https://oxy.so/tnp" className="block text-secondary transition-colors hover:text-primary">About TNP</a>
              </div>
            </div>
            <div>
              <p className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">Resources</p>
              <div className="space-y-2.5 font-mono text-sm">
                <Link to="/install" className="block text-secondary transition-colors hover:text-primary">Install</Link>
                <Link to="/propose" className="block text-secondary transition-colors hover:text-primary">Propose a TLD</Link>
                <a href="https://github.com/OxyHQ/tnp" target="_blank" rel="noopener noreferrer" className="block text-secondary transition-colors hover:text-primary">GitHub</a>
              </div>
            </div>
            <div>
              <p className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">Oxy</p>
              <div className="space-y-2.5 font-mono text-sm">
                <a href="https://oxy.so" target="_blank" rel="noopener noreferrer" className="block text-secondary transition-colors hover:text-primary">oxy.so</a>
                <a href="https://accounts.oxy.so" target="_blank" rel="noopener noreferrer" className="block text-secondary transition-colors hover:text-primary">Accounts</a>
                <a href="https://oxy.so/tnp" className="block text-secondary transition-colors hover:text-primary">TNP on Oxy</a>
              </div>
            </div>
            <div>
              <p className="mb-4 font-mono text-xs uppercase tracking-wider text-muted">Legal</p>
              <div className="space-y-2.5 font-mono text-sm">
                <a href="https://oxy.so/privacy" className="block text-secondary transition-colors hover:text-primary">Privacy</a>
                <a href="https://oxy.so/terms" className="block text-secondary transition-colors hover:text-primary">Terms</a>
              </div>
            </div>
          </div>
          <div className="mt-12 text-center font-mono text-xs text-muted">
            Made with love by Oxy.
          </div>
        </div>
      </footer>
    </div>
  );
}
