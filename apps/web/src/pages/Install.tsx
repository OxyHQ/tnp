import { useState, useEffect } from "react";
import { apiFetch } from "../lib/api";

type Platform = "macos" | "linux" | "windows";

const platforms: { id: Platform; label: string }[] = [
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
  { id: "windows", label: "Windows" },
];

interface ClientInfo {
  version: string;
  changelog: string;
  platforms: Record<string, { url: string; sha256: string } | null>;
}

export default function Install() {
  const [platform, setPlatform] = useState<Platform>("macos");
  const [clientInfo, setClientInfo] = useState<ClientInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const installCommand = "curl -fsSL https://get.tnp.network | sh";

  useEffect(() => {
    let ignore = false;
    apiFetch<ClientInfo>("/client/latest")
      .then((data) => {
        if (!ignore) setClientInfo(data);
      })
      .catch(() => {});
    return () => { ignore = true; };
  }, []);

  const copyCommand = () => {
    navigator.clipboard.writeText(installCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <p className="mb-2 font-mono text-xs uppercase tracking-widest text-muted">
        [ Install ]
      </p>
      <h1 className="mb-4 text-3xl font-bold tracking-tight">Install TNP</h1>
      <p className="mb-8 text-muted">
        One command. Your device starts resolving TNP domains immediately.
      </p>

      {clientInfo && (
        <p className="mb-4 text-sm text-muted">
          Latest version: {clientInfo.version}
        </p>
      )}

      {/* Install command */}
      <div className="mb-8 flex items-center justify-between rounded-xl border border-border bg-surface px-5 py-4">
        <code className="font-mono text-sm text-primary">{installCommand}</code>
        <button
          onClick={copyCommand}
          className="ml-4 cursor-pointer rounded-lg px-3 py-1 text-xs text-muted transition-colors hover:bg-background hover:text-foreground"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      {/* Platform tabs */}
      <div className="mb-6 flex gap-2">
        {platforms.map((p) => (
          <button
            key={p.id}
            onClick={() => setPlatform(p.id)}
            className={`cursor-pointer rounded-full px-4 py-2 text-sm font-medium transition-colors ${
              platform === p.id
                ? "bg-primary text-primary-foreground"
                : "border border-border text-muted hover:text-foreground"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-surface p-6 space-y-4">
        {platform === "macos" && (
          <>
            <h3 className="font-semibold">macOS</h3>
            <p className="text-sm text-muted">
              The installer configures your system DNS resolver to query TNP nameservers for
              TNP domains, while forwarding everything else to your default resolver.
            </p>
            <div className="space-y-1 text-sm text-muted">
              <p className="font-medium text-foreground">Requirements:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>macOS 12 Monterey or later</li>
                <li>Admin password (the installer sets up a resolver config)</li>
              </ul>
            </div>
            <div className="space-y-1 text-sm text-muted">
              <p className="font-medium text-foreground">What it does:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Downloads the TNP resolver binary</li>
                <li>Creates resolver entries in /etc/resolver/ for each TNP TLD</li>
                <li>Starts a lightweight background service via launchd</li>
              </ul>
            </div>
          </>
        )}

        {platform === "linux" && (
          <>
            <h3 className="font-semibold">Linux</h3>
            <p className="text-sm text-muted">
              Works with systemd-resolved, NetworkManager, and standalone resolv.conf setups.
              The installer detects your DNS configuration automatically.
            </p>
            <div className="space-y-1 text-sm text-muted">
              <p className="font-medium text-foreground">Requirements:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Any modern Linux distribution (Ubuntu, Fedora, Arch, Debian, etc.)</li>
                <li>sudo access</li>
              </ul>
            </div>
            <div className="space-y-1 text-sm text-muted">
              <p className="font-medium text-foreground">What it does:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Downloads the TNP resolver binary</li>
                <li>Configures systemd-resolved split DNS (or adds entries to resolv.conf)</li>
                <li>Enables a systemd service for the TNP resolver</li>
              </ul>
            </div>
          </>
        )}

        {platform === "windows" && (
          <>
            <h3 className="font-semibold">Windows</h3>
            <p className="text-sm text-muted">
              Windows support is coming soon. The installer will configure the Windows DNS
              client to resolve TNP domains natively.
            </p>
            <p className="text-sm text-muted">
              Want early access? Join the waitlist at{" "}
              <a
                href="https://tnp.network"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                tnp.network
              </a>
              .
            </p>
          </>
        )}
      </div>

      {/* What happens */}
      <div className="mt-12 space-y-4">
        <h2 className="text-lg font-semibold">What happens when you install TNP</h2>
        <p className="text-sm text-muted">
          TNP runs a small local DNS resolver on your machine. When you visit a TNP domain
          (like nate.ox), the resolver queries TNP nameservers and returns the right IP
          address. For all other domains, it forwards the query to your normal DNS provider.
        </p>
        <p className="text-sm text-muted">
          There is no VPN. There is no traffic routing. There is no proxy. TNP only touches
          DNS resolution.
        </p>
        <p className="text-sm text-muted">
          To uninstall, run{" "}
          <code className="rounded bg-background px-1.5 py-0.5 text-xs text-foreground">
            tnp uninstall
          </code>{" "}
          and everything is cleaned up.
        </p>
      </div>
    </div>
  );
}
