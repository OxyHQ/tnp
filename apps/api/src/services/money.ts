/**
 * Money as an integer count of minor units plus an ISO 4217 currency.
 *
 * Never a float: `0.1 + 0.2` is not a price anyone agreed to. Amounts are
 * `bigint` in memory and in PostgreSQL, and cross the wire as decimal strings
 * because JSON numbers are doubles.
 */

export interface Money {
  /** ISO 4217 alphabetic code, upper case. */
  readonly currency: string;
  /** Amount in the currency's minor unit (cents for USD). */
  readonly minor: bigint;
}

/** Wire form of {@link Money}: the amount is a decimal string of minor units. */
export interface MoneyDto {
  currency: string;
  amountMinor: string;
}

const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Minor-unit exponents that differ from 2. A currency absent from this table
 * uses 2, which is right for every currency a registrar has quoted us so far;
 * a provider quoting in one of these is handled correctly rather than
 * silently scaled by 100.
 */
const EXPONENTS: Readonly<Record<string, number>> = {
  BHD: 3, CLP: 0, IQD: 3, ISK: 0, JOD: 3, JPY: 0, KRW: 0, KWD: 3, LYD: 3,
  OMR: 3, PYG: 0, TND: 3, UGX: 0, VND: 0, XAF: 0, XOF: 0,
};

export function currencyExponent(currency: string): number {
  return EXPONENTS[currency] ?? 2;
}

export function assertCurrency(currency: string): string {
  if (!CURRENCY_RE.test(currency)) {
    throw new RangeError(`not an ISO 4217 currency code: ${JSON.stringify(currency)}`);
  }
  return currency;
}

/**
 * Parse a provider's decimal price string ("12.98") into minor units exactly.
 *
 * String arithmetic, not `parseFloat(x) * 100`: `8.95 * 100` is `894.9999…`.
 * More fractional digits than the currency has is an error rather than a
 * rounding decision this function has no authority to make.
 */
export function parseDecimalAmount(value: string, currency: string): Money {
  assertCurrency(currency);
  const trimmed = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new RangeError(`not a non-negative decimal amount: ${JSON.stringify(value)}`);
  }
  const exponent = currencyExponent(currency);
  const whole = match[1];
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > exponent) {
    throw new RangeError(
      `${JSON.stringify(value)} has more precision than ${currency} minor units allow`,
    );
  }
  const minor = BigInt(whole + fraction.padEnd(exponent, "0"));
  return { currency, minor };
}

export function formatDecimalAmount(money: Money): string {
  const exponent = currencyExponent(money.currency);
  const negative = money.minor < 0n;
  const digits = (negative ? -money.minor : money.minor).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? "-" : ""}${whole}${exponent > 0 ? `.${fraction}` : ""}`;
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new RangeError(`cannot add ${a.currency} to ${b.currency}`);
  }
  return { currency: a.currency, minor: a.minor + b.minor };
}

export function multiplyMoney(a: Money, factor: number): Money {
  if (!Number.isInteger(factor)) throw new RangeError("factor must be an integer");
  return { currency: a.currency, minor: a.minor * BigInt(factor) };
}

export function toMoneyDto(money: Money): MoneyDto {
  return { currency: money.currency, amountMinor: money.minor.toString() };
}
