import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface ReleaseDomainDialogProps {
  /** The full name, e.g. `nate.ox`, which must be typed to confirm. */
  domain: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation for releasing a native domain.
 *
 * Releasing is irreversible and public: the registration, its records and its
 * service node are deleted, and anyone may register the name next. A bare
 * `confirm()` reduced that to one click on a generic question, so this dialog
 * states the consequences and asks for the full name to be typed.
 *
 * Modal semantics without a library: focus moves into the dialog on open, Tab
 * stays inside it, Escape cancels, and focus returns to whatever opened it.
 */
export default function ReleaseDomainDialog({
  domain,
  pending,
  onConfirm,
  onCancel,
}: ReleaseDomainDialogProps) {
  const { t } = useTranslation("dashboard");
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState("");

  const matches = typed.trim().toLowerCase() === domain.toLowerCase();

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    inputRef.current?.focus();
    return () => opener?.focus();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && !pending) {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== "Tab" || !dialogRef.current) return;

    const focusable = Array.from(
      dialogRef.current.querySelectorAll<HTMLElement>("input, button:not([disabled])"),
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (matches && !pending) onConfirm();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-background/80 px-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !pending) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onKeyDown={handleKeyDown}
        className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-lg"
      >
        <h2 id={`${id}-title`} className="mb-3 font-mono text-sm font-medium text-destructive">
          {t("release.title", { domain })}
        </h2>
        <div id={`${id}-description`} className="mb-4 space-y-2 font-mono text-xs text-muted-foreground">
          <p>{t("release.consequences")}</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>{t("release.recordsDeleted")}</li>
            <li>{t("release.nodeDeleted")}</li>
            <li>{t("release.nameReleased")}</li>
          </ul>
          <p>{t("release.irreversible")}</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={`${id}-confirm`} className="font-mono text-xs text-muted-foreground">
              {t("release.typeToConfirm", { domain })}
            </label>
            <input
              ref={inputRef}
              id={`${id}-confirm`}
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              disabled={pending}
              placeholder={domain}
              className="block w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-foreground"
            />
          </div>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={pending}
              className="cursor-pointer rounded-md border border-border px-3 py-2 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {t("release.cancel")}
            </button>
            <button
              type="submit"
              disabled={!matches || pending}
              aria-busy={pending}
              className="cursor-pointer rounded-md border border-destructive/40 bg-error-subtle px-3 py-2 font-mono text-xs text-error-text transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? t("release.releasing") : t("release.confirm")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
