import { useTranslation } from "react-i18next";
import type { MoneyDto, QuoteDto } from "@tnp/shared-types";
import { formatMoney } from "../../lib/services/money";
import { useLocaleFormatter } from "../../lib/useLocaleFormatter";

const EXPIRY_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" };

/**
 * A quote as the provider priced it: total, the fees included in it, and the
 * renewal price, which is shown before any purchase so the second year is
 * never a surprise. Expiry is when the quote stops being honoured.
 */
export default function QuoteView({ quote }: { quote: QuoteDto }) {
  const { t, i18n } = useTranslation("services");
  const { formatDate, formatRelativeTime } = useLocaleFormatter();

  const money = (value: MoneyDto) =>
    formatMoney(value, i18n.language) ?? t("quote.unformattable", { amount: value.amountMinor, currency: value.currency });

  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 font-mono text-sm sm:grid-cols-[max-content_1fr]">
      <dt className="text-xs text-muted-foreground/70">{t("quote.price", { count: quote.years })}</dt>
      <dd className="text-foreground">{money(quote.price)}</dd>

      <dt className="text-xs text-muted-foreground/70">{t("quote.fees")}</dt>
      <dd className="text-muted-foreground">{money(quote.fees)}</dd>

      <dt className="text-xs text-muted-foreground/70">{t("quote.renewal")}</dt>
      <dd className="text-muted-foreground">
        {quote.renewalPrice ? t("quote.perYear", { price: money(quote.renewalPrice) }) : t("quote.renewalUnknown")}
      </dd>

      <dt className="text-xs text-muted-foreground/70">{t("quote.expires")}</dt>
      <dd className="text-muted-foreground">
        <time dateTime={quote.expiresAt}>{formatDate(quote.expiresAt, EXPIRY_FORMAT)}</time>{" "}
        <span className="text-muted-foreground/70">({formatRelativeTime(quote.expiresAt)})</span>
      </dd>

      {quote.premium && (
        <>
          <dt className="text-xs text-muted-foreground/70">{t("search.premium")}</dt>
          <dd className="text-muted-foreground">{t("quote.premiumNote")}</dd>
        </>
      )}
    </dl>
  );
}
