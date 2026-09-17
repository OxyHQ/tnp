import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  MAX_AVAILABILITY_NAMES,
  type PublicAvailability,
  type PublicAvailabilityResponse,
  type QuoteDto,
  type QuoteRequest,
  type ServicesStatus,
} from "@tnp/shared-types";
import { apiRequest } from "../../lib/api";
import { errorMessage, errorStatus, isAbort } from "../../lib/services/errors";
import { availabilityPath, parseSearchInput } from "../../lib/services/search";
import { availabilityPresentation, canQuote, purchaseBlockedKey } from "../../lib/services/status";
import QuoteView from "./QuoteView";
import { BUTTON_CLASSES, Badge, DomainName, ErrorPanel, INPUT_CLASSES, NamespaceBadge, StatusBadge } from "./ui";

const DEBOUNCE_MS = 400;

type SearchState =
  | { kind: "idle" }
  | { kind: "searching" }
  | { kind: "done"; results: PublicAvailability[] }
  | { kind: "error"; message: string };

type QuoteState = { kind: "pending" } | { kind: "ready"; quote: QuoteDto } | { kind: "error"; message: string };

/**
 * Public-domain availability search, with a quote for names that are
 * available. Every name here is a public DNS name; a quote is information,
 * not a reservation and not a purchase.
 */
export default function DomainSearch({ status }: { status: ServicesStatus }) {
  const { t } = useTranslation("services");
  const inputId = useId();
  const hintId = useId();
  const [raw, setRaw] = useState("");
  const [state, setState] = useState<SearchState>({ kind: "idle" });
  const [quotes, setQuotes] = useState<Record<string, QuoteState>>({});
  const [attempt, setAttempt] = useState(0);

  const { names, dropped } = parseSearchInput(raw);
  const namesKey = names.join(",");

  // Debounced search. A new keystroke clears the timer and aborts the request
  // already in flight, so a slow answer to an old query can never overwrite
  // the answer to the current one.
  useEffect(() => {
    if (!namesKey) {
      setState({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setState({ kind: "searching" });
      apiRequest<PublicAvailabilityResponse>("GET", availabilityPath(namesKey.split(",")), { signal: controller.signal })
        .then((response) => {
          setState({ kind: "done", results: response.results });
          setQuotes({});
        })
        .catch((err: unknown) => {
          if (isAbort(err, controller.signal)) return;
          const message = errorMessage(err) ?? t("search.failed");
          setState({ kind: "error", message });
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [namesKey, attempt, t]);

  const requestQuote = async (name: string) => {
    setQuotes((prev) => ({ ...prev, [name]: { kind: "pending" } }));
    const body: QuoteRequest = { name, years: 1 };
    try {
      const quote = await apiRequest<QuoteDto>("POST", "/services/quotes", { body });
      setQuotes((prev) => ({ ...prev, [name]: { kind: "ready", quote } }));
    } catch (err) {
      const message =
        errorMessage(err) ?? (errorStatus(err) === null ? t("errors.network") : t("quote.failed"));
      setQuotes((prev) => ({ ...prev, [name]: { kind: "error", message } }));
      toast.error(message);
    }
  };

  return (
    <section aria-labelledby={`${inputId}-heading`} className="space-y-4">
      <h2 id={`${inputId}-heading`} className="font-pixel text-lg text-primary-text">
        {t("search.heading")}
      </h2>

      <div className="space-y-2">
        <label htmlFor={inputId} className="block font-mono text-xs uppercase tracking-wider text-muted-foreground/70">
          {t("search.label")}
        </label>
        <input
          id={inputId}
          type="search"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder={t("search.placeholder")}
          aria-describedby={hintId}
          autoComplete="off"
          spellCheck={false}
          className={`w-full ${INPUT_CLASSES}`}
        />
        <p id={hintId} className="font-mono text-xs text-muted-foreground/70">
          {t("search.hint", { max: MAX_AVAILABILITY_NAMES })}
        </p>
        {dropped > 0 && (
          <p className="font-mono text-xs text-warning-text">
            {t("search.dropped", { count: dropped, max: MAX_AVAILABILITY_NAMES })}
          </p>
        )}
      </div>

      <p className="rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-muted-foreground">
        {t("search.notReservation")}
      </p>

      <div aria-live="polite" aria-busy={state.kind === "searching"} className="space-y-3">
        {state.kind === "searching" && (
          <p className="font-mono text-sm text-muted-foreground/70">{t("search.searching")}</p>
        )}
        {state.kind === "error" && (
          <ErrorPanel message={state.message} onRetry={() => setAttempt((n) => n + 1)} />
        )}
        {state.kind === "done" && state.results.length === 0 && (
          <p className="font-mono text-sm text-muted-foreground/70">{t("search.noResults")}</p>
        )}
        {state.kind === "done" && state.results.length > 0 && (
          <>
            <p className="sr-only">{t("search.resultCount", { count: state.results.length })}</p>
            <ul className="space-y-3">
              {state.results.map((result) => {
                const quoteName = result.name ?? result.input;
                const quote = quotes[quoteName];
                return (
                  <li key={result.input} className="rounded-lg border border-border bg-card p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      {result.name ? (
                        <DomainName name={result.name} displayName={result.displayName} />
                      ) : (
                        <span className="font-mono text-sm text-foreground break-all">{result.input}</span>
                      )}
                      <NamespaceBadge namespace="public-dns" />
                      <StatusBadge presentation={availabilityPresentation(result.status)} />
                      {result.premium && <Badge tone="info">{t("search.premium")}</Badge>}
                    </div>
                    <p className="mt-2 font-mono text-xs text-muted-foreground/70">
                      {t(`availability.explain.${result.status}`)}
                      {result.detail ? ` ${result.detail}` : ""}
                    </p>

                    {canQuote(result.status) && result.name && (
                      <div className="mt-3 space-y-3 border-t border-border pt-3">
                        {quote?.kind !== "ready" && (
                          <button
                            type="button"
                            onClick={() => requestQuote(quoteName)}
                            disabled={quote?.kind === "pending"}
                            className={BUTTON_CLASSES}
                          >
                            {quote?.kind === "pending" ? t("quote.pending") : t("quote.get")}
                          </button>
                        )}
                        {quote?.kind === "error" && (
                          <p role="alert" className="font-mono text-xs text-error-text">{quote.message}</p>
                        )}
                        {quote?.kind === "ready" && (
                          <>
                            <QuoteView quote={quote.quote} />
                            {!status.purchasable && (
                              <p className="font-mono text-xs text-warning-text">
                                {t(purchaseBlockedKey(status.purchaseBlockedReason))}
                              </p>
                            )}
                            <button
                              type="button"
                              onClick={() => requestQuote(quoteName)}
                              className="cursor-pointer font-mono text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground"
                            >
                              [{t("quote.refresh")}]
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
