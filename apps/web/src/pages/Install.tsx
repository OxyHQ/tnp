import { useState, useEffect, useCallback, type ReactElement } from 'react';
import { Helmet } from 'react-helmet-async';
import { Trans, useTranslation } from 'react-i18next';
import type { ClientLatestResponse } from '@tnp/shared-types';
import { apiFetch } from '../lib/api';

type DnsPlatform = 'router' | 'windows' | 'macos' | 'linux' | 'mobile';
type ClientPlatform = 'macos' | 'linux' | 'windows';
type SetupMethod = 'dns' | 'client' | 'serve' | 'relay';

// Router first: one forwarding rule there covers every device on the network,
// phones included, and phones have no per-domain option of their own.
const dnsPlatforms: DnsPlatform[] = ['router', 'windows', 'macos', 'linux', 'mobile'];
const OS_LABELS: Record<ClientPlatform, string> = {
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
};
const clientPlatforms: ClientPlatform[] = ['macos', 'linux', 'windows'];

/**
 * The TLD the manual steps forward to the TNP resolver. Mirrors
 * `BUILTIN_NATIVE_TLDS` in `@tnp/namespace`, which is what the client routes.
 * Only this TLD may ever appear here: forwarding a public TLD to TNP would
 * shadow public DNS (docs/architecture/naming.md).
 */
const FORWARDED_TLD = 'ox';
/** Shown in commands until the resolver address has loaded. */
const IP_PLACEHOLDER = 'RESOLVER_IP';
const INSTALL_CMD_UNIX = 'curl -fsSL https://get.tnp.network | sh';
const INSTALL_CMD_WINDOWS = 'irm https://get.tnp.network/ps | iex';

type ClientInfo = ClientLatestResponse;

/**
 * The resolver address as served by the API, or null if it is missing or not
 * an IP literal. Every config below needs an IP: NRPT, /etc/resolver, dnsmasq
 * and resolved all reject a hostname, so the hostname is never a fallback.
 */
function resolverIp(info: ClientInfo | null): string | null {
  const ip = info?.dns?.ip?.trim();
  if (!ip) return null;
  const v4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  if (v4.test(ip)) return ip;
  // The URL parser implements the full IPv6 grammar (group counts, `::`).
  if (!ip.includes(':') || !/^[0-9a-fA-F:.]+$/.test(ip)) return null;
  try {
    new URL(`http://[${ip}]/`);
    return ip;
  } catch {
    return null;
  }
}

/**
 * Marks what the manual steps add, so undo removes exactly that — never the
 * client's own NRPT rule, resolver file or delegate — whatever the resolver
 * address was at setup time.
 */
const MANUAL_MARKER = 'Added manually from tnp.network/install';
/** Not the client's `tnp.dns-delegate`: each side owns, and removes, its own file. */
const MANUAL_DELEGATE = '/etc/systemd/dns-delegate.d/tnp-manual.dns-delegate';

const inlineCode = <code className="rounded bg-background px-1.5 py-0.5 text-primary-text" />;
const accent = <span className="text-muted-foreground" />;
const proseClass = 'font-mono text-xs text-muted-foreground/70';
const subheadClass = 'mb-1 font-mono text-xs font-medium text-muted-foreground';

export default function Install() {
  const { t } = useTranslation(['install', 'common']);
  const [method, setMethod] = useState<SetupMethod>('dns');
  const [dnsPlatform, setDnsPlatform] = useState<DnsPlatform>('router');
  const [clientPlatform, setClientPlatform] = useState<ClientPlatform>('macos');
  const [clientInfo, setClientInfo] = useState<ClientInfo | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // The public DNS resolver IP is owned by the API (config.parkingIp /
  // TNP_PARKING_IP) and served via /client/latest. Never hardcode it here — a
  // stale literal would tell users to point their DNS at a dead/wrong host.
  // The resolver answers plain DNS on port 53 only; /client/latest carries no
  // port, and NRPT and /etc/resolver would need 53 regardless.
  const ip = resolverIp(clientInfo);
  const ipText = ip ?? IP_PLACEHOLDER;
  const forward = `/${FORWARDED_TLD}/${ipText}`;

  useEffect(() => {
    let ignore = false;
    apiFetch<ClientInfo>('/client/latest')
      .then((data) => {
        if (!ignore) setClientInfo(data);
      })
      .catch((err) => {
        console.error('Failed to load client release info:', err);
        if (!ignore) setLoadFailed(true);
      });
    return () => {
      ignore = true;
    };
  }, []);

  const copyCommand = useCallback((command: string, field: string) => {
    // Only claim "copied" once the write succeeded; a blocked clipboard must
    // not leave the user pasting whatever was there before.
    navigator.clipboard
      .writeText(command)
      .then(() => {
        setCopied(field);
        setTimeout(() => setCopied(null), 2000);
      })
      .catch(() => setCopied(null));
  }, []);

  const methodKeys: SetupMethod[] = ['dns', 'client', 'serve', 'relay'];

  const richComponents: Record<string, ReactElement> = {
    accent,
    code: inlineCode,
    clientLink: (
      <button
        type="button"
        onClick={() => setMethod('client')}
        className="cursor-pointer text-primary-text underline transition-colors hover:text-foreground"
      />
    ),
    routerLink: (
      <button
        type="button"
        onClick={() => setDnsPlatform('router')}
        className="cursor-pointer text-primary-text underline transition-colors hover:text-foreground"
      />
    ),
  };

  const rich = (key: string) => (
    <Trans i18nKey={key} t={t} values={{ dnsIp: ipText, forward }} components={richComponents} />
  );

  const richList = (key: string) => (
    <ul className={`list-disc space-y-1.5 pl-5 ${proseClass}`}>
      {(t(key, { returnObjects: true, dnsIp: ipText, forward }) as string[]).map((item, i) => (
        <li key={item}>{rich(`${key}.${i}`)}</li>
      ))}
    </ul>
  );

  // A copyable command. Commands that embed the resolver address cannot be
  // copied until it has loaded, so nobody pastes the placeholder.
  const command = (id: string, text: string, needsIp = true) => {
    const ready = !needsIp || ip !== null;
    return (
      <div className="flex items-start justify-between gap-3 rounded bg-background px-3 py-2">
        <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs text-primary-text">
          <code>{text}</code>
        </pre>
        <button
          type="button"
          disabled={!ready}
          onClick={() => copyCommand(text, id)}
          className="shrink-0 cursor-pointer font-mono text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          [{copied === id ? t('common:copied') : t('common:copy')}]
        </button>
      </div>
    );
  };

  const tld = FORWARDED_TLD;
  const commands = {
    openwrtAdd: [
      `uci add_list dhcp.@dnsmasq[0].server='${forward}'`,
      'uci commit dhcp',
      '/etc/init.d/dnsmasq restart',
    ].join('\n'),
    openwrtRebind: [
      `uci add_list dhcp.@dnsmasq[0].rebind_domain='${tld}'`,
      'uci commit dhcp',
      '/etc/init.d/dnsmasq restart',
    ].join('\n'),
    // Removes every /ox/ forward, whichever resolver address it names.
    openwrtRemove: [
      `for s in $(uci -q get dhcp.@dnsmasq[0].server); do case "$s" in /${tld}/*) uci del_list dhcp.@dnsmasq[0].server="$s";; esac; done`,
      'uci commit dhcp',
      '/etc/init.d/dnsmasq restart',
    ].join('\n'),
    piholeV6: `sudo pihole-FTL --config misc.dnsmasq_lines '["server=${forward}"]'`,
    piholeV5: [
      `echo "server=${forward}" | sudo tee /etc/dnsmasq.d/99-tnp.conf`,
      'pihole restartdns',
    ].join('\n'),
    adguard: `[/${tld}/]${ipText}`,
    unboundInsecure: `server:\n  domain-insecure: "${tld}"`,
    dnsmasq: `server=${forward}`,
    windowsAdd: [
      `Add-DnsClientNrptRule -Namespace ".${tld}" -NameServers "${ipText}" -Comment "${MANUAL_MARKER}"`,
      'Clear-DnsClientCache',
    ].join('\n'),
    windowsRemove: [
      `Get-DnsClientNrptRule | Where-Object Comment -eq "${MANUAL_MARKER}" | Remove-DnsClientNrptRule -Force`,
      'Clear-DnsClientCache',
    ].join('\n'),
    // /etc/resolver/ox is the one name macOS reads for .ox, and the client
    // writes it too: never overwrite an existing file, and undo deletes only
    // a file carrying the marker.
    macosAdd: [
      'sudo mkdir -p /etc/resolver',
      `if [ -e /etc/resolver/${tld} ]; then echo "/etc/resolver/${tld} already exists; left unchanged:"; cat /etc/resolver/${tld}; else printf '%s\\n' '# ${MANUAL_MARKER}' 'nameserver ${ipText}' | sudo tee /etc/resolver/${tld}; fi`,
    ].join('\n'),
    macosRemove: `grep -q '${MANUAL_MARKER}' /etc/resolver/${tld} && sudo rm /etc/resolver/${tld}`,
    linuxDelegateFile: [
      `# ${MANUAL_MARKER}`,
      '[Delegate]',
      `DNS=${ipText}`,
      `Domains=~${tld}`,
      'DefaultRoute=no',
    ].join('\n'),
    linuxDelegateApply: [
      'sudo mkdir -p /etc/systemd/dns-delegate.d',
      `printf '%s\\n' '# ${MANUAL_MARKER}' '[Delegate]' 'DNS=${ipText}' 'Domains=~${tld}' 'DefaultRoute=no' | sudo tee ${MANUAL_DELEGATE}`,
      'sudo systemctl restart systemd-resolved',
    ].join('\n'),
    linuxDelegateRemove: [
      `sudo rm ${MANUAL_DELEGATE}`,
      'sudo systemctl restart systemd-resolved',
    ].join('\n'),
  };

  const tabClass = (active: boolean) =>
    `cursor-pointer rounded-md px-3 py-1.5 font-mono text-sm transition-colors ${
      active
        ? 'border border-primary/30 bg-primary/10 text-primary-text'
        : 'border border-border text-muted-foreground/70 hover:text-muted-foreground'
    }`;

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>{t('install:meta.title')}</title>
        <meta name="description" content={t('install:meta.description')} />
        <link rel="canonical" href="https://tnp.network/install" />
        <meta property="og:title" content={t('install:meta.ogTitle')} />
        <meta property="og:description" content={t('install:meta.ogDescription')} />
        <meta property="og:url" content="https://tnp.network/install" />
      </Helmet>
      <h1 className="mb-2 font-pixel text-xl text-primary-text">{t('install:title')}</h1>
      <p className="mb-8 font-mono text-sm text-muted-foreground/70">{t('install:subtitle')}</p>

      <div className="mb-8 flex flex-wrap gap-3">
        {methodKeys.map((key) => (
          <button
            type="button"
            key={key}
            onClick={() => setMethod(key)}
            className={`cursor-pointer rounded-lg px-4 py-2 font-mono text-sm transition-colors ${
              method === key
                ? 'border border-primary/30 bg-primary/10 text-primary-text'
                : 'border border-border text-muted-foreground/70 hover:text-muted-foreground'
            }`}
          >
            {t(`install:methods.${key}`)}
          </button>
        ))}
      </div>

      {method === 'dns' && (
        <>
          <div className="mb-6 space-y-3">
            {richList('install:dns.facts')}
            <p className={proseClass}>{rich('install:dns.clientHint')}</p>
            {!ip && (
              <p className={proseClass}>
                {loadFailed || clientInfo ? t('install:dns.ipError') : t('install:dns.ipLoading')}
              </p>
            )}
          </div>

          <div className="mb-6 flex flex-wrap gap-2">
            {dnsPlatforms.map((id) => (
              <button
                type="button"
                key={id}
                onClick={() => setDnsPlatform(id)}
                className={tabClass(dnsPlatform === id)}
              >
                {t(`install:dns.tabs.${id}`)}
              </button>
            ))}
          </div>

          <div className="space-y-5 rounded-lg border border-border bg-card p-5">
            {dnsPlatform === 'router' && (
              <>
                <h3 className="font-mono text-sm font-medium text-foreground">
                  {t('install:dns.router.title')}
                </h3>
                <p className={proseClass}>{t('install:dns.router.intro')}</p>

                <div className="space-y-2">
                  <h4 className={subheadClass}>{t('install:dns.router.openwrt.title')}</h4>
                  <p className={proseClass}>{t('install:dns.router.openwrt.cli')}</p>
                  {command('openwrt-add', commands.openwrtAdd)}
                  <p className={proseClass}>{rich('install:dns.router.openwrt.luci')}</p>
                  <p className={proseClass}>{t('install:dns.router.openwrt.rebind')}</p>
                  {command('openwrt-rebind', commands.openwrtRebind, false)}
                  <p className={proseClass}>{t('install:dns.undo')}</p>
                  {command('openwrt-remove', commands.openwrtRemove)}
                </div>

                <div className="space-y-2">
                  <h4 className={subheadClass}>{t('install:dns.router.pihole.title')}</h4>
                  <p className={proseClass}>{rich('install:dns.router.pihole.v6')}</p>
                  {command('pihole-v6', commands.piholeV6)}
                  <p className={proseClass}>{t('install:dns.router.pihole.v5')}</p>
                  {command('pihole-v5', commands.piholeV5)}
                </div>

                <div className="space-y-2">
                  <h4 className={subheadClass}>{t('install:dns.router.adguard.title')}</h4>
                  <p className={proseClass}>{rich('install:dns.router.adguard.desc')}</p>
                  {command('adguard', commands.adguard)}
                </div>

                <div className="space-y-2">
                  <h4 className={subheadClass}>{t('install:dns.router.unbound.title')}</h4>
                  <p className={proseClass}>{rich('install:dns.router.unbound.pfsense')}</p>
                  <p className={proseClass}>{rich('install:dns.router.unbound.opnsense')}</p>
                  <p className={proseClass}>{rich('install:dns.router.unbound.dnssec')}</p>
                  {command('unbound-insecure', commands.unboundInsecure, false)}
                </div>

                <div className="space-y-2">
                  <h4 className={subheadClass}>{t('install:dns.router.dnsmasq.title')}</h4>
                  <p className={proseClass}>{rich('install:dns.router.dnsmasq.desc')}</p>
                  {command('router-dnsmasq', commands.dnsmasq)}
                </div>

                <div className="space-y-2 rounded-md border border-warning-subtle px-4 py-3">
                  <h4 className="font-mono text-xs font-medium text-warning-text">
                    {t('install:dns.router.basic.title')}
                  </h4>
                  <p className={proseClass}>{t('install:dns.router.basic.desc')}</p>
                </div>
              </>
            )}

            {dnsPlatform === 'windows' && (
              <>
                <h3 className="font-mono text-sm font-medium text-foreground">
                  {t('install:dns.windows.title')}
                </h3>
                <p className={proseClass}>{t('install:dns.windows.desc')}</p>
                {command('windows-add', commands.windowsAdd)}
                <p className={proseClass}>{t('install:dns.undo')}</p>
                {command('windows-remove', commands.windowsRemove, false)}
              </>
            )}

            {dnsPlatform === 'macos' && (
              <>
                <h3 className="font-mono text-sm font-medium text-foreground">
                  {t('install:dns.macos.title')}
                </h3>
                <p className={proseClass}>{t('install:dns.macos.desc')}</p>
                {command('macos-add', commands.macosAdd)}
                <p className={proseClass}>{rich('install:dns.macos.test')}</p>
                <p className={proseClass}>{t('install:dns.undo')}</p>
                {command('macos-remove', commands.macosRemove, false)}
              </>
            )}

            {dnsPlatform === 'linux' && (
              <>
                <h3 className="font-mono text-sm font-medium text-foreground">
                  {t('install:dns.linux.title')}
                </h3>

                <div className="space-y-2">
                  <h4 className={subheadClass}>{t('install:dns.linux.delegate.title')}</h4>
                  <p className={proseClass}>{rich('install:dns.linux.delegate.desc')}</p>
                  {command('linux-delegate-file', commands.linuxDelegateFile)}
                  <p className={proseClass}>{t('install:dns.linux.delegate.apply')}</p>
                  {command('linux-delegate-apply', commands.linuxDelegateApply)}
                  <p className={proseClass}>{t('install:dns.undo')}</p>
                  {command('linux-delegate-remove', commands.linuxDelegateRemove, false)}
                </div>

                <div className="space-y-2">
                  <h4 className={subheadClass}>{t('install:dns.linux.dnsmasq.title')}</h4>
                  <p className={proseClass}>{rich('install:dns.linux.dnsmasq.desc')}</p>
                  {command('linux-dnsmasq', commands.dnsmasq)}
                </div>

                <div className="space-y-2">
                  <h4 className={subheadClass}>{t('install:dns.linux.other.title')}</h4>
                  <p className={proseClass}>{rich('install:dns.linux.other.desc')}</p>
                </div>
              </>
            )}

            {dnsPlatform === 'mobile' && (
              <>
                <h3 className="font-mono text-sm font-medium text-foreground">
                  {t('install:dns.mobile.title')}
                </h3>
                {richList('install:dns.mobile.points')}
              </>
            )}

            {dnsPlatform !== 'mobile' && dnsPlatform !== 'router' && (
              <p className={`border-t border-border pt-4 ${proseClass}`}>
                {t('install:dns.clientNote')}
              </p>
            )}
          </div>
        </>
      )}

      {method === 'client' && (
        <>
          {clientInfo && (
            <p className="mb-4 font-mono text-xs text-muted-foreground/70">
              {t('install:client.latestVersion', { version: clientInfo.version })}
            </p>
          )}

          <div className="mb-8 space-y-3">
            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <p className="mb-2 font-mono text-xs font-medium text-muted-foreground">
                macOS / Linux
              </p>
              {command('unix', INSTALL_CMD_UNIX, false)}
            </div>

            <div className="rounded-lg border border-border bg-card px-4 py-3">
              <p className="mb-2 font-mono text-xs font-medium text-muted-foreground">
                Windows (PowerShell)
              </p>
              {command('windows', INSTALL_CMD_WINDOWS, false)}
            </div>
          </div>

          <div className="mb-6 flex gap-2">
            {clientPlatforms.map((id) => (
              <button
                type="button"
                key={id}
                onClick={() => setClientPlatform(id)}
                className={tabClass(clientPlatform === id)}
              >
                {OS_LABELS[id]}
              </button>
            ))}
          </div>

          <div className="space-y-4 rounded-lg border border-border bg-card p-5">
            <h3 className="font-mono text-sm font-medium text-foreground">
              {t(`install:client.${clientPlatform}.title`)}
            </h3>
            <p className={proseClass}>{t(`install:client.${clientPlatform}.description`)}</p>
            <div className={`space-y-1 ${proseClass}`}>
              <p className="font-medium text-muted-foreground">
                {t(`install:client.${clientPlatform}.requirementsTitle`)}
              </p>
              <ul className="list-disc space-y-1 pl-5">
                {(
                  t(`install:client.${clientPlatform}.requirements`, {
                    returnObjects: true,
                  }) as string[]
                ).map((req) => (
                  <li key={req}>{req}</li>
                ))}
              </ul>
            </div>
          </div>

          <p className="mt-4 font-mono text-xs text-muted-foreground/70">
            {t('install:client.intro')}
          </p>
        </>
      )}

      {method === 'serve' && (
        <>
          <p className="mb-6 font-mono text-xs text-muted-foreground/70">
            {t('install:serve.intro')}
          </p>

          <div className="rounded-lg border border-border bg-card p-5 space-y-4">
            <h3 className="font-mono text-sm font-medium text-foreground">
              {t('install:serve.heading')}
            </h3>

            <div className="space-y-3">
              <div>
                <p className="mb-1 font-mono text-xs font-medium text-muted-foreground">
                  {t('install:serve.step1Title')}
                </p>
                <code className="block rounded bg-background px-3 py-2 text-xs text-primary-text">
                  curl -fsSL https://get.tnp.network | sh
                </code>
              </div>

              <div>
                <p className="mb-1 font-mono text-xs font-medium text-muted-foreground">
                  {t('install:serve.step2Title')}
                </p>
                <code className="block rounded bg-background px-3 py-2 text-xs text-primary-text">
                  tnp auth login
                </code>
                <p className="mt-1 font-mono text-xs text-muted-foreground/70">
                  {t('install:serve.step2Desc')}
                </p>
              </div>

              <div>
                <p className="mb-1 font-mono text-xs font-medium text-muted-foreground">
                  {t('install:serve.step3Title')}
                </p>
                <code className="block rounded bg-background px-3 py-2 text-xs text-primary-text">
                  tnp serve --domain example.ox --target localhost:80 --token &lt;your-token&gt;
                </code>
                <p className="mt-1 font-mono text-xs text-muted-foreground/70">
                  <Trans
                    i18nKey="install:serve.step3Desc"
                    t={t}
                    components={{
                      code1: (
                        <code className="rounded bg-background px-1.5 py-0.5 text-primary-text" />
                      ),
                      code2: (
                        <code className="rounded bg-background px-1.5 py-0.5 text-primary-text" />
                      ),
                    }}
                  />
                </p>
              </div>
            </div>

            <div className="border-t border-border pt-4">
              <p className="font-mono text-xs font-medium text-muted-foreground">
                {t('install:serve.howItWorks')}
              </p>
              <ul className="mt-2 list-disc pl-5 space-y-1.5 font-mono text-xs text-muted-foreground/70">
                {(t('install:serve.howItWorksList', { returnObjects: true }) as string[]).map(
                  (item) => (
                    <li key={item}>{item}</li>
                  ),
                )}
              </ul>
            </div>
          </div>
        </>
      )}

      {method === 'relay' && (
        <>
          <p className="mb-6 font-mono text-xs text-muted-foreground/70">
            {t('install:relay.intro')}
          </p>

          <div className="rounded-lg border border-border bg-card p-5 space-y-4">
            <h3 className="font-mono text-sm font-medium text-foreground">
              {t('install:relay.whatRelaysDo')}
            </h3>
            <ul className="list-disc pl-5 space-y-1.5 font-mono text-xs text-muted-foreground/70">
              {(t('install:relay.whatRelaysDoList', { returnObjects: true }) as string[]).map(
                (item) => (
                  <li key={item}>{item}</li>
                ),
              )}
            </ul>
          </div>

          <div className="mt-4 rounded-lg border border-border bg-card p-5 space-y-4">
            <h3 className="font-mono text-sm font-medium text-foreground">
              {t('install:relay.communityRelay')}
            </h3>
            <p className="font-mono text-xs text-muted-foreground/70">
              {t('install:relay.communityRelayDesc')}
            </p>

            <div className="space-y-3">
              <div>
                <p className="mb-1 font-mono text-xs font-medium text-muted-foreground">
                  {t('install:relay.step1Title')}
                </p>
                <code className="block rounded bg-background px-3 py-2 text-xs text-primary-text">
                  git clone https://github.com/OxyHQ/tnp && cd tnp/apps/relay
                </code>
              </div>
              <div>
                <p className="mb-1 font-mono text-xs font-medium text-muted-foreground">
                  {t('install:relay.step2Title')}
                </p>
                <code className="block rounded bg-background px-3 py-2 text-xs text-primary-text">
                  cp .env.example .env && bun run start
                </code>
              </div>
              <div>
                <p className="mb-1 font-mono text-xs font-medium text-muted-foreground">
                  {t('install:relay.step3Title')}
                </p>
                <p className="font-mono text-xs text-muted-foreground/70">
                  <Trans
                    i18nKey="install:relay.step3Desc"
                    t={t}
                    components={{
                      link: (
                        // biome-ignore lint/a11y/useAnchorContent: <Trans> fills this anchor with the translated link text
                        <a
                          href="/network"
                          className="text-primary-text transition-colors hover:text-foreground"
                        />
                      ),
                    }}
                  />
                </p>
              </div>
            </div>

            <p className="font-mono text-xs text-muted-foreground/70">
              <Trans
                i18nKey="install:relay.githubNote"
                t={t}
                components={{
                  link: (
                    // biome-ignore lint/a11y/useAnchorContent: <Trans> fills this anchor with the translated link text
                    <a
                      href="https://github.com/OxyHQ/tnp"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary-text transition-colors hover:text-foreground"
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
          className="font-mono text-sm text-muted-foreground/70 transition-colors hover:text-muted-foreground"
        >
          [{t('install:learnMore')}]
        </a>
      </div>
    </div>
  );
}
