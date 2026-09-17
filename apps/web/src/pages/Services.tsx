import { Helmet } from "react-helmet-async";
import { useTranslation } from "react-i18next";
import { useAuth } from "../lib/auth";
import { useServicesStatus } from "../lib/services/useServicesStatus";
import { purchaseBlockedKey } from "../lib/services/status";
import DomainSearch from "../components/services/DomainSearch";
import Inventory from "../components/services/Inventory";
import { NamespaceExplainer, ServicesNotAvailable } from "../components/services/ServicesNotice";
import { BUTTON_CLASSES, Card } from "../components/services/ui";

/**
 * Services: the optional area for public DNS domains next to TNP Network
 * (docs/architecture/services.md). Everything below the explanation is gated
 * on `GET /services/status`; what the API has not enabled is not drawn.
 *
 * The explanation and status are public, like /network. Search and the
 * owner's inventory need a session, as /dashboard does.
 */
export default function Services() {
  const { t } = useTranslation("services");
  const { isAuthenticated, signIn } = useAuth();
  const { availability, recheck } = useServicesStatus();

  return (
    <div className="mx-auto max-w-[1200px] space-y-10 px-4 py-16 lg:px-6">
      <Helmet>
        <title>{t("meta.title")} — TNP</title>
        <meta name="description" content={t("meta.description")} />
      </Helmet>

      <header className="space-y-2">
        <h1 className="font-pixel text-xl text-primary-text">{t("heading")}</h1>
        <p className="max-w-3xl font-mono text-sm text-muted-foreground/70">{t("subtitle")}</p>
      </header>

      <NamespaceExplainer />

      <div aria-live="polite" aria-busy={availability.kind === "loading"}>
        {availability.kind === "loading" && (
          <p className="font-mono text-sm text-muted-foreground/70">{t("status.checking")}</p>
        )}
        {availability.kind === "not_available" && (
          <ServicesNotAvailable availability={availability} onRecheck={recheck} />
        )}
      </div>

      {availability.kind === "available" && (
        <>
          {!availability.status.purchasable && (
            <Card className="space-y-1">
              <h2 className="font-mono text-sm text-foreground">{t("purchase.heading")}</h2>
              <p className="font-mono text-xs text-muted-foreground">
                {t(purchaseBlockedKey(availability.status.purchaseBlockedReason))}
              </p>
            </Card>
          )}

          {isAuthenticated ? (
            <>
              <DomainSearch status={availability.status} />
              <Inventory />
            </>
          ) : (
            <Card className="space-y-4 text-center">
              <p className="font-mono text-sm text-muted-foreground/70">{t("signInPrompt")}</p>
              <button type="button" onClick={() => signIn()} className={BUTTON_CLASSES}>
                [{t("signIn")}]
              </button>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
