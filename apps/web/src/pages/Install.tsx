import { useState, useEffect, useCallback } from "react";
import { Helmet } from "react-helmet-async";
import { Trans, useTranslation } from "react-i18next";
import { apiFetch } from "../lib/api";

type Platform = "macos" | "linux" | "windows" | "android" | "ios" | "router";
type SetupMethod = "dns" | "client" | "serve" | "relay";
type CopiedField = "unix" | "windows" | null;

const dnsPlatforms: { id: Platform; label: string }[] = [
  { id: "android", label: "Android" },
  { id: "ios", label: "iOS" },
  { id: "windows", label: "Windows" },
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
  { id: "router", label: "Router" },
];

const clientPlatforms: { id: Platform; label: string }[] = [
  { id: "macos", label: "macOS" },
  { id: "linux", label: "Linux" },
  { id: "windows", label: "Windows" },
];

const DNS_IP = "174.138.10.81";
const DNS_PORT = "5353";
const DNS_HOST = "dns.tnp.network";
const INSTALL_CMD_UNIX = "curl -fsSL https://get.tnp.network | sh";
const INSTALL_CMD_WINDOWS = "irm https://get.tnp.network/ps | iex";

interface ClientInfo {
  version: string;
  changelog: string;
  platforms: Record<string, { url: string; sha256: string } | null>;
}

export default function Install() {
  const { t } = useTranslation(["install", "common"]);
  const [method, setMethod] = useState<SetupMethod>("dns");
  const [dnsPlatform, setDnsPlatform] = useState<Platform>("android");
  const [clientPlatform, setClientPlatform] = useState<Platform>("macos");
  const [clientInfo, setClientInfo] = useState<ClientInfo | null>(null);
  const [copied, setCopied] = useState<CopiedField>(null);

  useEffect(() => {
    let ignore = false;
    apiFetch<ClientInfo>("/client/latest")
      .then((data) => {
        if (!ignore) setClientInfo(data);
      })
      .catch(() => {});
    return () => { ignore = true; };
  }, []);

  const copyCommand = useCallback((command: string, field: CopiedField) => {
    navigator.clipboard.writeText(command);
    setCopied(field);
    setTimeout(() => setCopied(null), 2000);
  }, []);

  const methodKeys: SetupMethod[] = ["dns", "client", "serve", "relay"];

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>{t("install:meta.title")}</title>
        <meta name="description" content={t("install:meta.description")} />
        <link rel="canonical" href="https://tnp.network/install" />
        <meta property="og:title" content={t("install:meta.ogTitle")} />
        <meta property="og:description" content={t("install:meta.ogDescription")} />
        <meta property="og:url" content="https://tnp.network/install" />
      </Helmet>
      <h1 className="mb-2 font-pixel text-xl text-accent">
        {t("install:title")}
      </h1>
      <p className="mb-8 font-mono text-sm text-muted">
        {t("install:subtitle")}
      </p>

      <div className="mb-8 flex gap-3">
        {methodKeys.map((key) => (
          <button
            key={key}
            onClick={() => setMethod(key)}
            className={`cursor-pointer rounded-lg px-4 py-2 font-mono text-sm transition-colors ${
              method === key
                ? "border border-accent/30 bg-accent/10 text-accent"
                : "border border-edge text-muted hover:text-secondary"
            }`}
          >
            {t(`install:methods.${key}`)}
          </button>
        ))}
      </div>

      {method === "dns" && (
        <>
          <p className="mb-6 font-mono text-xs text-muted">
            {t("install:dns.intro", { dnsPort: DNS_PORT, dnsIp: DNS_IP })}
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
                <h3 className="font-mono text-sm font-medium text-primary">{t("install:dns.android.title")}</h3>
                <ol className="list-decimal pl-5 space-y-2 font-mono text-xs text-muted">
                  {(t("install:dns.android.steps", { returnObjects: true, dnsHost: DNS_HOST, dnsIp: DNS_IP }) as string[]).map((_, i) => (
                    <li key={i}>
                      <Trans
                        i18nKey={`install:dns.android.steps.${i}`}
                        t={t}
                        values={{ dnsHost: DNS_HOST, dnsIp: DNS_IP }}
                        components={{
                          accent: <span className="text-secondary" />,
                          code: <code className="rounded bg-surface px-1.5 py-0.5 text-accent" />,
                        }}
                      />
                    </li>
                  ))}
                </ol>
                <p className="font-mono text-xs text-muted">
                  <Trans
                    i18nKey="install:dns.android.note"
                    t={t}
                    values={{ dnsIp: DNS_IP }}
                    components={{ code: <code className="rounded bg-surface px-1.5 py-0.5 text-accent" /> }}
                  />
                </p>
              </>
            )}
            {dnsPlatform === "ios" && (
              <>
                <h3 className="font-mono text-sm font-medium text-primary">{t("install:dns.ios.title")}</h3>
                <ol className="list-decimal pl-5 space-y-2 font-mono text-xs text-muted">
                  {(t("install:dns.ios.steps", { returnObjects: true, dnsIp: DNS_IP }) as string[]).map((_, i) => (
                    <li key={i}>
                      <Trans
                        i18nKey={`install:dns.ios.steps.${i}`}
                        t={t}
                        values={{ dnsIp: DNS_IP }}
                        components={{
                          accent: <span className="text-secondary" />,
                          code: <code className="rounded bg-surface px-1.5 py-0.5 text-accent" />,
                        }}
                      />
                    </li>
                  ))}
                </ol>
                <p className="font-mono text-xs text-muted">
                  {t("install:dns.ios.note")}
                </p>
              </>
            )}
            {dnsPlatform === "windows" && (
              <>
                <h3 className="font-mono text-sm font-medium text-primary">{t("install:dns.windows.title")}</h3>
                <ol className="list-decimal pl-5 space-y-2 font-mono text-xs text-muted">
                  {(t("install:dns.windows.steps", { returnObjects: true, dnsIp: DNS_IP }) as string[]).map((_, i) => (
                    <li key={i}>
                      <Trans
                        i18nKey={`install:dns.windows.steps.${i}`}
                        t={t}
                        values={{ dnsIp: DNS_IP }}
                        components={{
                          accent: <span className="text-secondary" />,
                          code: <code className="rounded bg-surface px-1.5 py-0.5 text-accent" />,
                        }}
                      />
                    </li>
                  ))}
                </ol>
              </>
            )}
            {dnsPlatform === "macos" && (
              <>
                <h3 className="font-mono text-sm font-medium text-primary">{t("install:dns.macos.title")}</h3>
                <ol className="list-decimal pl-5 space-y-2 font-mono text-xs text-muted">
                  {(t("install:dns.macos.steps", { returnObjects: true, dnsIp: DNS_IP }) as string[]).map((_, i) => (
                    <li key={i}>
                      <Trans
                        i18nKey={`install:dns.macos.steps.${i}`}
                        t={t}
                        values={{ dnsIp: DNS_IP }}
                        components={{
                          accent: <span className="text-secondary" />,
                          code: <code className="rounded bg-surface px-1.5 py-0.5 text-accent" />,
                        }}
                      />
                    </li>
                  ))}
                </ol>
              </>
            )}
            {dnsPlatform === "linux" && (
              <>
                <h3 className="font-mono text-sm font-medium text-primary">{t("install:dns.linux.title")}</h3>
                <div className="space-y-3">
                  <div>
                    <p className="mb-1 font-medium text-secondary">systemd-resolved (Ubuntu, Fedora, Debian):</p>
                    <p className="mb-2 text-xs text-muted">
                      If <code className="rounded bg-surface px-1.5 py-0.5 text-accent">resolvectl</code> is not found, install it first:
                    </p>
                    <code className="block rounded bg-surface px-3 py-2 text-xs text-accent mb-2">
                      sudo apt install systemd-resolved   # Debian/Ubuntu
                    </code>
                    <p className="mb-1 text-xs text-muted">Then configure DNS:</p>
                    <code className="block rounded bg-surface px-3 py-2 text-xs text-accent">
                      sudo resolvectl dns eth0 {DNS_IP} && sudo resolvectl dnsovertls eth0 no
                    </code>
                  </div>
                  <div>
                    <p className="mb-1 font-medium text-secondary">resolv.conf (any distro):</p>
                    <code className="block rounded bg-surface px-3 py-2 text-xs text-accent">
                      echo "nameserver {DNS_IP}" | sudo tee /etc/resolv.conf  # port 53 only
                    </code>
                  </div>
                  <div>
                    <p className="mb-1 font-medium text-secondary">NetworkManager (GUI):</p>
                    <p className="text-xs text-muted">
                      <Trans
                        i18nKey="install:dns.linux.networkManagerDesc"
                        t={t}
                        values={{ dnsIp: DNS_IP }}
                        components={{ code: <code className="rounded bg-surface px-1.5 py-0.5 text-accent" /> }}
                      />
                    </p>
                  </div>
                </div>
              </>
            )}
            {dnsPlatform === "router" && (
              <>
                <h3 className="font-mono text-sm font-medium text-primary">{t("install:dns.router.title")}</h3>
                <p className="font-mono text-xs text-muted">
                  {t("install:dns.router.intro")}
                </p>
                <ol className="list-decimal pl-5 space-y-2 font-mono text-xs text-muted">
                  {(t("install:dns.router.steps", { returnObjects: true, dnsIp: DNS_IP }) as string[]).map((_, i) => (
                    <li key={i}>
                      <Trans
                        i18nKey={`install:dns.router.steps.${i}`}
                        t={t}
                        values={{ dnsIp: DNS_IP }}
                        components={{
                          accent: <span className="text-secondary" />,
                          code: <code className="rounded bg-surface px-1.5 py-0.5 text-accent" />,
                          code1: <code className="rounded bg-surface px-1.5 py-0.5 text-accent" />,
                          code2: <code className="rounded bg-surface px-1.5 py-0.5 text-accent" />,
                        }}
                      />
                    </li>
                  ))}
                </ol>
                <p className="font-mono text-xs text-muted">
                  {t("install:dns.router.note")}
                </p>
              </>
            )}
          </div>
        </>
      )}

      {method === "client" && (
        <>
          {clientInfo && (
            <p className="mb-4 font-mono text-xs text-muted">
              {t("install:client.latestVersion", { version: clientInfo.version })}
            </p>
          )}

          <div className="mb-8 space-y-3">
            <div className="rounded-lg border border-edge bg-surface-card px-4 py-3">
              <p className="mb-2 font-mono text-xs font-medium text-secondary">macOS / Linux</p>
              <div className="flex items-center justify-between">
                <code className="font-mono text-sm text-accent">{INSTALL_CMD_UNIX}</code>
                <button
                  onClick={() => copyCommand(INSTALL_CMD_UNIX, "unix")}
                  className="ml-3 shrink-0 cursor-pointer font-mono text-xs text-muted transition-colors hover:text-secondary"
                >
                  [{copied === "unix" ? t("common:copied") : t("common:copy")}]
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-edge bg-surface-card px-4 py-3">
              <p className="mb-2 font-mono text-xs font-medium text-secondary">Windows (PowerShell)</p>
              <div className="flex items-center justify-between">
                <code className="font-mono text-sm text-accent">{INSTALL_CMD_WINDOWS}</code>
                <button
                  onClick={() => copyCommand(INSTALL_CMD_WINDOWS, "windows")}
                  className="ml-3 shrink-0 cursor-pointer font-mono text-xs text-muted transition-colors hover:text-secondary"
                >
                  [{copied === "windows" ? t("common:copied") : t("common:copy")}]
                </button>
              </div>
            </div>
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
                <h3 className="font-mono text-sm font-medium text-primary">{t("install:client.macos.title")}</h3>
                <p className="font-mono text-xs text-muted">
                  {t("install:client.macos.description")}
                </p>
                <div className="space-y-1 font-mono text-xs text-muted">
                  <p className="font-medium text-secondary">{t("install:client.macos.requirementsTitle")}</p>
                  <ul className="list-disc pl-5 space-y-1">
                    {(t("install:client.macos.requirements", { returnObjects: true }) as string[]).map((req, i) => (
                      <li key={i}>{req}</li>
                    ))}
                  </ul>
                </div>
              </>
            )}
            {clientPlatform === "linux" && (
              <>
                <h3 className="font-mono text-sm font-medium text-primary">{t("install:client.linux.title")}</h3>
                <p className="font-mono text-xs text-muted">
                  {t("install:client.linux.description")}
                </p>
                <div className="space-y-1 font-mono text-xs text-muted">
                  <p className="font-medium text-secondary">{t("install:client.linux.requirementsTitle")}</p>
                  <ul className="list-disc pl-5 space-y-1">
                    {(t("install:client.linux.requirements", { returnObjects: true }) as string[]).map((req, i) => (
                      <li key={i}>{req}</li>
                    ))}
                  </ul>
                </div>
              </>
            )}
            {clientPlatform === "windows" && (
              <>
                <h3 className="font-mono text-sm font-medium text-primary">{t("install:client.windows.title")}</h3>
                <p className="font-mono text-xs text-muted">
                  {t("install:client.windows.description")}
                </p>
              </>
            )}
          </div>

          <p className="mt-4 font-mono text-xs text-muted">
            {t("install:client.intro")}
          </p>
        </>
      )}

      {method === "serve" && (
        <>
          <p className="mb-6 font-mono text-xs text-muted">
            {t("install:serve.intro")}
          </p>

          <div className="rounded-lg border border-edge bg-surface-card p-5 space-y-4">
            <h3 className="font-mono text-sm font-medium text-primary">{t("install:serve.heading")}</h3>

            <div className="space-y-3">
              <div>
                <p className="mb-1 font-mono text-xs font-medium text-secondary">{t("install:serve.step1Title")}</p>
                <code className="block rounded bg-surface px-3 py-2 text-xs text-accent">
                  curl -fsSL https://get.tnp.network | sh
                </code>
              </div>

              <div>
                <p className="mb-1 font-mono text-xs font-medium text-secondary">{t("install:serve.step2Title")}</p>
                <code className="block rounded bg-surface px-3 py-2 text-xs text-accent">
                  tnp auth login
                </code>
                <p className="mt-1 font-mono text-xs text-muted">
                  {t("install:serve.step2Desc")}
                </p>
              </div>

              <div>
                <p className="mb-1 font-mono text-xs font-medium text-secondary">{t("install:serve.step3Title")}</p>
                <code className="block rounded bg-surface px-3 py-2 text-xs text-accent">
                  tnp serve --domain example.ox --target localhost:80 --token &lt;your-token&gt;
                </code>
                <p className="mt-1 font-mono text-xs text-muted">
                  <Trans
                    i18nKey="install:serve.step3Desc"
                    t={t}
                    components={{
                      code1: <code className="rounded bg-surface px-1.5 py-0.5 text-accent" />,
                      code2: <code className="rounded bg-surface px-1.5 py-0.5 text-accent" />,
                    }}
                  />
                </p>
              </div>
            </div>

            <div className="border-t border-edge pt-4">
              <p className="font-mono text-xs font-medium text-secondary">{t("install:serve.howItWorks")}</p>
              <ul className="mt-2 list-disc pl-5 space-y-1.5 font-mono text-xs text-muted">
                {(t("install:serve.howItWorksList", { returnObjects: true }) as string[]).map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </>
      )}

      {method === "relay" && (
        <>
          <p className="mb-6 font-mono text-xs text-muted">
            {t("install:relay.intro")}
          </p>

          <div className="rounded-lg border border-edge bg-surface-card p-5 space-y-4">
            <h3 className="font-mono text-sm font-medium text-primary">{t("install:relay.whatRelaysDo")}</h3>
            <ul className="list-disc pl-5 space-y-1.5 font-mono text-xs text-muted">
              {(t("install:relay.whatRelaysDoList", { returnObjects: true }) as string[]).map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>

          <div className="mt-4 rounded-lg border border-edge bg-surface-card p-5 space-y-4">
            <h3 className="font-mono text-sm font-medium text-primary">{t("install:relay.communityRelay")}</h3>
            <p className="font-mono text-xs text-muted">
              {t("install:relay.communityRelayDesc")}
            </p>

            <div className="space-y-3">
              <div>
                <p className="mb-1 font-mono text-xs font-medium text-secondary">{t("install:relay.step1Title")}</p>
                <code className="block rounded bg-surface px-3 py-2 text-xs text-accent">
                  git clone https://github.com/OxyHQ/tnp && cd tnp/apps/relay
                </code>
              </div>
              <div>
                <p className="mb-1 font-mono text-xs font-medium text-secondary">{t("install:relay.step2Title")}</p>
                <code className="block rounded bg-surface px-3 py-2 text-xs text-accent">
                  cp .env.example .env && bun run start
                </code>
              </div>
              <div>
                <p className="mb-1 font-mono text-xs font-medium text-secondary">{t("install:relay.step3Title")}</p>
                <p className="font-mono text-xs text-muted">
                  <Trans
                    i18nKey="install:relay.step3Desc"
                    t={t}
                    components={{ link: <a href="/network" className="text-accent transition-colors hover:text-primary" /> }}
                  />
                </p>
              </div>
            </div>

            <p className="font-mono text-xs text-muted">
              <Trans
                i18nKey="install:relay.githubNote"
                t={t}
                components={{
                  link: (
                    <a
                      href="https://github.com/OxyHQ/tnp"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent transition-colors hover:text-primary"
                    />
                  ),
                }}
              />
            </p>
          </div>
        </>
      )}

      <div className="mt-8">
        <a
          href="https://oxy.so/tnp"
          className="font-mono text-sm text-muted transition-colors hover:text-secondary"
        >
          [{t("install:learnMore")}]
        </a>
      </div>
    </div>
  );
}
