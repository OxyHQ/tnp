import { describe, expect, test } from "bun:test";
import { addMoney, formatDecimalAmount, parseDecimalAmount, toMoneyDto } from "./money.js";

describe("money", () => {
  test("parses decimal prices exactly, where float arithmetic would not", () => {
    // 8.95 * 100 === 894.9999999999999 in IEEE 754.
    expect(parseDecimalAmount("8.95", "USD").minor).toBe(895n);
    expect(parseDecimalAmount("12.9", "USD").minor).toBe(1290n);
    expect(parseDecimalAmount("0", "USD").minor).toBe(0n);
    expect(parseDecimalAmount("1500", "JPY").minor).toBe(1500n);
    expect(parseDecimalAmount("1.234", "KWD").minor).toBe(1234n);
    expect(parseDecimalAmount("10.500", "USD").minor).toBe(1050n);
  });

  test("refuses precision the currency does not have instead of rounding", () => {
    expect(() => parseDecimalAmount("1.005", "USD")).toThrow(RangeError);
    expect(() => parseDecimalAmount("1.5", "JPY")).toThrow(RangeError);
  });

  test("refuses malformed amounts and currencies", () => {
    for (const bad of ["", "-1.00", "1e3", "1,00", " .5", "NaN"]) {
      expect(() => parseDecimalAmount(bad, "USD")).toThrow(RangeError);
    }
    expect(() => parseDecimalAmount("1.00", "usd")).toThrow(RangeError);
  });

  test("formats and serializes without losing digits beyond 2^53", () => {
    const big = { currency: "USD", minor: 9_007_199_254_740_993n };
    expect(formatDecimalAmount(big)).toBe("90071992547409.93");
    expect(toMoneyDto(big)).toEqual({ currency: "USD", amountMinor: "9007199254740993" });
    expect(formatDecimalAmount({ currency: "USD", minor: 5n })).toBe("0.05");
  });

  test("never adds different currencies", () => {
    expect(() => addMoney({ currency: "USD", minor: 1n }, { currency: "EUR", minor: 1n })).toThrow(RangeError);
  });
});
