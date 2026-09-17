import type { MoneyDto } from "@tnp/shared-types";

/**
 * Money from `/services` arrives as a decimal string of minor units (see
 * `MoneyDto`), because a JSON number is a double and a double stops counting
 * integers exactly at 2^53. Converting it with `parseFloat` or `Number` would
 * reintroduce exactly the loss the wire format avoids.
 *
 * So the amount stays a `bigint` end to end: the whole part is formatted as a
 * `bigint` (which `Intl.NumberFormat` handles exactly), and the fraction digits
 * are spliced in as digits, never as a fraction of a double. The number of
 * fraction digits is the currency's own (ISO 4217: JPY 0, USD 2, KWD 3), read
 * from `Intl` rather than a hand-kept table.
 */

const MINOR_RE = /^-?\d+$/;

/** The currency's minor-unit exponent, or null for a code `Intl` rejects. */
export function currencyDecimals(currency: string): number | null {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? null;
  } catch {
    return null;
  }
}

/**
 * Formats `amountMinor` of `currency` for `locale`.
 *
 * Returns null when the amount is not an integer string or the currency is not
 * a code `Intl` knows: a caller shows the raw value instead of a wrong price.
 */
export function formatMinorUnits(amountMinor: string, currency: string, locale: string): string | null {
  if (!MINOR_RE.test(amountMinor)) return null;
  const decimals = currencyDecimals(currency);
  if (decimals === null) return null;

  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  } catch {
    // An unknown locale tag: fall back to the default locale, not to no price.
    formatter = new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  const value = BigInt(amountMinor);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = magnitude / scale;
  const fraction = (magnitude % scale).toString().padStart(decimals, "0");

  // A bigint has no -0, so "-0.50" is laid out from -1 and its integer digits
  // replaced; any other amount is laid out from its own whole part.
  const template = negative ? (whole === 0n ? -1n : -whole) : whole;
  const parts = formatter.formatToParts(template);
  const digits = localDigits(formatter);

  let integerReplaced = false;
  return parts
    .map((part) => {
      if (part.type === "fraction") return transliterate(fraction, digits);
      if (negative && whole === 0n && part.type === "integer") {
        if (integerReplaced) return "";
        integerReplaced = true;
        return digits[0];
      }
      return part.value;
    })
    .join("");
}

/** `formatMinorUnits` for a `MoneyDto`. */
export function formatMoney(money: MoneyDto, locale: string): string | null {
  return formatMinorUnits(money.amountMinor, money.currency, locale);
}

/** The ten digits of the formatter's numbering system, in order. */
function localDigits(formatter: Intl.NumberFormat): string[] {
  const { locale, numberingSystem } = formatter.resolvedOptions();
  const plain = new Intl.NumberFormat(locale, { numberingSystem, useGrouping: false });
  return Array.from({ length: 10 }, (_, d) => plain.format(d));
}

function transliterate(asciiDigits: string, digits: string[]): string {
  return Array.from(asciiDigits, (c) => digits[c.charCodeAt(0) - 48]).join("");
}
