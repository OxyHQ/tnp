import { useState, useEffect, useCallback } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";

interface ServiceNode {
  publicKey: string;
  connectedRelay: string;
  status: "online" | "offline";
  lastSeen?: string;
}

interface Domain {
  _id: string;
  name: string;
  tld: string;
  status: string;
  serviceNodeId?: string;
}

interface DomainWithNode {
  domain: Domain;
  node: ServiceNode | null;
  loading: boolean;
}

export default function ServiceNodes() {
  const [entries, setEntries] = useState<DomainWithNode[]>([]);
  const [domainsLoading, setDomainsLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);

  const fetchDomains = useCallback(() => {
    setDomainsLoading(true);
    apiFetch<Domain[]>("/domains/mine")
      .then((domains) => {
        setEntries(
          domains.map((domain) => ({ domain, node: null, loading: true }))
        );
        setDomainsLoading(false);

        domains.forEach((domain) => {
          apiFetch<ServiceNode>(`/nodes/${domain.name}.${domain.tld}`)
            .then((node) => {
              setEntries((prev) =>
                prev.map((e) =>
                  e.domain._id === domain._id
                    ? { ...e, node, loading: false }
                    : e
                )
              );
            })
            .catch(() => {
              setEntries((prev) =>
                prev.map((e) =>
                  e.domain._id === domain._id
                    ? { ...e, node: null, loading: false }
                    : e
                )
              );
            });
        });
      })
      .catch(() => {
        setDomainsLoading(false);
      });
  }, []);

  useEffect(() => {
    fetchDomains();
  }, [fetchDomains]);

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const truncateKey = (key: string): string => {
    if (key.length <= 20) return key;
    return `${key.slice(0, 10)}...${key.slice(-10)}`;
  };

  const formatTimestamp = (ts: string): string => {
    const date = new Date(ts);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);

    if (diffSec < 60) return `${diffSec}s ago`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>Service Nodes — TNP</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="mb-8 flex gap-3">
        <Link
          to="/dashboard"
          className="cursor-pointer rounded-lg px-4 py-2 font-mono text-sm transition-colors border border-edge text-muted hover:text-secondary"
        >
          Domains
        </Link>
        <Link
          to="/service-nodes"
          className="cursor-pointer rounded-lg px-4 py-2 font-mono text-sm transition-colors border border-accent/30 bg-accent/10 text-accent"
        >
          Service Nodes
        </Link>
      </div>

      <h1 className="mb-2 font-pixel text-xl text-accent">Service Nodes</h1>
      <p className="mb-8 font-mono text-sm text-muted">
        Service nodes make your domains reachable over the TNP overlay network
        -- no port forwarding or public IP needed.
      </p>

      {domainsLoading ? (
        <p className="font-mono text-sm text-muted">Loading domains...</p>
      ) : entries.length === 0 ? (
        <div className="rounded-lg border border-edge bg-surface-card p-6">
          <p className="font-mono text-sm text-muted">
            You have no domains yet.{" "}
            <Link
              to="/register"
              className="text-accent transition-colors hover:text-primary"
            >
              Register one
            </Link>{" "}
            to get started.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map(({ domain, node, loading }) => (
            <div
              key={domain._id}
              className="rounded-lg border border-edge bg-surface-card p-4"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      loading
                        ? "bg-yellow-400"
                        : node?.status === "online"
                          ? "bg-green-400"
                          : "bg-gray-500"
                    }`}
                    title={
                      loading
                        ? "Checking..."
                        : node?.status === "online"
                          ? "Online"
                          : "Offline"
                    }
                  />
                  <span className="font-mono text-sm">
                    {domain.name}
                    <span className="text-accent">.{domain.tld}</span>
                  </span>
                  <span
                    className={`rounded-md px-2.5 py-0.5 font-mono text-xs font-medium ${
                      loading
                        ? "bg-surface-hover text-muted"
                        : node?.status === "online"
                          ? "bg-accent/10 text-accent"
                          : "bg-surface-hover text-muted"
                    }`}
                  >
                    {loading ? "checking" : node?.status ?? "no node"}
                  </span>
                </div>
                {node?.lastSeen && (
                  <span className="font-mono text-xs text-muted">
                    last seen {formatTimestamp(node.lastSeen)}
                  </span>
                )}
              </div>

              {node && !loading && (
                <div className="mt-3 space-y-2 border-t border-edge pt-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-muted">
                      Public key:
                    </span>
                    <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs text-secondary">
                      {truncateKey(node.publicKey)}
                    </code>
                    <button
                      onClick={() =>
                        copyToClipboard(node.publicKey, domain._id)
                      }
                      className="cursor-pointer font-mono text-xs text-muted transition-colors hover:text-secondary"
                    >
                      [{copied === domain._id ? "copied" : "copy"}]
                    </button>
                  </div>
                  {node.connectedRelay && (
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted">
                        Relay:
                      </span>
                      <code className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs text-secondary">
                        {node.connectedRelay}
                      </code>
                    </div>
                  )}
                </div>
              )}

              {!node && !loading && (
                <p className="mt-3 border-t border-edge pt-3 font-mono text-xs text-muted">
                  No service node configured. See the setup instructions below.
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-12 rounded-lg border border-edge bg-surface-card p-5 space-y-4">
        <h2 className="font-pixel text-lg text-accent">Setup Instructions</h2>
        <p className="font-mono text-xs text-muted">
          To expose a local service through the TNP overlay network, run the TNP
          client in serve mode. Your service becomes reachable at your domain
          without port forwarding or a public IP.
        </p>

        <div className="space-y-3">
          <div>
            <p className="mb-1 font-mono text-xs font-medium text-secondary">
              1. Install the TNP client
            </p>
            <code className="block rounded bg-surface px-3 py-2 font-mono text-xs text-accent">
              curl -fsSL https://get.tnp.network | sh
            </code>
          </div>

          <div>
            <p className="mb-1 font-mono text-xs font-medium text-secondary">
              2. Start a service node
            </p>
            <code className="block rounded bg-surface px-3 py-2 font-mono text-xs text-accent">
              tnp serve --domain example.ox --target localhost:80 --token
              &lt;your-token&gt;
            </code>
          </div>

          <div>
            <p className="mb-1 font-mono text-xs font-medium text-secondary">
              3. Get your auth token
            </p>
            <p className="font-mono text-xs text-muted">
              Run{" "}
              <code className="rounded bg-surface px-1.5 py-0.5 text-accent">
                tnp auth login
              </code>{" "}
              to authenticate with your Oxy account. The token is stored locally
              and used for subsequent commands.
            </p>
          </div>
        </div>

        <p className="font-mono text-xs text-muted">
          The service node registers with a relay server and accepts incoming
          connections over encrypted tunnels. Replace{" "}
          <code className="rounded bg-surface px-1.5 py-0.5 text-accent">
            example.ox
          </code>{" "}
          with your actual domain and{" "}
          <code className="rounded bg-surface px-1.5 py-0.5 text-accent">
            localhost:80
          </code>{" "}
          with the local address of your service.
        </p>
      </div>
    </div>
  );
}
