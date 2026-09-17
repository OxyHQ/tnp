import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TONE_CLASSES, type StatusPresentation, type Tone } from "../../lib/services/status";

// Small presentational pieces shared by the services pages. Every colour is a
// Bloom token; tone carries meaning, and the label always says it in words
// too, so nothing depends on colour alone.

export const BUTTON_CLASSES =
  "inline-flex cursor-pointer items-center justify-center rounded-md border border-primary/30 bg-primary/10 px-3 py-1.5 font-mono text-sm text-primary-text transition-colors hover:bg-primary/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50";

export const LINK_BUTTON_CLASSES =
  "cursor-pointer font-mono text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50";

export const INPUT_CLASSES =
  "rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground/70 transition-colors focus:border-primary focus:outline-none";

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-xs font-medium ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}

export function StatusBadge({ presentation }: { presentation: StatusPresentation }) {
  const { t } = useTranslation("services");
  return <Badge tone={presentation.tone}>{t(presentation.labelKey)}</Badge>;
}

/** "Public DNS" or "TNP Network": which namespace a name belongs to. */
export function NamespaceBadge({ namespace }: { namespace: "public-dns" | "tnp" }) {
  const { t } = useTranslation("services");
  return namespace === "public-dns" ? (
    <Badge tone="neutral">{t("namespace.publicDns")}</Badge>
  ) : (
    <span className="inline-flex items-center rounded-md border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-xs font-medium text-primary-text">
      {t("namespace.tnpNetwork")}
    </span>
  );
}

export function SandboxBadge() {
  const { t } = useTranslation("services");
  return (
    <span title={t("provider.sandboxHint")}>
      <Badge tone="warning">{t("provider.sandbox")}</Badge>
    </span>
  );
}

/** Name as the owner reads it, with the ASCII form when it differs. */
export function DomainName({ name, displayName }: { name: string; displayName: string | null }) {
  const { t } = useTranslation("services");
  const shown = displayName ?? name;
  return (
    <span className="font-mono text-sm text-foreground break-all">
      {shown}
      {shown !== name && (
        <span className="ml-2 text-xs text-muted-foreground/70">
          ({t("domain.ascii")}: {name})
        </span>
      )}
    </span>
  );
}

export function ErrorPanel({ message, onRetry, retrying }: { message: string; onRetry?: () => void; retrying?: boolean }) {
  const { t } = useTranslation("services");
  return (
    <div role="alert" className="rounded-lg border border-error-text/30 bg-error-subtle p-4">
      <p className="font-mono text-sm text-error-text">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} disabled={retrying} className={`mt-3 ${LINK_BUTTON_CLASSES}`}>
          [{t("common.retry")}]
        </button>
      )}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-border bg-card p-5 ${className}`}>{children}</div>;
}
