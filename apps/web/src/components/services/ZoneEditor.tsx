import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  MAX_ZONE_CHANGES,
  type OperationDto,
  type ZoneApplyRequest,
  type ZoneApplyResponse,
  type ZoneChangeDto,
  type ZonePreviewRequest,
  type ZonePreviewResponse,
  type ZoneRecordDto,
} from "@tnp/shared-types";
import { apiRequest } from "../../lib/api";
import { errorMessage, errorStatus, isAbort } from "../../lib/services/errors";
import { newIdempotencyKey } from "../../lib/services/search";
import { isTerminalOperation } from "../../lib/services/status";
import {
  draftToChanges,
  EDITABLE_RECORD_TYPES,
  emptyRow,
  recordKey,
  rowFor,
  sameIntent,
  type ZoneAction,
  type ZoneDraftRow,
} from "../../lib/services/zone";
import { OperationRow } from "./OperationLog";
import { BUTTON_CLASSES, ErrorPanel, INPUT_CLASSES, LINK_BUTTON_CLASSES } from "./ui";

const POLL_INTERVAL_MS = 3_000;
/** After this long the page stops asking; reconciliation keeps working server-side. */
const POLL_LIMIT_MS = 5 * 60_000;

interface Preview {
  changes: ZoneChangeDto[];
  response: ZonePreviewResponse;
}

interface Intent {
  changes: ZoneChangeDto[];
  baseHash: string;
  key: string;
}

/**
 * Edits a provider-hosted zone: draft → preview (a diff against the zone as the
 * provider holds it now) → explicit confirmation → apply, then follows the
 * resulting operation to a terminal state.
 *
 * The `Idempotency-Key` belongs to a confirmed intent — these changes against
 * this preview's base hash. Retrying the same intent after a failure reuses
 * it, so a request that did reach the server is not applied twice; anything
 * that changes the intent (an edit, a new preview) gets a new key.
 */
export default function ZoneEditor({ domainId, onOperation }: { domainId: string; onOperation: (op: OperationDto) => void }) {
  const { t } = useTranslation("services");
  const baseId = useId();
  const [rows, setRows] = useState<ZoneDraftRow[]>(() => [emptyRow()]);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [applyPending, setApplyPending] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [operation, setOperation] = useState<OperationDto | null>(null);
  const [pollingStopped, setPollingStopped] = useState(false);

  const dialogRef = useRef<HTMLDialogElement>(null);
  const applyTriggerRef = useRef<HTMLButtonElement>(null);
  const previewButtonRef = useRef<HTMLButtonElement>(null);
  const onOperationRef = useRef(onOperation);
  onOperationRef.current = onOperation;

  const fieldId = (row: ZoneDraftRow, field: string) => `${baseId}-${row.key}-${field}`;

  useEffect(() => {
    if (!focusKey) return;
    document.getElementById(`${baseId}-${focusKey}-action`)?.focus();
    setFocusKey(null);
  }, [focusKey, baseId]);

  // The native dialog gives a focus trap, Escape and inert background; focus
  // goes back to the button that opened it.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialogOpen && !dialog.open) dialog.showModal();
    if (!dialogOpen && dialog.open) {
      dialog.close();
      // After a conflict or a success the trigger is gone with the preview.
      (applyTriggerRef.current ?? previewButtonRef.current)?.focus();
    }
  }, [dialogOpen]);

  // Follow the operation until it is terminal, the time limit passes or the
  // component unmounts. A chained timeout, so polls never overlap.
  const operationId = operation?.id ?? null;
  const operationTerminal = operation ? isTerminalOperation(operation.status) : true;
  useEffect(() => {
    if (!operationId || operationTerminal) return;
    const controller = new AbortController();
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      if (Date.now() - startedAt > POLL_LIMIT_MS) {
        setPollingStopped(true);
        return;
      }
      try {
        const ops = await apiRequest<OperationDto[]>("GET", `/services/domains/${domainId}/operations`, {
          signal: controller.signal,
        });
        const latest = ops.find((op) => op.id === operationId);
        if (latest) {
          setOperation(latest);
          onOperationRef.current(latest);
          if (isTerminalOperation(latest.status)) return;
        }
      } catch (err) {
        if (isAbort(err, controller.signal)) return;
        // A failed poll is not a failed operation: keep asking.
      }
      timer = setTimeout(poll, POLL_INTERVAL_MS);
    };
    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [operationId, operationTerminal, domainId]);

  const updateRows = (next: ZoneDraftRow[]) => {
    setRows(next);
    // Any edit makes the preview describe something else.
    setPreview(null);
    setPreviewError(null);
  };

  const updateRow = (key: string, patch: Partial<ZoneDraftRow>) =>
    updateRows(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  const addRow = (row: ZoneDraftRow) => {
    if (rows.length >= MAX_ZONE_CHANGES) return;
    updateRows([...rows, row]);
    setFocusKey(row.key);
  };

  const removeRow = (key: string) => updateRows(rows.filter((row) => row.key !== key));

  const runPreview = async () => {
    const parsed = draftToChanges(rows);
    if (!parsed.ok) {
      setPreviewError(t("zone.invalidDraft", { detail: parsed.error }));
      return;
    }
    setPreviewPending(true);
    setPreviewError(null);
    const body: ZonePreviewRequest = { changes: parsed.value };
    try {
      const response = await apiRequest<ZonePreviewResponse>("POST", `/services/domains/${domainId}/zone/preview`, { body });
      setPreview({ changes: parsed.value, response });
      setApplyError(null);
    } catch (err) {
      const message = errorMessage(err) ?? (errorStatus(err) === null ? t("errors.network") : t("zone.previewFailed"));
      setPreviewError(message);
      toast.error(message);
    } finally {
      setPreviewPending(false);
    }
  };

  const apply = async () => {
    if (!preview) return;
    const current = { changes: preview.changes, baseHash: preview.response.baseHash };
    const key = intent && sameIntent(intent, current) ? intent.key : newIdempotencyKey();
    setIntent({ ...current, key });
    setApplyPending(true);
    setApplyError(null);
    const body: ZoneApplyRequest = current;
    try {
      const response = await apiRequest<ZoneApplyResponse>("POST", `/services/domains/${domainId}/zone/changes`, {
        body,
        headers: { "Idempotency-Key": key },
      });
      setOperation(response.operation);
      setPollingStopped(false);
      onOperationRef.current(response.operation);
      setDialogOpen(false);
      setPreview(null);
      setIntent(null);
      setRows([emptyRow()]);
      toast.success(t("zone.applied"));
    } catch (err) {
      if (errorStatus(err) === 409) {
        // The zone moved under the preview, or the key met a different request:
        // either way the confirmed intent is stale and must be previewed again.
        setPreview(null);
        setIntent(null);
        setDialogOpen(false);
        const message = t("zone.conflict");
        setPreviewError(message);
        toast.error(message);
        return;
      }
      const message =
        errorStatus(err) === null ? t("zone.applyNetwork") : (errorMessage(err) ?? t("zone.applyFailed"));
      setApplyError(message);
      toast.error(message);
    } finally {
      setApplyPending(false);
    }
  };

  const actionLabel = (action: ZoneAction) => t(`zone.action.${action}`);

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        {rows.map((row, index) => (
          <fieldset key={row.key} className="rounded-md border border-border bg-surface p-3">
            <legend className="px-1 font-mono text-xs text-muted-foreground/70">
              {t("zone.rowLegend", { n: index + 1 })}
            </legend>
            <div className="flex flex-wrap items-end gap-3">
              <Field id={fieldId(row, "action")} label={t("zone.field.action")}>
                <select
                  id={fieldId(row, "action")}
                  value={row.action}
                  onChange={(e) => updateRow(row.key, { action: e.target.value as ZoneAction })}
                  className={INPUT_CLASSES}
                >
                  {(["add", "update", "delete"] as const).map((action) => (
                    <option key={action} value={action}>
                      {actionLabel(action)}
                    </option>
                  ))}
                </select>
              </Field>
              <button
                type="button"
                onClick={() => removeRow(row.key)}
                className="cursor-pointer pb-2 font-mono text-xs text-destructive transition-colors hover:text-destructive/80"
                aria-label={t("zone.removeRowLabel", { n: index + 1 })}
              >
                [{t("zone.removeRow")}]
              </button>
            </div>

            {row.action !== "add" && (
              <div className="mt-3">
                <p className="mb-2 font-mono text-xs text-muted-foreground/70">{t("zone.matchHeading")}</p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_7rem_1fr]">
                  <Field id={fieldId(row, "matchHost")} label={t("zone.field.host")}>
                    <input
                      id={fieldId(row, "matchHost")}
                      value={row.matchHost}
                      onChange={(e) => updateRow(row.key, { matchHost: e.target.value })}
                      className={`w-full ${INPUT_CLASSES}`}
                      spellCheck={false}
                    />
                  </Field>
                  <Field id={fieldId(row, "matchType")} label={t("zone.field.type")}>
                    <select
                      id={fieldId(row, "matchType")}
                      value={row.matchType}
                      onChange={(e) => updateRow(row.key, { matchType: e.target.value })}
                      className={`w-full ${INPUT_CLASSES}`}
                    >
                      <TypeOptions current={row.matchType} />
                    </select>
                  </Field>
                  <Field id={fieldId(row, "matchValue")} label={t("zone.field.value")}>
                    <input
                      id={fieldId(row, "matchValue")}
                      value={row.matchValue}
                      onChange={(e) => updateRow(row.key, { matchValue: e.target.value })}
                      className={`w-full ${INPUT_CLASSES}`}
                      spellCheck={false}
                    />
                  </Field>
                </div>
              </div>
            )}

            {row.action !== "delete" && (
              <div className="mt-3">
                {row.action === "update" && (
                  <p className="mb-2 font-mono text-xs text-muted-foreground/70">{t("zone.newRecordHeading")}</p>
                )}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_7rem_1fr_6rem_6rem]">
                  <Field id={fieldId(row, "host")} label={t("zone.field.host")}>
                    <input
                      id={fieldId(row, "host")}
                      value={row.host}
                      onChange={(e) => updateRow(row.key, { host: e.target.value })}
                      className={`w-full ${INPUT_CLASSES}`}
                      spellCheck={false}
                    />
                  </Field>
                  <Field id={fieldId(row, "type")} label={t("zone.field.type")}>
                    <select
                      id={fieldId(row, "type")}
                      value={row.type}
                      onChange={(e) => updateRow(row.key, { type: e.target.value })}
                      className={`w-full ${INPUT_CLASSES}`}
                    >
                      <TypeOptions current={row.type} />
                    </select>
                  </Field>
                  <Field id={fieldId(row, "value")} label={t("zone.field.value")}>
                    <input
                      id={fieldId(row, "value")}
                      value={row.value}
                      onChange={(e) => updateRow(row.key, { value: e.target.value })}
                      className={`w-full ${INPUT_CLASSES}`}
                      spellCheck={false}
                    />
                  </Field>
                  <Field id={fieldId(row, "ttl")} label={t("zone.field.ttl")}>
                    <input
                      id={fieldId(row, "ttl")}
                      inputMode="numeric"
                      value={row.ttl}
                      onChange={(e) => updateRow(row.key, { ttl: e.target.value })}
                      className={`w-full ${INPUT_CLASSES}`}
                    />
                  </Field>
                  <Field id={fieldId(row, "priority")} label={t("zone.field.priority")}>
                    <input
                      id={fieldId(row, "priority")}
                      inputMode="numeric"
                      value={row.priority}
                      onChange={(e) => updateRow(row.key, { priority: e.target.value })}
                      className={`w-full ${INPUT_CLASSES}`}
                      placeholder={row.type === "MX" ? "10" : ""}
                    />
                  </Field>
                </div>
              </div>
            )}
          </fieldset>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => addRow(emptyRow())}
          disabled={rows.length >= MAX_ZONE_CHANGES}
          className={LINK_BUTTON_CLASSES}
        >
          [{t("zone.addRow")}]
        </button>
        <button
          ref={previewButtonRef}
          type="button"
          onClick={runPreview}
          disabled={previewPending || rows.length === 0}
          className={BUTTON_CLASSES}
        >
          {previewPending ? t("zone.previewing") : t("zone.preview")}
        </button>
      </div>

      {previewError && <ErrorPanel message={previewError} />}

      {preview && (
        <section aria-labelledby={`${baseId}-preview-heading`} className="space-y-4 rounded-lg border border-border bg-card p-4">
          <h3 id={`${baseId}-preview-heading`} className="font-mono text-sm text-foreground">
            {t("zone.previewHeading")}
          </h3>
          <DiffList title={t("zone.added", { count: preview.response.added.length })} marker="+" records={preview.response.added} tone="text-success-text" />
          <DiffList title={t("zone.removed", { count: preview.response.removed.length })} marker="−" records={preview.response.removed} tone="text-error-text" />
          {preview.response.added.length === 0 && preview.response.removed.length === 0 && (
            <p className="font-mono text-xs text-muted-foreground/70">{t("zone.noDifference")}</p>
          )}
          <p className="font-mono text-xs text-warning-text">{t("zone.raceNotice")}</p>
          <button
            ref={applyTriggerRef}
            type="button"
            onClick={() => setDialogOpen(true)}
            disabled={applyPending || (preview.response.added.length === 0 && preview.response.removed.length === 0)}
            className={BUTTON_CLASSES}
          >
            {t("zone.reviewApply")}
          </button>

          <details className="font-mono text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              {t("zone.currentRecords", { count: preview.response.current.length })}
            </summary>
            <ul className="mt-2 space-y-1">
              {preview.response.current.map((record) => (
                <li key={recordKey(record)} className="flex flex-wrap items-center gap-2 text-muted-foreground">
                  <code className="break-all">{formatRecord(record)}</code>
                  <button type="button" onClick={() => addRow(rowFor("update", record))} className="cursor-pointer text-muted-foreground/70 hover:text-muted-foreground">
                    [{t("zone.action.update")}]
                  </button>
                  <button type="button" onClick={() => addRow(rowFor("delete", record))} className="cursor-pointer text-destructive hover:text-destructive/80">
                    [{t("zone.action.delete")}]
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}

      {operation && (
        <section aria-labelledby={`${baseId}-op-heading`} className="rounded-lg border border-border bg-card p-4">
          <h3 id={`${baseId}-op-heading`} className="mb-2 font-mono text-sm text-foreground">
            {t("zone.operationHeading")}
          </h3>
          <div aria-live="polite">
            <OperationRow operation={operation} />
            {pollingStopped && !isTerminalOperation(operation.status) && (
              <p className="mt-2 font-mono text-xs text-muted-foreground">{t("zone.pollingStopped")}</p>
            )}
          </div>
        </section>
      )}

      <dialog
        ref={dialogRef}
        aria-labelledby={`${baseId}-dialog-title`}
        aria-describedby={`${baseId}-dialog-desc`}
        onCancel={(e) => {
          e.preventDefault();
          if (!applyPending) setDialogOpen(false);
        }}
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-5 text-foreground backdrop:bg-background/80"
      >
        {preview && (
          <div className="space-y-4">
            <h3 id={`${baseId}-dialog-title`} className="font-pixel text-lg text-primary-text">
              {t("zone.confirmTitle")}
            </h3>
            <div id={`${baseId}-dialog-desc`} className="space-y-2 font-mono text-sm text-muted-foreground">
              <p>
                {t("zone.confirmSummary", {
                  added: preview.response.added.length,
                  removed: preview.response.removed.length,
                })}
              </p>
              <p className="text-xs">{t("zone.confirmConsequence")}</p>
              <p className="text-xs text-warning-text">{t("zone.raceNotice")}</p>
            </div>
            {applyError && (
              <p role="alert" className="font-mono text-xs text-error-text">
                {applyError}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-3">
              <button
                type="button"
                autoFocus
                onClick={() => setDialogOpen(false)}
                disabled={applyPending}
                className={LINK_BUTTON_CLASSES}
              >
                [{t("common.cancel")}]
              </button>
              <button type="button" onClick={apply} disabled={applyPending} className={BUTTON_CLASSES}>
                {applyPending ? t("zone.applying") : applyError ? t("zone.retryApply") : t("zone.apply")}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </div>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="font-mono text-xs text-muted-foreground/70">
        {label}
      </label>
      {children}
    </div>
  );
}

function TypeOptions({ current }: { current: string }) {
  const types: string[] = [...EDITABLE_RECORD_TYPES];
  // A record read from the zone may have a type the editor does not offer;
  // it must still be matchable.
  if (current && !types.includes(current)) types.push(current);
  return (
    <>
      {types.map((type) => (
        <option key={type} value={type}>
          {type}
        </option>
      ))}
    </>
  );
}

function formatRecord(record: ZoneRecordDto): string {
  const priority = record.priority === null ? "" : ` ${record.priority}`;
  return `${record.host} ${record.ttl} ${record.type}${priority} ${record.value}`;
}

function DiffList({ title, marker, records, tone }: { title: string; marker: string; records: ZoneRecordDto[]; tone: string }) {
  if (records.length === 0) return null;
  return (
    <div>
      <p className="mb-1 font-mono text-xs text-muted-foreground/70">{title}</p>
      <ul className="space-y-1 font-mono text-xs">
        {records.map((record) => (
          <li key={recordKey(record)} className={`break-all ${tone}`}>
            <span aria-hidden="true">{marker} </span>
            {formatRecord(record)}
          </li>
        ))}
      </ul>
    </div>
  );
}
