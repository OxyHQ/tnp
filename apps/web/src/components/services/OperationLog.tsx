import { useTranslation } from "react-i18next";
import type { OperationDto } from "@tnp/shared-types";
import { operationPresentation } from "../../lib/services/status";
import { useLocaleFormatter } from "../../lib/useLocaleFormatter";
import { StatusBadge } from "./ui";

const TIME_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };

/** One operation: kind, status in words, and what the owner can do about it. */
export function OperationRow({ operation }: { operation: OperationDto }) {
  const { t } = useTranslation("services");
  const { formatDate } = useLocaleFormatter();
  // Kinds are dotted (`dns.apply`), and a dot is i18next's key separator.
  const kindKey = `operation.kind.${operation.kind.replace(/\./g, "_")}`;

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 font-mono text-sm">
        <span className="text-foreground">{t(kindKey, { defaultValue: operation.kind })}</span>
        <StatusBadge presentation={operationPresentation(operation.status)} />
        <time dateTime={operation.createdAt} className="text-xs text-muted-foreground/70">
          {formatDate(operation.createdAt, TIME_FORMAT)}
        </time>
      </div>
      <p className="font-mono text-xs text-muted-foreground/70">{t(`operation.explain.${operation.status}`)}</p>
      {operation.status === "failed" && operation.errorMessage && (
        <p className="font-mono text-xs text-error-text">{operation.errorMessage}</p>
      )}
      {operation.status !== "failed" && operation.errorMessage && (
        // A message on a non-failed operation is context (why it is being
        // checked, what review needs), not a failure, so it is not red.
        <p className="font-mono text-xs text-muted-foreground">{operation.errorMessage}</p>
      )}
    </div>
  );
}

export default function OperationLog({ operations }: { operations: OperationDto[] }) {
  const { t } = useTranslation("services");
  if (operations.length === 0) {
    return <p className="font-mono text-sm text-muted-foreground/70">{t("operations.empty")}</p>;
  }
  return (
    <ol className="space-y-3">
      {operations.map((operation) => (
        <li key={operation.id} className="rounded-md border border-border bg-surface p-3">
          <OperationRow operation={operation} />
        </li>
      ))}
    </ol>
  );
}
