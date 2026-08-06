import { describe, expect, test } from "bun:test";
import { isReservedTld } from "@tnp/namespace";
import { initialTLDs } from "./seed.js";

describe("seed TLDs", () => {
  test("seeds at least one TLD — an empty list would pass every check below", () => {
    expect(initialTLDs.length).toBeGreaterThan(0);
  });

  test("seeds no TLD the public DNS root delegates", () => {
    // `.com` and `.app` were seeded here, which is what let a TNP registration
    // change what a public name resolved to for TNP users (audit S4). This is
    // the regression guard against putting one back.
    const reserved = initialTLDs.filter((t) => isReservedTld(t.name));
    expect(reserved.map((t) => t.name)).toEqual([]);
  });
});
