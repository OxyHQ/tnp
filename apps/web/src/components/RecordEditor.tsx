import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DNS_RECORD_TTL_MAX,
  DNS_RECORD_TTL_MIN,
  DNS_RECORD_TYPES,
  parseCreateDnsRecordRequest,
  type DnsRecordField,
  type DnsRecordInput,
} from "@tnp/shared-types";

/** A field-level failure: from the shared parser locally, or from the API's 400. */
export interface RecordFieldError {
  field: DnsRecordField;
  code: string;
  message: string;
}

interface RecordEditorProps {
  /**
   * Called with a record the shared parser accepted, in its stored form (an MX
   * value already carries its priority). Resolves to null on success, or to the
   * field error the API reported so it can be shown inline.
   */
  onSubmit: (record: DnsRecordInput) => Promise<RecordFieldError | null>;
  /** Disables the form while this editor's own request is in flight. */
  pending?: boolean;
}

const INPUT_CLASS =
  "block rounded-md border bg-surface px-3 py-2 font-mono text-sm text-foreground aria-[invalid=true]:border-destructive";

export default function RecordEditor({ onSubmit, pending = false }: RecordEditorProps) {
  const { t } = useTranslation("common");
  const id = useId();
  const [type, setType] = useState<string>("A");
  const [name, setName] = useState("@");
  const [value, setValue] = useState("");
  const [priority, setPriority] = useState("10");
  const [ttl, setTtl] = useState("3600");
  const [error, setError] = useState<RecordFieldError | null>(null);

  const isMx = type === "MX";

  // Translated by code, so the message reads in the page's language; the
  // parser's English text is the fallback for a code this build does not know.
  const messageFor = (err: RecordFieldError) =>
    t(`recordErrors.${err.code}`, {
      defaultValue: err.message,
      min: DNS_RECORD_TTL_MIN,
      max: DNS_RECORD_TTL_MAX,
    });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;

    // The same parser the API validates with. The web sends the normalized
    // record, so an MX goes out as "<priority> <host>" — a form every API
    // version accepts, including images older than the structured field.
    const parsed = parseCreateDnsRecordRequest({
      type,
      name,
      value,
      ttl: ttl.trim() === "" ? undefined : Number(ttl),
      priority: isMx && priority.trim() !== "" ? Number(priority) : undefined,
    });
    if (!parsed.ok) {
      setError({ field: parsed.field, code: parsed.code, message: parsed.error });
      return;
    }

    setError(null);
    const rejected = await onSubmit(parsed.value);
    if (rejected) {
      setError(rejected);
      return;
    }
    setValue("");
    setName("@");
  };

  const errorId = `${id}-error`;
  const invalid = (field: DnsRecordField) => error?.field === field;
  const describedBy = (field: DnsRecordField) => (invalid(field) ? errorId : undefined);

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1">
          <label htmlFor={`${id}-type`} className="font-mono text-xs text-muted-foreground/70">
            {t("form.type")}
          </label>
          <select
            id={`${id}-type`}
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-invalid={invalid("type")}
            aria-describedby={describedBy("type")}
            className={`${INPUT_CLASS} border-border`}
          >
            {DNS_RECORD_TYPES.map((rt) => (
              <option key={rt} value={rt}>{rt}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-name`} className="font-mono text-xs text-muted-foreground/70">
            {t("form.name")}
          </label>
          <input
            id={`${id}-name`}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={invalid("name")}
            aria-describedby={describedBy("name")}
            className={`${INPUT_CLASS} border-border`}
            placeholder={t("placeholder.recordName")}
            required
          />
        </div>
        {isMx && (
          <div className="space-y-1">
            <label htmlFor={`${id}-priority`} className="font-mono text-xs text-muted-foreground/70">
              {t("form.priority")}
            </label>
            <input
              id={`${id}-priority`}
              type="number"
              inputMode="numeric"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              aria-invalid={invalid("priority")}
              aria-describedby={describedBy("priority")}
              className={`${INPUT_CLASS} w-24 border-border`}
              min={0}
              max={65535}
            />
          </div>
        )}
        <div className="flex-1 space-y-1">
          <label htmlFor={`${id}-value`} className="font-mono text-xs text-muted-foreground/70">
            {isMx ? t("form.mailHost") : t("form.value")}
          </label>
          <input
            id={`${id}-value`}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={invalid("value")}
            aria-describedby={describedBy("value")}
            className={`${INPUT_CLASS} w-full border-border`}
            placeholder={t(`placeholder.recordValueByType.${type}`, {
              defaultValue: t("placeholder.recordValue"),
            })}
            required
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-ttl`} className="font-mono text-xs text-muted-foreground/70">
            {t("form.ttl")}
          </label>
          <input
            id={`${id}-ttl`}
            type="number"
            inputMode="numeric"
            value={ttl}
            onChange={(e) => setTtl(e.target.value)}
            aria-invalid={invalid("ttl")}
            aria-describedby={describedBy("ttl")}
            className={`${INPUT_CLASS} w-24 border-border`}
            min={DNS_RECORD_TTL_MIN}
            max={DNS_RECORD_TTL_MAX}
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className="cursor-pointer rounded-md border border-primary/30 bg-primary/10 px-3 py-2 font-mono text-sm text-primary-text transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? t("saving") : t("addRecord")}
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="font-mono text-xs text-error-text">
          {messageFor(error)}
        </p>
      )}
    </form>
  );
}
