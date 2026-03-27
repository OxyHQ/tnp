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
    <div className="mx-auto max-w-[640px] px-4 py-16">
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

      <div className="mb-8 flex items-center justify-between rounded-xl border border-border bg-surface px-4 py-3">
        <code className="font-mono text-sm text-primary">{installCommand}</code>
        <button
          onClick={copyCommand}
          className="ml-3 cursor-pointer rounded-[10px] border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

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

      <div className="mt-8">
        <a
          href="https://oxy.so/tnp"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          Learn more about TNP on oxy.so
        </a>
      </div>
    </div>
  );
}
