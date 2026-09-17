import { describe, expect, test } from "bun:test";
import { canonicalJson, hashIntent, isValidIdempotencyKey } from "./intent.js";

describe("intent hashing", () => {
  test("key order does not change the hash; values do", () => {
    expect(hashIntent({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(hashIntent({ b: { d: "x", c: [1, 2] }, a: 1 }));
    expect(hashIntent({ a: 1 })).not.toBe(hashIntent({ a: 2 }));
    expect(hashIntent({ list: [1, 2] })).not.toBe(hashIntent({ list: [2, 1] }));
  });

  test("bigints and dates are canonical, undefined fields are ignored", () => {
    expect(canonicalJson({ n: 10n, at: new Date("2026-01-01T00:00:00Z"), skip: undefined })).toBe(
      '{"at":"2026-01-01T00:00:00.000Z","n":"10"}',
    );
  });

  test("idempotency keys are bounded and plain", () => {
    expect(isValidIdempotencyKey("order-2026-09-17:abc")).toBe(true);
    expect(isValidIdempotencyKey("short")).toBe(false);
    expect(isValidIdempotencyKey("x".repeat(129))).toBe(false);
    expect(isValidIdempotencyKey("has space in it")).toBe(false);
    expect(isValidIdempotencyKey(undefined)).toBe(false);
  });
});
