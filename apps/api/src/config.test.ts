import { describe, expect, test } from "bun:test";
import { parseExpiryEnforced } from "./config.js";

describe("TNP_NATIVE_EXPIRY_ENFORCED", () => {
  test("is off unless explicitly true", () => {
    for (const value of [undefined, "", "false", "0", "1", "yes", "on", "enabled"]) {
      expect(parseExpiryEnforced(value)).toBe(false);
    }
    for (const value of ["true", "TRUE", " true "]) {
      expect(parseExpiryEnforced(value)).toBe(true);
    }
  });
});
