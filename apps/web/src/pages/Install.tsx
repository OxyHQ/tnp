import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
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
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>Install TNP — The Network Protocol</title>
        <meta name="description" content="Install the TNP daemon to resolve TNP domains natively on macOS, Linux, or Windows. One command setup." />
        <link rel="canonical" href="https://tnp.network/install" />
        <meta property="og:title" content="Install TNP — The Network Protocol" />
        <meta property="og:description" content="Install the TNP daemon to resolve TNP domains natively on macOS, Linux, or Windows." />
        <meta property="og:url" content="https://tnp.network/install" />
      </Helmet>
      <h1 className="mb-2 font-pixel text-xl text-accent">
        Install TNP
      </h1>
      <p className="mb-8 font-mono text-sm text-muted">
        One command. Your device starts resolving TNP domains immediately.
      </p>

      {clientInfo && (
        <p className="mb-4 font-mono text-xs text-muted">
          Latest version: {clientInfo.version}
        </p>
      )}

      <div className="mb-8 flex items-center justify-between rounded-lg border border-edge bg-surface-card px-4 py-3">
        <code className="font-mono text-sm text-accent">{installCommand}</code>
        <button
          onClick={copyCommand}
          className="ml-3 cursor-pointer font-mono text-xs text-muted transition-colors hover:text-secondary"
        >
          [{copied ? "copied" : "copy"}]
        </button>
      </div>

      <div className="mb-6 flex gap-2">
        {platforms.map((p) => (
          <button
            key={p.id}
            onClick={() => setPlatform(p.id)}
            className={`cursor-pointer rounded-md px-3 py-1.5 font-mono text-sm transition-colors ${
              platform === p.id
                ? "border border-accent/30 bg-accent/10 text-accent"
                : "border border-edge text-muted hover:text-secondary"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-edge bg-surface-card p-5 space-y-4">
        {platform === "macos" && (
          <>
            <h3 className="font-mono text-sm font-medium text-primary">macOS</h3>
            <p className="font-mono text-xs text-muted">
              The installer configures your system DNS resolver to query TNP nameservers for
              TNP domains, while forwarding everything else to your default resolver.
            </p>
            <div className="space-y-1 font-mono text-xs text-muted">
              <p className="font-medium text-secondary">Requirements:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>macOS 12 Monterey or later</li>
                <li>Admin password (the installer sets up a resolver config)</li>
              </ul>
            </div>
          </>
        )}
        {platform === "linux" && (
          <>
            <h3 className="font-mono text-sm font-medium text-primary">Linux</h3>
            <p className="font-mono text-xs text-muted">
              Works with systemd-resolved, NetworkManager, and standalone resolv.conf setups.
              The installer detects your DNS configuration automatically.
            </p>
            <div className="space-y-1 font-mono text-xs text-muted">
              <p className="font-medium text-secondary">Requirements:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Any modern Linux distribution</li>
                <li>sudo access</li>
              </ul>
            </div>
          </>
        )}
        {platform === "windows" && (
          <>
            <h3 className="font-mono text-sm font-medium text-primary">Windows</h3>
            <p className="font-mono text-xs text-muted">
              Windows support is coming soon.
            </p>
          </>
        )}
      </div>

      <div className="mt-8">
        <a
          href="https://oxy.so/tnp"
          className="font-mono text-sm text-muted transition-colors hover:text-secondary"
        >
          [learn more about tnp]
        </a>
      </div>
    </div>
  );
}
