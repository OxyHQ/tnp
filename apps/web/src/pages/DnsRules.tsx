import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { toast } from '@oxy.so/bloom/toast';
import { RulesEnvelopeError } from '@tnp/crypto/dns-rules';
import {
  type DnsRule,
  type DnsRuleErrorCode,
  type DnsRulesRecord,
  exportAdGuard,
  exportDnsmasq,
  exportHosts,
  exportUci,
  parseDnsRule,
  parseDnsRuleTargetInput,
} from '@tnp/shared-types';
import { apiRequest, errorMessage, errorStatus } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  createRules,
  httpRulesApi,
  isNativeName,
  loadRulesRecord,
  MIN_PASSPHRASE_LENGTH,
  RulesConflictError,
  reloadRules,
  saveRules,
  type UnlockedRules,
  unlockRules,
  wipeKey,
} from '../lib/dnsRules';
import { workerCrypto } from '../lib/dnsRulesWorkerProtocol';

const api = httpRulesApi((method, path, options) => apiRequest(method, path, options), errorStatus);

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'setup' }
  | { kind: 'locked'; record: DnsRulesRecord }
  | { kind: 'unlocked'; session: UnlockedRules };

const INPUT =
  'block w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-foreground aria-[invalid=true]:border-destructive';
const LABEL = 'font-mono text-xs text-muted-foreground/70';
const PRIMARY_BUTTON =
  'cursor-pointer rounded-md border border-primary/30 bg-primary/10 px-3 py-2 font-mono text-sm text-primary-text transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50';
const QUIET_BUTTON =
  'cursor-pointer font-mono text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground disabled:opacity-50';
const CARD = 'rounded-lg border border-border bg-card p-5';

const EXPORTS = {
  dnsmasq: exportDnsmasq,
  uci: exportUci,
  adguard: exportAdGuard,
  hosts: exportHosts,
} as const;
type ExportFormat = keyof typeof EXPORTS;

function ruleKey(rule: DnsRule): string {
  return `${rule.type}:${rule.name}`;
}

export default function DnsRules() {
  const { t } = useTranslation(['dnsRules', 'common']);
  const { user } = useAuth();
  const userId = user?.id;
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [draft, setDraft] = useState<DnsRule[]>([]);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const keyRef = useRef<Uint8Array | null>(null);

  // The rules key never outlives the page.
  useEffect(() => () => wipeKey(keyRef.current), []);

  const enter = useCallback((session: UnlockedRules) => {
    if (keyRef.current && keyRef.current !== session.rulesKey) wipeKey(keyRef.current);
    keyRef.current = session.rulesKey;
    setDraft(session.rules);
    setConflict(false);
    setPhase({ kind: 'unlocked', session });
  }, []);

  const lock = useCallback((record: DnsRulesRecord | null) => {
    wipeKey(keyRef.current);
    keyRef.current = null;
    setDraft([]);
    setConflict(false);
    setPhase(record ? { kind: 'locked', record } : { kind: 'setup' });
  }, []);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      const record = await loadRulesRecord(api);
      setPhase(record ? { kind: 'locked', record } : { kind: 'setup' });
    } catch (err) {
      setPhase({ kind: 'error', message: errorMessage(err, t('dnsRules:loadError')) });
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const saved = phase.kind === 'unlocked' ? phase.session.rules : [];
  const dirty = useMemo(
    () => phase.kind === 'unlocked' && JSON.stringify(draft) !== JSON.stringify(saved),
    [phase.kind, draft, saved],
  );

  const save = async () => {
    if (phase.kind !== 'unlocked') return;
    setBusy(true);
    try {
      enter(await saveRules(api, phase.session, draft));
      toast.success(t('dnsRules:save.saved'));
    } catch (err) {
      if (err instanceof RulesConflictError) setConflict(true);
      else toast.error(errorMessage(err, t('dnsRules:save.failed')));
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    if (phase.kind !== 'unlocked' || !userId) return;
    setBusy(true);
    try {
      const next = await reloadRules(api, phase.session.rulesKey, userId);
      if (next) {
        enter(next);
      } else {
        // Deleted or re-created elsewhere: the key in memory no longer opens it.
        lock(null);
        await load();
      }
    } catch (err) {
      toast.error(errorMessage(err, t('dnsRules:loadError')));
    } finally {
      setBusy(false);
    }
  };

  const removeAll = async () => {
    setBusy(true);
    try {
      await api.remove();
      lock(null);
      toast.success(t('dnsRules:danger.deleted'));
    } catch (err) {
      toast.error(errorMessage(err, t('dnsRules:save.failed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1200px] px-4 py-16 lg:px-6">
      <Helmet>
        <title>{t('dnsRules:meta.title')}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>

      <div className="mb-8 flex flex-wrap gap-3">
        <Link
          to="/dashboard"
          className="cursor-pointer rounded-lg border border-border px-4 py-2 font-mono text-sm text-muted-foreground/70 transition-colors hover:text-muted-foreground"
        >
          {t('dnsRules:tabs.domains')}
        </Link>
        <Link
          to="/service-nodes"
          className="cursor-pointer rounded-lg border border-border px-4 py-2 font-mono text-sm text-muted-foreground/70 transition-colors hover:text-muted-foreground"
        >
          {t('dnsRules:tabs.serviceNodes')}
        </Link>
        <Link
          to="/dashboard/dns-rules"
          aria-current="page"
          className="cursor-pointer rounded-lg border border-primary/30 bg-primary/10 px-4 py-2 font-mono text-sm text-primary-text transition-colors"
        >
          {t('dnsRules:tabs.dnsRules')}
        </Link>
      </div>

      <h1 className="mb-2 font-pixel text-xl text-primary-text">{t('dnsRules:heading')}</h1>
      <p className="mb-8 max-w-3xl font-mono text-sm text-muted-foreground/70">
        {t('dnsRules:subtitle')}
      </p>

      {!userId && (
        <p role="alert" className="font-mono text-sm text-error-text">
          {t('dnsRules:noUser')}
        </p>
      )}

      {userId && phase.kind === 'loading' && (
        <p role="status" className="font-mono text-sm text-muted-foreground/70">
          {t('dnsRules:loading')}
        </p>
      )}

      {userId && phase.kind === 'error' && (
        <div role="alert" className={CARD}>
          <p className="mb-3 font-mono text-sm text-error-text">{t('dnsRules:loadError')}</p>
          <p className="mb-4 font-mono text-xs text-muted-foreground/70">{phase.message}</p>
          <button type="button" onClick={() => void load()} className={PRIMARY_BUTTON}>
            [{t('common:retry')}]
          </button>
        </div>
      )}

      {userId && phase.kind === 'setup' && (
        <SetupForm
          onCreate={async (passphrase) =>
            enter(await createRules(api, passphrase, userId, workerCrypto))
          }
        />
      )}

      {userId && phase.kind === 'locked' && (
        <UnlockForm
          onUnlock={async (passphrase) =>
            enter(await unlockRules(phase.record, passphrase, userId, workerCrypto))
          }
          onDelete={removeAll}
          busy={busy}
        />
      )}

      {userId && phase.kind === 'unlocked' && (
        <div className="space-y-6">
          <div className={`${CARD} flex flex-wrap items-center justify-between gap-3`}>
            <p className="font-mono text-xs text-muted-foreground/70">
              {t('dnsRules:version', { version: phase.session.record.version })}
              {dirty && (
                <span className="ml-2 text-warning-text">{t('dnsRules:save.unsaved')}</span>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy || !dirty}
                aria-busy={busy}
                className={PRIMARY_BUTTON}
              >
                {busy ? t('dnsRules:save.saving') : t('dnsRules:save.save')}
              </button>
              <button
                type="button"
                onClick={() => lock(phase.session.record)}
                className={QUIET_BUTTON}
              >
                [{t('dnsRules:lock')}]
              </button>
            </div>
          </div>

          {conflict && (
            <div role="alert" className={`${CARD} border-warning-text/40`}>
              <p className="mb-3 font-mono text-sm text-warning-text">
                {t('dnsRules:save.conflict')}
              </p>
              <button
                type="button"
                onClick={() => void reload()}
                disabled={busy}
                className={PRIMARY_BUTTON}
              >
                [{t('dnsRules:save.reload')}]
              </button>
            </div>
          )}

          {phase.session.rejected.length > 0 && (
            <div role="status" className={CARD}>
              <p className="mb-2 font-mono text-sm text-warning-text">
                {t('dnsRules:rejected.heading')}
              </p>
              <ul className="space-y-1 font-mono text-xs text-muted-foreground/70">
                {phase.session.rejected.map((r) => (
                  <li key={r.index}>
                    {t('dnsRules:rejected.item', {
                      index: r.index + 1,
                      reason: t(`dnsRules:errors.${r.code}`),
                    })}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <RuleEditor draft={draft} onChange={setDraft} />
          <ExportPanel rules={draft} />
          <ApplyPanel />
          <DangerPanel onDelete={removeAll} busy={busy} />
        </div>
      )}

      <PrivacyPanel />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Passphrase forms
// ---------------------------------------------------------------------------

function SetupForm({ onCreate }: { onCreate: (passphrase: string) => Promise<void> }) {
  const { t } = useTranslation('dnsRules');
  const id = useId();
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
      setError(t('setup.tooShort', { min: MIN_PASSPHRASE_LENGTH }));
      return;
    }
    if (passphrase !== confirm) {
      setError(t('setup.mismatch'));
      return;
    }
    setError(null);
    setPending(true);
    try {
      await onCreate(passphrase);
    } catch (err) {
      setError(errorMessage(err, t('save.failed')));
    } finally {
      setPassphrase('');
      setConfirm('');
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className={`${CARD} max-w-xl space-y-4`}>
      <h2 className="font-pixel text-lg text-primary-text">{t('setup.heading')}</h2>
      <p className="font-mono text-xs text-muted-foreground/70">{t('setup.intro')}</p>
      <p
        role="note"
        className="rounded-md border border-warning-text/40 bg-warning-subtle p-3 font-mono text-xs text-warning-text"
      >
        {t('setup.warning')}
      </p>
      <div className="space-y-1">
        <label htmlFor={`${id}-p`} className={LABEL}>
          {t('setup.passphrase')}
        </label>
        <input
          id={`${id}-p`}
          type="password"
          autoComplete="new-password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          aria-invalid={error !== null}
          className={INPUT}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-c`} className={LABEL}>
          {t('setup.confirm')}
        </label>
        <input
          id={`${id}-c`}
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={error !== null}
          className={INPUT}
        />
      </div>
      {error && (
        <p role="alert" className="font-mono text-xs text-error-text">
          {error}
        </p>
      )}
      <button type="submit" disabled={pending} aria-busy={pending} className={PRIMARY_BUTTON}>
        {pending ? t('setup.creating') : t('setup.create')}
      </button>
    </form>
  );
}

function UnlockForm({
  onUnlock,
  onDelete,
  busy,
}: {
  onUnlock: (passphrase: string) => Promise<void>;
  onDelete: () => Promise<void>;
  busy: boolean;
}) {
  const { t } = useTranslation('dnsRules');
  const id = useId();
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (passphrase === '') return;
    setError(null);
    setPending(true);
    try {
      await onUnlock(passphrase);
    } catch (err) {
      if (err instanceof RulesEnvelopeError) {
        setError(err.code === 'wrong-passphrase' ? t('unlock.wrong') : t('unlock.tampered'));
      } else {
        setError(errorMessage(err, t('loadError')));
      }
    } finally {
      setPassphrase('');
      setPending(false);
    }
  };

  return (
    <div className="max-w-xl space-y-6">
      <form onSubmit={submit} noValidate className={`${CARD} space-y-4`}>
        <h2 className="font-pixel text-lg text-primary-text">{t('unlock.heading')}</h2>
        <p className="font-mono text-xs text-muted-foreground/70">{t('unlock.intro')}</p>
        <div className="space-y-1">
          <label htmlFor={`${id}-p`} className={LABEL}>
            {t('unlock.passphrase')}
          </label>
          <input
            id={`${id}-p`}
            type="password"
            autoComplete="current-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            aria-invalid={error !== null}
            className={INPUT}
          />
        </div>
        {error && (
          <p role="alert" className="font-mono text-xs text-error-text">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={pending || passphrase === ''}
          aria-busy={pending}
          className={PRIMARY_BUTTON}
        >
          {pending ? t('unlock.deriving') : t('unlock.submit')}
        </button>
      </form>
      <p className="font-mono text-xs text-muted-foreground/70">{t('unlock.forgot')}</p>
      <DangerPanel onDelete={onDelete} busy={busy} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function RuleEditor({
  draft,
  onChange,
}: {
  draft: DnsRule[];
  onChange: (rules: DnsRule[]) => void;
}) {
  const { t } = useTranslation('dnsRules');
  const id = useId();
  const [editing, setEditing] = useState<string | null>(null);
  const [type, setType] = useState<'block' | 'redirect'>('block');
  const [name, setName] = useState('');
  const [subdomains, setSubdomains] = useState(false);
  const [target, setTarget] = useState('');
  const [error, setError] = useState<{ code: DnsRuleErrorCode; field: string } | null>(null);

  const reset = () => {
    setEditing(null);
    setType('block');
    setName('');
    setSubdomains(false);
    setTarget('');
    setError(null);
  };

  const startEdit = (rule: DnsRule) => {
    setEditing(ruleKey(rule));
    setType(rule.type);
    setName(rule.name);
    setSubdomains(rule.type === 'block' && rule.subdomains);
    setTarget(rule.type === 'redirect' ? rule.target.value : '');
    setError(null);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    let targetValue: unknown;
    if (type === 'redirect') {
      if (target.trim() === '') {
        setError({ code: 'target_required', field: 'target' });
        return;
      }
      targetValue = parseDnsRuleTargetInput(target) ?? { kind: 'invalid', value: target };
    }
    const parsed = parseDnsRule({ type, name, subdomains, target: targetValue }, isNativeName);
    if (!parsed.ok) {
      setError({ code: parsed.code, field: parsed.field });
      return;
    }
    const others = draft.filter((r) => ruleKey(r) !== editing);
    if (others.some((r) => r.name === parsed.value.name)) {
      setError({ code: 'duplicate', field: 'name' });
      return;
    }
    onChange(
      [...others, parsed.value].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    );
    reset();
  };

  const errorId = `${id}-error`;
  return (
    <section className={`${CARD} space-y-5`} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="font-pixel text-lg text-primary-text">
        {t('editor.heading')}
      </h2>

      {draft.length === 0 ? (
        <p className="font-mono text-sm text-muted-foreground/70">{t('editor.empty')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {draft.map((rule) => (
            <li
              key={ruleKey(rule)}
              className="flex flex-wrap items-center justify-between gap-2 py-3"
            >
              <div className="min-w-0 flex-1">
                <span
                  className={`mr-2 rounded-md px-2 py-0.5 font-mono text-xs ${
                    rule.type === 'block'
                      ? 'bg-error-subtle text-error-text'
                      : 'bg-primary/10 text-primary-text'
                  }`}
                >
                  {rule.type === 'block' ? t('editor.blockLabel') : t('editor.redirectLabel')}
                </span>
                <span className="break-all font-mono text-sm">{rule.name}</span>
                <span className="ml-2 break-all font-mono text-xs text-muted-foreground/70">
                  {rule.type === 'block'
                    ? rule.subdomains
                      ? t('editor.andSubdomains')
                      : ''
                    : `→ ${rule.target.value}`}
                </span>
              </div>
              <div className="flex gap-3">
                <button type="button" onClick={() => startEdit(rule)} className={QUIET_BUTTON}>
                  [{t('editor.edit')}]
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onChange(draft.filter((r) => ruleKey(r) !== ruleKey(rule)));
                    if (editing === ruleKey(rule)) reset();
                  }}
                  className={QUIET_BUTTON}
                >
                  [{t('editor.remove')}]
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} noValidate className="space-y-3 border-t border-border pt-4">
        <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
          <div className="space-y-1">
            <label htmlFor={`${id}-type`} className={LABEL}>
              {t('editor.type')}
            </label>
            <select
              id={`${id}-type`}
              value={type}
              onChange={(e) => setType(e.target.value === 'redirect' ? 'redirect' : 'block')}
              className={INPUT}
            >
              <option value="block">{t('editor.typeBlock')}</option>
              <option value="redirect">{t('editor.typeRedirect')}</option>
            </select>
          </div>
          <div className="space-y-1">
            <label htmlFor={`${id}-name`} className={LABEL}>
              {t('editor.name')}
            </label>
            <input
              id={`${id}-name`}
              type="text"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('editor.namePlaceholder')}
              aria-invalid={error?.field === 'name'}
              aria-describedby={error?.field === 'name' ? errorId : undefined}
              className={INPUT}
            />
          </div>
        </div>

        {type === 'block' ? (
          <label className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={subdomains}
              onChange={(e) => setSubdomains(e.target.checked)}
            />
            {t('editor.subdomains')}
          </label>
        ) : (
          <div className="space-y-1">
            <label htmlFor={`${id}-target`} className={LABEL}>
              {t('editor.target')}
            </label>
            <input
              id={`${id}-target`}
              type="text"
              autoCapitalize="none"
              spellCheck={false}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={t('editor.targetPlaceholder')}
              aria-invalid={error?.field === 'target'}
              aria-describedby={error?.field === 'target' ? errorId : `${id}-target-help`}
              className={INPUT}
            />
            <p id={`${id}-target-help`} className="font-mono text-xs text-muted-foreground/70">
              {t('editor.targetHelp')}
            </p>
          </div>
        )}

        {error && (
          <p id={errorId} role="alert" className="font-mono text-xs text-error-text">
            {t(`errors.${error.code}`)}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={PRIMARY_BUTTON}>
            {editing ? t('editor.update') : t('editor.add')}
          </button>
          {editing && (
            <button type="button" onClick={reset} className={QUIET_BUTTON}>
              [{t('editor.cancel')}]
            </button>
          )}
        </div>
        <p className="font-mono text-xs text-muted-foreground/70">{t('editor.localNote')}</p>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Export, apply, privacy, danger
// ---------------------------------------------------------------------------

function ExportPanel({ rules }: { rules: DnsRule[] }) {
  const { t } = useTranslation(['dnsRules', 'common']);
  const id = useId();
  const [format, setFormat] = useState<ExportFormat>('dnsmasq');
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => EXPORTS[format](rules), [format, rules]);

  const copy = () => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <section className={`${CARD} space-y-4`} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="font-pixel text-lg text-primary-text">
        {t('dnsRules:export.heading')}
      </h2>
      <p className="font-mono text-xs text-muted-foreground/70">{t('dnsRules:export.intro')}</p>
      <div
        role="tablist"
        aria-label={t('dnsRules:export.heading')}
        className="flex flex-wrap gap-2"
      >
        {(Object.keys(EXPORTS) as ExportFormat[]).map((f) => (
          <button
            key={f}
            type="button"
            role="tab"
            aria-selected={format === f}
            onClick={() => setFormat(f)}
            className={`cursor-pointer rounded-md border px-3 py-1.5 font-mono text-xs transition-colors ${
              format === f
                ? 'border-primary/30 bg-primary/10 text-primary-text'
                : 'border-border text-muted-foreground/70 hover:text-muted-foreground'
            }`}
          >
            {t(`dnsRules:export.tabs.${f}`)}
          </button>
        ))}
      </div>
      <p className="font-mono text-xs text-muted-foreground/70">
        {t(`dnsRules:export.notes.${format}`)}
      </p>
      <div className="relative">
        <pre className="max-h-96 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground">
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
    </section>
  );
}

function ApplyPanel() {
  const { t } = useTranslation('dnsRules');
  const code = <code className="break-all rounded bg-background px-1.5 py-0.5 text-primary-text" />;
  return (
    <section className={`${CARD} space-y-3`}>
      <h2 className="font-pixel text-lg text-primary-text">{t('apply.heading')}</h2>
      <p className="font-mono text-xs text-muted-foreground/70">{t('apply.intro')}</p>
      <ol className="list-decimal space-y-2 pl-5 font-mono text-xs text-muted-foreground">
        <li>
          <Trans i18nKey="apply.step1" t={t} components={{ code }} />
        </li>
        <li>
          <Trans i18nKey="apply.step2" t={t} components={{ code }} />
        </li>
        <li>
          <Trans i18nKey="apply.step3" t={t} components={{ code }} />
        </li>
      </ol>
      <p className="font-mono text-xs text-muted-foreground/70">
        <Trans i18nKey="apply.scope" t={t} components={{ code }} />
      </p>
    </section>
  );
}

function PrivacyPanel() {
  const { t } = useTranslation('dnsRules');
  return (
    <section className={`${CARD} mt-6 space-y-2`}>
      <h2 className="font-pixel text-lg text-primary-text">{t('privacy.heading')}</h2>
      <p className="font-mono text-xs text-muted-foreground/70">{t('privacy.stored')}</p>
      <p className="font-mono text-xs text-muted-foreground/70">{t('privacy.redirects')}</p>
      <p className="font-mono text-xs text-muted-foreground/70">{t('privacy.webCode')}</p>
    </section>
  );
}

function DangerPanel({ onDelete, busy }: { onDelete: () => Promise<void>; busy: boolean }) {
  const { t } = useTranslation('dnsRules');
  const [confirming, setConfirming] = useState(false);
  return (
    <section className={`${CARD} space-y-3`}>
      <h2 className="font-pixel text-lg text-error-text">{t('danger.heading')}</h2>
      {confirming ? (
        <div className="space-y-3">
          <p role="alert" className="font-mono text-xs text-error-text">
            {t('danger.confirm')}
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void onDelete().then(() => setConfirming(false))}
              className="cursor-pointer rounded-md border border-destructive/40 bg-error-subtle px-3 py-2 font-mono text-sm text-error-text disabled:opacity-50"
            >
              {t('danger.confirmButton')}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className={QUIET_BUTTON}>
              [{t('danger.cancel')}]
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setConfirming(true)} className={QUIET_BUTTON}>
          [{t('danger.delete')}]
        </button>
      )}
    </section>
  );
}
