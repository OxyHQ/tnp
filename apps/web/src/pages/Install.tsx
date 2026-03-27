import { useState, useEffect } from "react";
import { Helmet } from "react-helmet-async";
import { apiFetch } from "../lib/api";

type Platform = "macos" | "linux" | "windows" | "android" | "ios";
type SetupMethod = "dns" | "client";

const dnsPlatforms: { id: Platform; label: string }[] = [
  { id: "android", label: "Android" },
  { id: "ios", label: "iOS" },
  { id: "windows", label: "Windows" },
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
];

const clientPlatforms: { id: Platform; label: string }[] = [
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
  { id: "windows", label: "Windows" },
];

const DNS_IP = "161.35.80.14";
const DNS_HOST = "dns.tnp.network";

interface ClientInfo {
  version: string;
  changelog: string;
  platforms: Record<string, { url: string; sha256: string } | null>;
}

export default function Install() {
  const [method, setMethod] = useState<SetupMethod>("dns");
  const [dnsPlatform, setDnsPlatform] = useState<Platform>("android");
  const [clientPlatform, setClientPlatform] = useState<Platform>("macos");
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
        <meta name="description" content="Set up TNP to resolve TNP domains on any device. Change your DNS or install the TNP client." />
        <link rel="canonical" href="https://tnp.network/install" />
        <meta property="og:title" content="Install TNP — The Network Protocol" />
        <meta property="og:description" content="Set up TNP to resolve TNP domains on any device." />
        <meta property="og:url" content="https://tnp.network/install" />
      </Helmet>
      <h1 className="mb-2 font-pixel text-xl text-accent">
        Set Up TNP
      </h1>
      <p className="mb-8 font-mono text-sm text-muted">
        Resolve TNP domains on any device. Pick a method below.
      </p>

      <div className="mb-8 flex gap-3">
        <button
          onClick={() => setMethod("dns")}
          className={`cursor-pointer rounded-lg px-4 py-2 font-mono text-sm transition-colors ${
            method === "dns"
              ? "border border-accent/30 bg-accent/10 text-accent"
              : "border border-edge text-muted hover:text-secondary"
          }`}
        >
          Change DNS (no install)
        </button>
        <button
          onClick={() => setMethod("client")}
          className={`cursor-pointer rounded-lg px-4 py-2 font-mono text-sm transition-colors ${
            method === "client"
              ? "border border-accent/30 bg-accent/10 text-accent"
              : "border border-edge text-muted hover:text-secondary"
          }`}
        >
          Install TNP Client
        </button>
      </div>

      {method === "dns" && (
        <>
          <p className="mb-6 font-mono text-xs text-muted">
            Point your device's DNS to the TNP resolver. TNP domains resolve
            natively, everything else forwards to Cloudflare (1.1.1.1).
          </p>

          <div className="mb-6 flex flex-wrap gap-2">
            {dnsPlatforms.map((p) => (
              <button
                key={p.id}
                onClick={() => setDnsPlatform(p.id)}
                className={`cursor-pointer rounded-md px-3 py-1.5 font-mono text-sm transition-colors ${
                  dnsPlatform === p.id
                    ? "border border-accent/30 bg-accent/10 text-accent"
                    : "border border-edge text-muted hover:text-secondary"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="rounded-lg border border-edge bg-surface-card p-5 space-y-4">
            {dnsPlatform === "android" && (
              <>
                <h3 className="font-mono text-sm font-medium text-primary">Android</h3>
                <ol className="list-decimal pl-5 space-y-2 font-mono text-xs text-muted">
                  <li>Open <span className="text-secondary">Settings</span></li>
                  <li>Tap <span className="text-secondary">Network & internet</span> (or <span className="text-secondary">Connections</span>)</li>
                  <li>Tap <span className="text-secondary">Private DNS</span></li>
                  <li>Select <span className="text-secondary">Private DNS provider hostname</span></li>
                  <li>Enter <code className="rounded bg-surface px-1.5 py-0.5 text-accent">{DNS_HOST}</code></li>
                  <li>Tap <span className="text-secondary">Save</span></li>
                </ol>
                <p className="font-mono text-xs text-muted">
                  Requires Android 9+ with Private DNS support (DNS-over-TLS).
                  Alternatively, set your Wi-Fi DNS to <code className="rounded bg-surface px-1.5 py-0.5 text-accent">{DNS_IP}</code>.
                </p>
              </>
            )}
            {dnsPlatform === "ios" && (
              <>
                <h3 className="font-mono text-sm font-medium text-primary">iOS / iPadOS</h3>
                <ol className="list-decimal pl-5 space-y-2 font-mono text-xs text-muted">
                  <li>Open <span className="text-secondary">Settings</span></li>
                  <li>Tap <span className="text-secondary">Wi-Fi</span></li>
                  <li>Tap the <span className="text-secondary">(i)</span> next to your network</li>
                  <li>Tap <span className="text-secondary">Configure DNS</span></li>
                  <li>Select <span className="text-secondary">Manual</span></li>
                  <li>Remove existing servers, add <code className="rounded bg-surface px-1.5 py-0.5 text-accent">{DNS_IP}</code></li>
                  <li>Tap <span className="text-secondary">Save</span></li>
                </ol>
                <p className="font-mono text-xs text-muted">
                  Note: this only applies to the current Wi-Fi network. For system-wide
                  DNS, install the TNP client instead.
                </p>
              </>
            )}
            {dnsPlatform === "windows" && (
              <>
                <h3 className="font-mono text-sm font-medium text-primary">Windows</h3>
                <ol className="list-decimal pl-5 space-y-2 font-mono text-xs text-muted">
                  <li>Open <span className="text-secondary">Settings &gt; Network & Internet</span></li>
                  <li>Click your active connection (Wi-Fi or Ethernet)</li>
                  <li>Click <span className="text-secondary">Hardware properties</span></li>
                  <li>Next to DNS server assignment, click <span className="text-secondary">Edit</span></li>
                  <li>Select <span className="text-secondary">Manual</span>, enable <span className="text-secondary">IPv4</span></li>
                  <li>Set Preferred DNS to <code className="rounded bg-surface px-1.5 py-0.5 text-accent">{DNS_IP}</code></li>
                  <li>Click <span className="text-secondary">Save</span></li>
                </ol>
              </>
            )}
            {dnsPlatform === "macos" && (
              <>
                <h3 className="font-mono text-sm font-medium text-primary">macOS</h3>
                <ol className="list-decimal pl-5 space-y-2 font-mono text-xs text-muted">
                  <li>Open <span className="text-secondary">System Settings &gt; Network</span></li>
                  <li>Select your active connection (Wi-Fi or Ethernet)</li>
                  <li>Click <span className="text-secondary">Details...</span></li>
                  <li>Click <span className="text-secondary">DNS</span> in the sidebar</li>
                  <li>Click <span className="text-secondary">+</span> and add <code className="rounded bg-surface px-1.5 py-0.5 text-accent">{DNS_IP}</code></li>
                  <li>Click <span className="text-secondary">OK</span></li>
                </ol>
              </>
            )}
            {dnsPlatform === "linux" && (
              <>
                <h3 className="font-mono text-sm font-medium text-primary">Linux</h3>
                <div className="space-y-3">
                  <div>
                    <p className="mb-1 font-medium text-secondary">systemd-resolved (Ubuntu, Fedora, etc.):</p>
                    <code className="block rounded bg-surface px-3 py-2 text-xs text-accent">
                      sudo resolvectl dns eth0 {DNS_IP}
                    </code>
                  </div>
                  <div>
                    <p className="mb-1 font-medium text-secondary">resolv.conf (manual):</p>
                    <code className="block rounded bg-surface px-3 py-2 text-xs text-accent">
                      echo "nameserver {DNS_IP}" | sudo tee /etc/resolv.conf
                    </code>
                  </div>
                  <div>
                    <p className="mb-1 font-medium text-secondary">NetworkManager:</p>
                    <p className="text-xs text-muted">
                      Open Settings &gt; Network &gt; your connection &gt; IPv4 &gt;
                      set DNS to <code className="rounded bg-surface px-1.5 py-0.5 text-accent">{DNS_IP}</code>
                    </p>
                  </div>
                </div>
              </>
            )}
          </div>
        </>
      )}

      {method === "client" && (
        <>
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
            {clientPlatforms.map((p) => (
              <button
                key={p.id}
                onClick={() => setClientPlatform(p.id)}
                className={`cursor-pointer rounded-md px-3 py-1.5 font-mono text-sm transition-colors ${
                  clientPlatform === p.id
                    ? "border border-accent/30 bg-accent/10 text-accent"
                    : "border border-edge text-muted hover:text-secondary"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="rounded-lg border border-edge bg-surface-card p-5 space-y-4">
            {clientPlatform === "macos" && (
              <>
                <h3 className="font-mono text-sm font-medium text-primary">macOS</h3>
                <p className="font-mono text-xs text-muted">
                  The client runs a local DNS proxy that intercepts only TNP domains.
                  All other DNS queries go through your normal resolver untouched.
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
            {clientPlatform === "linux" && (
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
            {clientPlatform === "windows" && (
              <>
                <h3 className="font-mono text-sm font-medium text-primary">Windows</h3>
                <p className="font-mono text-xs text-muted">
                  Windows support is coming soon.
                </p>
              </>
            )}
          </div>

          <p className="mt-4 font-mono text-xs text-muted">
            The client only intercepts TNP domains — your regular DNS stays unchanged.
            This is the recommended setup for desktop devices.
          </p>
        </>
      )}

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
