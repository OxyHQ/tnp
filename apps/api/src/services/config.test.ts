import { describe, expect, test } from "bun:test";
import { readServicesConfig } from "./config.js";
import { createEnvSecretResolver, redact } from "./providers/secrets.js";

describe("services flags", () => {
  test("an empty environment turns everything off and points at sandbox", () => {
    const config = readServicesConfig({});
    expect(config).toMatchObject({ catalog: false, sales: false, dnsWrite: false, worker: false, environment: "sandbox" });
  });

  test("only the literal values 1 and true enable a flag, and each flag is independent", () => {
    for (const value of ["yes", "on", "TRUE", " 1", "", "0", "false"]) {
      expect(readServicesConfig({ TNP_SERVICES_CATALOG: value }).catalog).toBe(false);
    }
    const catalogOnly = readServicesConfig({ TNP_SERVICES_CATALOG: "1" });
    expect(catalogOnly).toMatchObject({ catalog: true, sales: false, dnsWrite: false, worker: false });
  });

  test("production is only ever chosen explicitly", () => {
    expect(readServicesConfig({ TNP_SERVICES_ENVIRONMENT: "prod" }).environment).toBe("sandbox");
    expect(readServicesConfig({ TNP_SERVICES_ENVIRONMENT: "production" }).environment).toBe("production");
  });
});

describe("secrets", () => {
  test("resolves env references and refuses other schemes or missing values", () => {
    const resolver = createEnvSecretResolver({ NAMECHEAP_API_KEY: "k3y-value" });
    expect(resolver.resolve("env:NAMECHEAP_API_KEY")).toBe("k3y-value");
    expect(() => resolver.resolve("env:MISSING")).toThrow();
    expect(() => resolver.resolve("file:/etc/secret")).toThrow();
    expect(() => resolver.resolve("NAMECHEAP_API_KEY")).toThrow();
  });

  test("redaction covers raw and URL-encoded forms", () => {
    const secret = "abc+def/ghi=";
    const text = `ApiKey=${secret}&x=${encodeURIComponent(secret)}`;
    const out = redact(text, [secret]);
    expect(out).not.toContain(secret);
    expect(out).not.toContain(encodeURIComponent(secret));
  });
});
