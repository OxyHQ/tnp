import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { apiFetch } from "../lib/api";
import CodeBlock from "../components/CodeBlock";

type Platform = "macos" | "linux" | "windows";

const platforms: { id: Platform; label: string }[] = [
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
  { id: "windows", label: "Windows" },
];

interface ClientInfo {
  version: string;
  platforms: Record<string, string>;
}

export default function Install() {
  const [platform, setPlatform] = useState<Platform>("macos");
  const [clientInfo, setClientInfo] = useState<ClientInfo | null>(null);
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

  return (
    <div className="mx-auto max-w-[640px] px-4 py-16">
      <Helmet>
        <title>Install TNP — The Network Protocol</title>
        <meta name="description" content="Install the TNP daemon to resolve TNP domains natively on macOS, Linux, or Windows." />
      </Helmet>
      <h1 className="mb-4 text-[clamp(1.5rem,1.25rem+1vw,2rem)] font-semibold tracking-tight">
        Install TNP
      </h1>
      <p className="mb-8 text-[15px] text-muted-foreground">
        One command. Your device starts resolving TNP domains immediately.
      </p>

      {clientInfo && (
        <p className="mb-4 text-sm text-muted-foreground">
          Latest version: {clientInfo.version}
        </p>
      )}

      <CodeBlock code={installCommand} className="mb-8" />

      <div className="mb-6 flex gap-2">
        {platforms.map((p) => (
          <button
            key={p.id}
            onClick={() => setPlatform(p.id)}
            className={`cursor-pointer rounded-[10px] px-3 py-1.5 text-sm font-medium transition-colors ${
              platform === p.id
                ? "bg-primary text-primary-foreground"
                : "border border-border text-muted-foreground hover:bg-surface hover:text-foreground"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-surface p-5 space-y-4">
        {platform === "macos" && (
          <>
            <h3 className="font-medium">macOS</h3>
            <p className="text-sm text-muted-foreground">
              The installer configures your system DNS resolver to query TNP nameservers for
              TNP domains, while forwarding everything else to your default resolver.
            </p>
            <div className="space-y-1 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Requirements:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>macOS 12 Monterey or later</li>
                <li>Admin password (the installer sets up a resolver config)</li>
              </ul>
            </div>
          </>
        )}
        {platform === "linux" && (
          <>
            <h3 className="font-medium">Linux</h3>
            <p className="text-sm text-muted-foreground">
              Works with systemd-resolved, NetworkManager, and standalone resolv.conf setups.
              The installer detects your DNS configuration automatically.
            </p>
            <div className="space-y-1 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">Requirements:</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>Any modern Linux distribution</li>
                <li>sudo access</li>
              </ul>
            </div>
          </>
        )}
        {platform === "windows" && (
          <>
            <h3 className="font-medium">Windows</h3>
            <p className="text-sm text-muted-foreground">
              Windows support is coming soon.
            </p>
          </>
        )}
      </div>

      <div className="mt-8 space-y-4">
        <h3 className="font-medium">What happens after install</h3>
        <ol className="list-decimal pl-5 space-y-2 text-sm text-muted-foreground">
          <li>The TNP daemon installs as a background service</li>
          <li>Your system DNS resolver is configured to forward TNP TLD queries to TNP root servers</li>
          <li>All other DNS queries are forwarded to 1.1.1.1 untouched</li>
          <li>TNP domains resolve natively in every app -- browsers, curl, everything</li>
        </ol>
      </div>

      <div className="mt-8">
        <a
          href="/register"
          className="text-sm text-primary transition-colors hover:text-primary/80"
        >
          Get a domain to point to your server
        </a>
      </div>
    </div>
  );
}
