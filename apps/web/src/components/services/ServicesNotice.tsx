import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { ServicesAvailability } from "../../lib/services/status";
import { Card, LINK_BUTTON_CLASSES, NamespaceBadge } from "./ui";

/**
 * "Services are not available yet": the state for an API without `/services`
 * (the web ships first), a disabled catalog, or an API that did not answer.
 * An explanation, not an error, and no controls that would lead nowhere.
 */
export function ServicesNotAvailable({
  availability,
  onRecheck,
}: {
  availability: Extract<ServicesAvailability, { kind: "not_available" }>;
  onRecheck: () => void;
}) {
  const { t } = useTranslation("services");
  return (
    <Card className="space-y-3">
      <h2 className="font-pixel text-lg text-primary-text">{t("notAvailable.heading")}</h2>
      <p className="font-mono text-sm text-muted-foreground">{t("notAvailable.body")}</p>
      {availability.reason === "unreachable" && (
        <p className="font-mono text-xs text-muted-foreground/70">{t("notAvailable.unreachable")}</p>
      )}
      <p className="font-mono text-xs text-muted-foreground/70">
        {t("notAvailable.networkUnaffected")}{" "}
        <Link to="/register" className="text-primary-text transition-colors hover:text-foreground">
          {t("notAvailable.registerNative")}
        </Link>
      </p>
      {availability.reason === "unreachable" && (
        <button type="button" onClick={onRecheck} className={LINK_BUTTON_CLASSES}>
          [{t("notAvailable.recheck")}]
        </button>
      )}
    </Card>
  );
}

/** The two namespaces side by side, said once per page. */
export function NamespaceExplainer() {
  const { t } = useTranslation("services");
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
      <Card className="space-y-2">
        <NamespaceBadge namespace="tnp" />
        <p className="font-mono text-sm text-muted-foreground">{t("namespace.tnpExplain")}</p>
        <Link to="/register" className="inline-block font-mono text-xs text-primary-text transition-colors hover:text-foreground">
          [{t("namespace.tnpAction")}]
        </Link>
      </Card>
      <Card className="space-y-2">
        <NamespaceBadge namespace="public-dns" />
        <p className="font-mono text-sm text-muted-foreground">{t("namespace.publicExplain")}</p>
        <p className="font-mono text-xs text-muted-foreground/70">{t("namespace.notNative")}</p>
      </Card>
    </div>
  );
}
