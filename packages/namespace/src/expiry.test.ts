import { describe, expect, test } from "bun:test";
import {
  isNativeNameServed,
  isNativeRenewalAllowed,
  nativeExpiryState,
  nextNativeExpiry,
  NATIVE_GRACE_DAYS,
  NATIVE_RENEWAL_WINDOW_DAYS,
} from "./expiry.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-17T12:00:00.000Z");

function inDays(days: number, extraMs = 0): Date {
  return new Date(NOW.getTime() + days * DAY + extraMs);
}

describe("nativeExpiryState", () => {
  test("a registration without an expiry is active forever", () => {
    expect(nativeExpiryState(null, NOW)).toBe("active");
    expect(nativeExpiryState(null, new Date("2999-01-01T00:00:00.000Z"))).toBe("active");
  });

  test("is active until the renewal window opens", () => {
    expect(nativeExpiryState(inDays(365), NOW)).toBe("active");
    expect(nativeExpiryState(inDays(NATIVE_RENEWAL_WINDOW_DAYS, 1), NOW)).toBe("active");
  });

  test("the renewal window opens exactly 90 days before expiry", () => {
    expect(NATIVE_RENEWAL_WINDOW_DAYS).toBe(90);
    expect(nativeExpiryState(inDays(NATIVE_RENEWAL_WINDOW_DAYS), NOW)).toBe("renewable");
    expect(nativeExpiryState(inDays(0, 1), NOW)).toBe("renewable");
  });

  test("grace starts at the instant of expiry and lasts 30 days inclusive", () => {
    expect(NATIVE_GRACE_DAYS).toBe(30);
    expect(nativeExpiryState(NOW, NOW)).toBe("grace");
    expect(nativeExpiryState(inDays(-NATIVE_GRACE_DAYS), NOW)).toBe("grace");
  });

  test("is expired once the grace period is over", () => {
    expect(nativeExpiryState(inDays(-NATIVE_GRACE_DAYS, -1), NOW)).toBe("expired");
    expect(nativeExpiryState(inDays(-400), NOW)).toBe("expired");
  });
});

describe("renewal and serving", () => {
  test("only an active name cannot be renewed", () => {
    expect(isNativeRenewalAllowed("active")).toBe(false);
    expect(isNativeRenewalAllowed("renewable")).toBe(true);
    expect(isNativeRenewalAllowed("grace")).toBe(true);
    expect(isNativeRenewalAllowed("expired")).toBe(true);
  });

  test("only an expired name stops being served", () => {
    expect(isNativeNameServed("active")).toBe(true);
    expect(isNativeNameServed("renewable")).toBe(true);
    expect(isNativeNameServed("grace")).toBe(true);
    expect(isNativeNameServed("expired")).toBe(false);
  });
});

describe("nextNativeExpiry", () => {
  test("an early renewal extends from the current expiry, keeping the time left", () => {
    const expiresAt = inDays(30);
    const next = nextNativeExpiry(expiresAt, NOW);
    expect(next.toISOString()).toBe("2027-10-17T12:00:00.000Z");
    expect(next.getTime()).toBeGreaterThan(inDays(365).getTime());
  });

  test("a lapsed name renews from now, not from its old expiry", () => {
    expect(nextNativeExpiry(inDays(-45), NOW).toISOString()).toBe("2027-09-17T12:00:00.000Z");
  });

  test("never mutates its input", () => {
    const expiresAt = inDays(10);
    const before = expiresAt.toISOString();
    nextNativeExpiry(expiresAt, NOW);
    expect(expiresAt.toISOString()).toBe(before);
  });

  test("a renewed name is active again, so a second renewal is refused", () => {
    for (const offset of [60, 1, 0, -10, -200]) {
      const renewed = nextNativeExpiry(inDays(offset), NOW);
      expect(nativeExpiryState(renewed, NOW)).toBe("active");
    }
  });
});
