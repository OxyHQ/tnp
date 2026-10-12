import {
  type FormEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import { VPN_DEVICE_NAME_MAX_LENGTH, type VpnDevice, type VpnNetwork } from '@tnp/shared-types';
import { apiRequest, errorBody, errorMessage, errorStatus } from '../lib/api';
import { qrMatrix, qrPath, QR_MARGIN } from '../lib/qr';
import { useLocaleFormatter } from '../lib/useLocaleFormatter';
import {
  addDevice,
  copyText,
  type DeviceConfigInput,
  httpVpnApi,
  type NewDevice,
  OPENWRT_ALLOW_FALLBACK,
  OPENWRT_REMOVE,
  openWrtCommands,
  routerWireGuardConfig,
  tunnelFileName,
  wireGuardConfig,
} from '../lib/vpn';

const api = httpVpnApi((method, path, options) => apiRequest(method, path, options));

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'unavailable' }
  | { kind: 'ready'; devices: VpnDevice[]; network: VpnNetwork };

const INPUT =
  'block w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-foreground';
const LABEL = 'font-mono text-xs text-muted-foreground/70';
const PRIMARY_BUTTON =
  'cursor-pointer rounded-md border border-primary/30 bg-primary/10 px-3 py-2 font-mono text-sm text-primary-text transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50';
const QUIET_BUTTON =
  'cursor-pointer font-mono text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground disabled:opacity-50';
const CARD = 'rounded-lg border border-border bg-card p-5';
const TAB = 'cursor-pointer rounded-lg px-4 py-2 font-mono text-sm transition-colors border';
const TAB_IDLE = `${TAB} border-border text-muted-foreground/70 hover:text-muted-foreground`;
const TAB_ACTIVE = `${TAB} border-primary/30 bg-primary/10 text-primary-text`;
const CODE = <code className="break-all rounded bg-background px-1.5 py-0.5 text-primary-text" />;

export default function Vpn() {
  const { t } = useTranslation(['vpn', 'common']);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  // The just-created device and its private key: memory only, gone on "Done" or on leaving.
  const [created, setCreated] = useState<NewDevice | null>(null);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      const list = await api.list();
      setPhase({ kind: 'ready', devices: list.devices, network: list.network });
    } catch (err) {
      if (errorStatus(err) === 503 && errorBody(err).code === 'vpn_not_configured') {
        setPhase({ kind: 'unavailable' });
      } else {
        setPhase({ kind: 'error', message: errorMessage(err, t('vpn:loadError')) });
      }
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreated = (next: NewDevice) => {
    setCreated(next);
    setPhase((p) =>
      p.kind === 'ready'
        ? {
            kind: 'ready',
            devices: [...p.devices, next.response.device],
            network: next.response.network,
          }
        : p,
    );
  };

  const onRenamed = (device: VpnDevice) =>
    setPhase((p) =>
      p.kind === 'ready'
        ? { ...p, devices: p.devices.map((d) => (d.id === device.id ? device : d)) }
        : p,
    );

  const onRevoked = (id: string) => {
    setPhase((p) =>
      p.kind === 'ready' ? { ...p, devices: p.devices.filter((d) => d.id !== id) } : p,
    );
    setCreated((c) => (c?.response.device.id === id ? null : c));
  };

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>{t('vpn:meta.title')}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="mb-8 flex flex-wrap gap-3">
        <Link to="/dashboard" className={TAB_IDLE}>
          {t('vpn:tabs.domains')}
        </Link>
        <Link to="/service-nodes" className={TAB_IDLE}>
          {t('vpn:tabs.serviceNodes')}
        </Link>
        <Link to="/dashboard/dns-rules" className={TAB_IDLE}>
          {t('vpn:tabs.dnsRules')}
        </Link>
        <Link to="/dashboard/vpn" aria-current="page" className={TAB_ACTIVE}>
          {t('vpn:tabs.vpn')}
        </Link>
      </div>

      <h1 className="mb-2 font-pixel text-xl text-primary-text">{t('vpn:heading')}</h1>
      <p className="mb-8 max-w-3xl font-mono text-sm text-muted-foreground/70">
        {t('vpn:subtitle')}
      </p>

      <HonestyPanel />

      <div className="mt-6 space-y-6">
        {phase.kind === 'loading' && (
          <p role="status" className="font-mono text-sm text-muted-foreground/70">
            {t('vpn:loading')}
          </p>
        )}

        {phase.kind === 'error' && (
          <div role="alert" className={CARD}>
            <p className="mb-3 font-mono text-sm text-error-text">{t('vpn:loadError')}</p>
            <p className="mb-4 font-mono text-xs text-muted-foreground/70">{phase.message}</p>
            <button type="button" onClick={() => void load()} className={PRIMARY_BUTTON}>
              [{t('common:retry')}]
            </button>
          </div>
        )}

        {phase.kind === 'unavailable' && (
          <section role="status" className={`${CARD} space-y-2`}>
            <h2 className="font-pixel text-lg text-primary-text">{t('vpn:unavailable.heading')}</h2>
            <p className="font-mono text-xs text-muted-foreground/70">
              {t('vpn:unavailable.body')}
            </p>
          </section>
        )}

        {phase.kind === 'ready' && (
          <>
            {created ? (
              <NewDevicePanel
                created={created}
                network={phase.network}
                onDone={() => setCreated(null)}
              />
            ) : (
              <AddDeviceForm
                atLimit={phase.devices.length >= phase.network.maxDevices}
                maxDevices={phase.network.maxDevices}
                onCreated={onCreated}
              />
            )}
            <DeviceList
              devices={phase.devices}
              maxDevices={phase.network.maxDevices}
              onRenamed={onRenamed}
              onRevoked={onRevoked}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// What this protects, and what it does not (privacy-model.md §6)
// ---------------------------------------------------------------------------

function HonestyPanel() {
  const { t } = useTranslation('vpn');
  const link = (
    <a
      href="https://www.torproject.org/"
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary-text underline"
    >
      {' '}
    </a>
  );
  return (
    <section className={`${CARD} space-y-4 border-warning-text/40`} aria-labelledby="vpn-honesty">
      <h2 id="vpn-honesty" className="font-pixel text-lg text-primary-text">
        {t('honesty.heading')}
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-2 font-mono text-sm text-success-text">
            {t('honesty.protectsHeading')}
          </h3>
          <ul className="list-disc space-y-2 pl-5 font-mono text-xs text-muted-foreground">
            <li>{t('honesty.protects1')}</li>
            <li>{t('honesty.protects2')}</li>
          </ul>
        </div>
        <div>
          <h3 className="mb-2 font-mono text-sm text-warning-text">{t('honesty.notHeading')}</h3>
          <ul className="list-disc space-y-2 pl-5 font-mono text-xs text-muted-foreground">
            <li>{t('honesty.not1')}</li>
            <li>{t('honesty.not2')}</li>
            <li>{t('honesty.not3')}</li>
            <li>{t('honesty.not4')}</li>
          </ul>
        </div>
      </div>
      <p className="rounded-md border border-warning-text/40 bg-background p-3 font-mono text-xs text-foreground">
        <Trans i18nKey="honesty.tor" t={t} components={{ link }} />
      </p>
      <p className="font-mono text-xs text-muted-foreground/70">{t('honesty.stored')}</p>
      <p className="font-mono text-xs text-muted-foreground/70">{t('honesty.ipv6')}</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Adding a device
// ---------------------------------------------------------------------------

function AddDeviceForm({
  atLimit,
  maxDevices,
  onCreated,
}: {
  atLimit: boolean;
  maxDevices: number;
  onCreated: (created: NewDevice) => void;
}) {
  const { t } = useTranslation('vpn');
  const id = useId();
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setPending(true);
    try {
      // The key pair is made here; only its public half is sent.
      onCreated(await addDevice(api, name));
      setName('');
    } catch (err) {
      toast.error(errorMessage(err, t('add.failed')));
    } finally {
      setPending(false);
    }
  };

  return (
    <section className={`${CARD} space-y-3`} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="font-pixel text-lg text-primary-text">
        {t('add.heading')}
      </h2>
      <p className="font-mono text-xs text-muted-foreground/70">{t('add.intro')}</p>
      {atLimit ? (
        <p role="status" className="font-mono text-xs text-warning-text">
          {t('add.limit', { max: maxDevices })}
        </p>
      ) : (
        <form onSubmit={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1 space-y-1" htmlFor={`${id}-name`}>
            <span className={LABEL}>{t('add.name')}</span>
            <input
              id={`${id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={VPN_DEVICE_NAME_MAX_LENGTH}
              placeholder={t('add.namePlaceholder')}
              autoComplete="off"
              required
              className={INPUT}
            />
          </label>
          <button
            type="submit"
            disabled={pending || !name.trim()}
            aria-busy={pending}
            className={PRIMARY_BUTTON}
          >
            {pending ? t('add.adding') : t('add.submit')}
          </button>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// The config for a device just added: shown once
// ---------------------------------------------------------------------------

const GUIDES = ['phone', 'desktop', 'linux', 'openwrt'] as const;
type Guide = (typeof GUIDES)[number];

function NewDevicePanel({
  created,
  network,
  onDone,
}: {
  created: NewDevice;
  network: VpnNetwork;
  onDone: () => void;
}) {
  const { t } = useTranslation('vpn');
  const id = useId();
  const [exitId, setExitId] = useState(network.exits[0]?.id ?? '');
  const [guide, setGuide] = useState<Guide>('phone');
  const exit = network.exits.find((e) => e.id === exitId) ?? network.exits[0];
  const device = created.response.device;
  const fileName = `${tunnelFileName(device.name)}.conf`;

  const input = useMemo(
    () =>
      exit
        ? {
            privateKey: created.keys.privateKey,
            device,
            exit,
            dns: network.dns,
            allowedIPs: network.allowedIPs,
          }
        : null,
    [created, device, exit, network],
  );
  const config = useMemo(() => (input ? wireGuardConfig(input) : ''), [input]);

  const download = () => {
    const url = URL.createObjectURL(new Blob([config], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  if (!exit || !input) return null;

  return (
    <section className={`${CARD} space-y-5 border-primary/30`} aria-labelledby={`${id}-h`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id={`${id}-h`} className="font-pixel text-lg text-primary-text">
          {t('config.heading', { name: device.name })}
        </h2>
        <button type="button" onClick={onDone} className={PRIMARY_BUTTON}>
          {t('config.done')}
        </button>
      </div>
      <p
        role="alert"
        className="rounded-md border border-warning-text/40 bg-background p-3 font-mono text-xs text-warning-text"
      >
        {t('config.once')}
      </p>

      {network.exits.length > 1 && (
        <label className="block max-w-sm space-y-1" htmlFor={`${id}-exit`}>
          <span className={LABEL}>{t('config.exit')}</span>
          <select
            id={`${id}-exit`}
            value={exit.id}
            onChange={(e) => setExitId(e.target.value)}
            className={INPUT}
          >
            {network.exits.map((e) => (
              <option key={e.id} value={e.id}>
                {t('config.exitOption', { id: e.id, region: e.region })}
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0 space-y-2">
          <p className={LABEL}>{t('config.file', { file: fileName })}</p>
          <CopyBlock text={config} secret />
          <button type="button" onClick={download} className={PRIMARY_BUTTON}>
            {t('config.download', { file: fileName })}
          </button>
        </div>
        <div className="space-y-2">
          <p className={LABEL}>{t('config.qr')}</p>
          <QrCode text={config} label={t('config.qrLabel', { name: device.name })} />
          <p className="max-w-[18rem] font-mono text-xs text-muted-foreground/70">
            {t('config.qrHelp')}
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <h3 className="font-mono text-sm text-foreground">{t('guide.heading')}</h3>
        <div role="tablist" aria-label={t('guide.heading')} className="flex flex-wrap gap-2">
          {GUIDES.map((g) => (
            <button
              key={g}
              type="button"
              role="tab"
              aria-selected={guide === g}
              onClick={() => setGuide(g)}
              className={`cursor-pointer rounded-md border px-3 py-1.5 font-mono text-xs transition-colors ${
                guide === g
                  ? 'border-primary/30 bg-primary/10 text-primary-text'
                  : 'border-border text-muted-foreground/70 hover:text-muted-foreground'
              }`}
            >
              {t(`guide.tabs.${g}`)}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="space-y-3">
          {guide === 'phone' && <PhoneGuide />}
          {guide === 'desktop' && <DesktopGuide />}
          {guide === 'linux' && <LinuxGuide fileName={fileName} />}
          {guide === 'openwrt' && (
            <OpenWrtGuide input={input} ipv4={device.ipv4} dns={network.dns.join(', ')} />
          )}
        </div>
      </div>
    </section>
  );
}

function Steps({ keys }: { keys: string[] }) {
  const { t } = useTranslation('vpn');
  return (
    <ol className="list-decimal space-y-2 pl-5 font-mono text-xs text-muted-foreground">
      {keys.map((key) => (
        <li key={key}>
          <Trans i18nKey={key} t={t} components={{ code: CODE }} />
        </li>
      ))}
    </ol>
  );
}

function Note({ k, values }: { k: string; values?: Record<string, string> }): ReactElement {
  const { t } = useTranslation('vpn');
  return (
    <p className="font-mono text-xs text-muted-foreground/70">
      <Trans i18nKey={k} t={t} values={values} components={{ code: CODE }} />
    </p>
  );
}

function PhoneGuide() {
  return (
    <>
      <Steps keys={['guide.phone.step1', 'guide.phone.step2', 'guide.phone.step3']} />
      <Note k="guide.phone.android" />
      <Note k="guide.phone.ios" />
    </>
  );
}

function DesktopGuide() {
  return (
    <>
      <Steps keys={['guide.desktop.step1', 'guide.desktop.step2', 'guide.desktop.step3']} />
      <Note k="guide.desktop.windows" />
    </>
  );
}

function LinuxGuide({ fileName }: { fileName: string }) {
  const name = fileName.replace(/\.conf$/, '');
  const commands = [
    `sudo install -m 600 ${fileName} /etc/wireguard/${fileName}`,
    `sudo wg-quick up ${name}`,
  ].join('\n');
  return (
    <>
      <Note k="guide.linux.intro" />
      <CopyBlock text={commands} />
      <Note k="guide.linux.boot" values={{ name }} />
      <Note k="guide.linux.dns" />
    </>
  );
}

function OpenWrtGuide({
  input,
  ipv4,
  dns,
}: {
  input: DeviceConfigInput;
  ipv4: string;
  dns: string;
}) {
  const { t } = useTranslation('vpn');
  const [fallback, setFallback] = useState(false);
  const routerConfig = useMemo(() => routerWireGuardConfig(input), [input]);
  const uci = useMemo(() => openWrtCommands(input, { killSwitch: !fallback }), [input, fallback]);
  return (
    <>
      <Note k="guide.openwrt.intro" />
      <Note k="guide.openwrt.packages" />
      <h4 className="font-mono text-xs text-foreground">{t('guide.openwrt.luciHeading')}</h4>
      <ol className="list-decimal space-y-2 pl-5 font-mono text-xs text-muted-foreground">
        {(['luci1', 'luci2', 'luci3', 'luci4', 'luci5', 'luci6', 'luci7', 'luci8'] as const).map(
          (step) => (
            <li key={step}>
              <Trans
                i18nKey={`guide.openwrt.${step}`}
                t={t}
                values={{ ipv4, dns }}
                components={{ code: CODE }}
              />
            </li>
          ),
        )}
      </ol>
      <h4 className="font-mono text-xs text-foreground">
        {t('guide.openwrt.routerConfigHeading')}
      </h4>
      <CopyBlock text={routerConfig} secret />
      <h4 className="font-mono text-xs text-foreground">{t('guide.openwrt.cliHeading')}</h4>
      <p className="font-mono text-xs text-warning-text">{t('guide.openwrt.cliNote')}</p>
      <h4 className="font-mono text-xs text-foreground">{t('guide.openwrt.killHeading')}</h4>
      <Note k="guide.openwrt.killText" />
      <label className="flex items-start gap-2 font-mono text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={fallback}
          onChange={(e) => setFallback(e.target.checked)}
          className="mt-0.5"
        />
        <span>{t('guide.openwrt.killToggle')}</span>
      </label>
      <CopyBlock text={uci} secret />
      <Note k="guide.openwrt.ipv6" />
      <h4 className="font-mono text-xs text-foreground">{t('guide.openwrt.fallbackHeading')}</h4>
      <Note k="guide.openwrt.fallbackText" />
      <CopyBlock text={OPENWRT_ALLOW_FALLBACK} />
      <h4 className="font-mono text-xs text-foreground">{t('guide.openwrt.removeHeading')}</h4>
      <Note k="guide.openwrt.removeText" />
      <CopyBlock text={OPENWRT_REMOVE} />
    </>
  );
}

function CopyBlock({ text, secret = false }: { text: string; secret?: boolean }) {
  const { t } = useTranslation(['common', 'vpn']);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void copyText(navigator.clipboard, text, secret).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="space-y-1">
      <div className="relative">
        <pre className="max-h-96 overflow-auto whitespace-pre rounded-md border border-border bg-background p-3 pr-16 font-mono text-xs text-foreground">
          {text}
        </pre>
        <button
          type="button"
          onClick={copy}
          className="absolute right-2 top-2 cursor-pointer rounded-md border border-border bg-card px-2 py-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {copied ? t('common:copied') : t('common:copy')}
        </button>
      </div>
      {secret && <p className="font-mono text-xs text-warning-text">{t('vpn:config.clipboard')}</p>}
    </div>
  );
}

/** Black on white whatever the theme: scanners need the contrast, and the quiet zone. */
function QrCode({ text, label }: { text: string; label: string }) {
  const matrix = useMemo(() => qrMatrix(text), [text]);
  const side = matrix.size + QR_MARGIN * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${side} ${side}`}
      shapeRendering="crispEdges"
      className="h-64 w-64 max-w-full rounded-md"
    >
      <rect width={side} height={side} fill="white" />
      <path d={qrPath(matrix)} fill="black" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The device list
// ---------------------------------------------------------------------------

function DeviceList({
  devices,
  maxDevices,
  onRenamed,
  onRevoked,
}: {
  devices: VpnDevice[];
  maxDevices: number;
  onRenamed: (device: VpnDevice) => void;
  onRevoked: (id: string) => void;
}) {
  const { t } = useTranslation('vpn');
  const id = useId();
  return (
    <section className={`${CARD} space-y-3`} aria-labelledby={`${id}-h`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={`${id}-h`} className="font-pixel text-lg text-primary-text">
          {t('devices.heading')}
        </h2>
        <p className={LABEL}>{t('devices.count', { count: devices.length, max: maxDevices })}</p>
      </div>
      {devices.length === 0 ? (
        <p className="font-mono text-xs text-muted-foreground/70">{t('devices.empty')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              onRenamed={onRenamed}
              onRevoked={onRevoked}
            />
          ))}
        </ul>
      )}
      <p className="font-mono text-xs text-muted-foreground/70">{t('devices.lost')}</p>
    </section>
  );
}

function DeviceRow({
  device,
  onRenamed,
  onRevoked,
}: {
  device: VpnDevice;
  onRenamed: (device: VpnDevice) => void;
  onRevoked: (id: string) => void;
}) {
  const { t } = useTranslation('vpn');
  const { formatDate } = useLocaleFormatter();
  const [mode, setMode] = useState<'view' | 'rename' | 'revoke'>('view');
  const [name, setName] = useState(device.name);
  const [busy, setBusy] = useState(false);

  const rename = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { device: next } = await api.rename(device.id, { name: name.trim() });
      onRenamed(next);
      setMode('view');
      toast.success(t('devices.renamed'));
    } catch (err) {
      toast.error(errorMessage(err, t('devices.failed')));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    setBusy(true);
    try {
      await api.remove(device.id);
      onRevoked(device.id);
      toast.success(t('devices.revoked', { name: device.name }));
    } catch (err) {
      toast.error(errorMessage(err, t('devices.failed')));
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      {mode === 'rename' ? (
        <form onSubmit={rename} className="flex flex-1 flex-wrap items-center gap-2">
          <input
            aria-label={t('devices.rename')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={VPN_DEVICE_NAME_MAX_LENGTH}
            required
            className={`${INPUT} max-w-xs`}
          />
          <button type="submit" disabled={busy || !name.trim()} className={PRIMARY_BUTTON}>
            {t('devices.save')}
          </button>
          <button
            type="button"
            onClick={() => {
              setName(device.name);
              setMode('view');
            }}
            className={QUIET_BUTTON}
          >
            [{t('devices.cancel')}]
          </button>
        </form>
      ) : (
        <div className="min-w-0">
          <p className="break-words font-mono text-sm text-foreground">{device.name}</p>
          <p className="font-mono text-xs text-muted-foreground/70">
            {t('devices.details', { address: device.ipv4, date: formatDate(device.createdAt) })}
          </p>
        </div>
      )}
      {mode === 'revoke' ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="font-mono text-xs text-error-text">
            {t('devices.revokeConfirm', { name: device.name })}
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void revoke()}
            className="cursor-pointer rounded-md border border-destructive/40 bg-error-subtle px-3 py-2 font-mono text-sm text-error-text disabled:opacity-50"
          >
            {t('devices.revokeButton')}
          </button>
          <button type="button" onClick={() => setMode('view')} className={QUIET_BUTTON}>
            [{t('devices.cancel')}]
          </button>
        </div>
      ) : (
        mode === 'view' && (
          <div className="flex gap-3">
            <button type="button" onClick={() => setMode('rename')} className={QUIET_BUTTON}>
              [{t('devices.rename')}]
            </button>
            <button type="button" onClick={() => setMode('revoke')} className={QUIET_BUTTON}>
              [{t('devices.revoke')}]
            </button>
          </div>
        )
      )}
    </li>
  );
}
