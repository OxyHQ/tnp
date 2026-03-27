import { Link, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../lib/auth";

const navLinks = [
  { label: "Explore", href: "/explore" },
  { label: "Domains", href: "/domains" },
  { label: "Propose", href: "/propose" },
  { label: "Install", href: "/install" },
];

export default function Layout() {
  const { isAuthenticated, signIn, signOut } = useAuth();
  const location = useLocation();

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* Navbar */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto w-full max-w-[1200px] px-4 lg:px-6">
          <nav className="flex items-center justify-between py-3 lg:py-4">
            <div className="flex items-center gap-8">
              <Link
                to="/"
                className="flex items-center gap-2 text-[15px] font-semibold text-foreground"
              >
                <span className="text-primary">TNP</span>
              </Link>
              <ul className="hidden items-center gap-1 lg:flex">
                {navLinks.map((link) => (
                  <li key={link.href}>
                    <Link
                      to={link.href}
                      className={`inline-flex h-9 items-center justify-center rounded-[10px] border border-transparent px-3 text-[15px] transition-colors duration-300 hover:bg-surface hover:text-foreground ${
                        location.pathname === link.href
                          ? "bg-surface text-foreground"
                          : "text-muted-foreground"
                      }`}
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex items-center gap-2.5">
              {isAuthenticated ? (
                <>
                  <Link
                    to="/dashboard"
                    className="inline-flex h-8 cursor-pointer items-center justify-center text-nowrap rounded-[10px] border border-border px-3 text-sm font-medium text-foreground transition-colors duration-300 hover:bg-surface"
                  >
                    Dashboard
                  </Link>
                  <button
                    onClick={signOut}
                    className="inline-flex h-8 cursor-pointer items-center justify-center text-nowrap rounded-[10px] border border-transparent px-3 text-sm font-medium text-muted-foreground transition-colors duration-300 hover:bg-surface hover:text-foreground"
                  >
                    Sign out
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => signIn()}
                    className="inline-flex h-8 cursor-pointer items-center justify-center text-nowrap rounded-[10px] border border-border px-3 text-sm font-medium text-foreground transition-colors duration-300 hover:bg-surface"
                  >
                    Sign in
                  </button>
                  <button
                    onClick={() => signIn()}
                    className="inline-flex h-8 cursor-pointer items-center justify-center text-nowrap rounded-[10px] border border-primary bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors duration-300 hover:bg-primary/90"
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

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto w-full max-w-[1200px] px-4 py-12 lg:px-6">
          <div className="grid grid-cols-2 gap-8 md:grid-cols-4">
            <div>
              <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">TNP</p>
              <div className="space-y-2.5 text-sm">
                <Link to="/" className="block text-muted-foreground transition-colors hover:text-foreground">Home</Link>
                <Link to="/explore" className="block text-muted-foreground transition-colors hover:text-foreground">Explore</Link>
                <Link to="/domains" className="block text-muted-foreground transition-colors hover:text-foreground">Domains</Link>
                <a href="https://oxy.so/tnp" className="block text-muted-foreground transition-colors hover:text-foreground">About TNP</a>
              </div>
            </div>
            <div>
              <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Resources</p>
              <div className="space-y-2.5 text-sm">
                <Link to="/install" className="block text-muted-foreground transition-colors hover:text-foreground">Install</Link>
                <Link to="/propose" className="block text-muted-foreground transition-colors hover:text-foreground">Propose a TLD</Link>
                <a href="https://github.com/OxyHQ/tnp" target="_blank" rel="noopener noreferrer" className="block text-muted-foreground transition-colors hover:text-foreground">GitHub</a>
              </div>
            </div>
            <div>
              <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Oxy</p>
              <div className="space-y-2.5 text-sm">
                <a href="https://oxy.so" target="_blank" rel="noopener noreferrer" className="block text-muted-foreground transition-colors hover:text-foreground">oxy.so</a>
                <a href="https://accounts.oxy.so" target="_blank" rel="noopener noreferrer" className="block text-muted-foreground transition-colors hover:text-foreground">Accounts</a>
                <a href="https://oxy.so/tnp" className="block text-muted-foreground transition-colors hover:text-foreground">TNP on Oxy</a>
              </div>
            </div>
            <div>
              <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Legal</p>
              <div className="space-y-2.5 text-sm">
                <a href="https://oxy.so/privacy" className="block text-muted-foreground transition-colors hover:text-foreground">Privacy</a>
                <a href="https://oxy.so/terms" className="block text-muted-foreground transition-colors hover:text-foreground">Terms</a>
              </div>
            </div>
          </div>
          <div className="mt-12 text-center text-xs text-muted-foreground">
            Made with love by Oxy.
          </div>
        </div>
      </footer>
    </div>
  );
}
