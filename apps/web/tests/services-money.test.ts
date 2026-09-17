import { describe, expect, test } from "bun:test";
import { currencyDecimals, formatMinorUnits } from "../src/lib/services/money";

/**
 * Money arrives as a string of minor units. These pin the two ways that goes
 * wrong: the wrong number of decimals for a currency, and a double silently
 * rounding an amount past 2^53.
 */

describe("currency decimals come from ISO 4217 via Intl", () => {
  test("0, 2 and 3 decimal currencies", () => {
    expect(currencyDecimals("JPY")).toBe(0);
    expect(currencyDecimals("USD")).toBe(2);
    expect(currencyDecimals("KWD")).toBe(3);
  });

  test("an invalid code is null, not a guess", () => {
    expect(currencyDecimals("not-a-currency")).toBeNull();
  });
});

describe("formatMinorUnits", () => {
  test("two decimals", () => {
    expect(formatMinorUnits("1299", "USD", "en")).toBe("$12.99");
    expect(formatMinorUnits("5", "USD", "en")).toBe("$0.05");
    expect(formatMinorUnits("0", "USD", "en")).toBe("$0.00");
  });

  test("zero decimals: the minor unit is the unit", () => {
    expect(formatMinorUnits("1500", "JPY", "en")).toBe("¥1,500");
  });

  test("three decimals", () => {
    expect(formatMinorUnits("12345", "KWD", "en")).toBe(new Intl.NumberFormat("en", { style: "currency", currency: "KWD" }).format(12.345));
    expect(formatMinorUnits("12345", "KWD", "en")).toContain("12.345");
  });

  test("values beyond 2^53 keep every digit", () => {
    // 2^53 + 1 minor units: a double would print ...992 or ...994.
    expect(formatMinorUnits("9007199254740993", "USD", "en")).toBe("$90,071,992,547,409.93");
    expect(formatMinorUnits("123456789012345678901234567", "JPY", "en")).toBe("¥123,456,789,012,345,678,901,234,567");
    expect(formatMinorUnits("98765432109876543210987", "KWD", "en")).toContain("98,765,432,109,876,543,210.987");
  });

  test("negative amounts, including under one unit", () => {
    expect(formatMinorUnits("-1299", "USD", "en")).toBe("-$12.99");
    expect(formatMinorUnits("-50", "USD", "en")).toBe("-$0.50");
  });

  test("follows the locale's separators", () => {
    const fr = formatMinorUnits("123456789", "EUR", "fr");
    expect(fr).not.toBeNull();
    expect(fr!.replace(/\s/g, " ")).toBe("1 234 567,89 €");
    expect(formatMinorUnits("123456789", "EUR", "fr")).toBe(new Intl.NumberFormat("fr", { style: "currency", currency: "EUR" }).format(1234567.89));
  });

  test("a locale with its own digits gets its own digits in the fraction too", () => {
    const expected = new Intl.NumberFormat("ar-EG", { style: "currency", currency: "USD" }).format(12.34);
    expect(formatMinorUnits("1234", "USD", "ar-EG")).toBe(expected);
  });

  test("rejects anything that is not an integer string", () => {
    expect(formatMinorUnits("12.99", "USD", "en")).toBeNull();
    expect(formatMinorUnits("1e3", "USD", "en")).toBeNull();
    expect(formatMinorUnits("", "USD", "en")).toBeNull();
    expect(formatMinorUnits("100", "XXXX", "en")).toBeNull();
  });
});
