/**
 * Opt-in Namecheap SANDBOX suite. Not part of `bun run test` or CI.
 *
 *   NAMECHEAP_SANDBOX_API_USER=… NAMECHEAP_SANDBOX_API_KEY=… \
 *   NAMECHEAP_SANDBOX_USERNAME=… NAMECHEAP_SANDBOX_CLIENT_IP=<whitelisted egress IPv4> \
 *   bun run test:sandbox:namecheap
 *
 * Missing variables FAIL the run rather than skip it: a skipped suite reads as
 * "validated" in a summary, and nothing here is validated until it has run.
 *
 * Read-only calls always run. `domains.create` runs only with
 * NAMECHEAP_SANDBOX_ALLOW_CREATE=1, and even then only against the sandbox
 * endpoint: the account below is hard-wired to `environment: "sandbox"`, and
 * the endpoint is chosen from that, never from a variable. Sandbox
 * registrations cannot be deleted (API FAQ), so the name is random and
 * obviously a test.
 */

import { describe, expect, test } from "bun:test";
import type { AdapterCallContext, ContactSet } from "../src/services/providers/contracts.js";
import { NAMECHEAP_ENDPOINTS } from "../src/services/providers/namecheap/client.js";
import { namecheapFactory } from "../src/services/providers/namecheap/factory.js";
import type { AdapterDependencies, ProviderAccountConfig } from "../src/services/providers/registry.js";
import { createEnvSecretResolver } from "../src/services/providers/secrets.js";
import { splitRegistrableName } from "../src/services/publicNames.js";

const REQUIRED = [
  "NAMECHEAP_SANDBOX_API_USER",
  "NAMECHEAP_SANDBOX_API_KEY",
  "NAMECHEAP_SANDBOX_USERNAME",
  "NAMECHEAP_SANDBOX_CLIENT_IP",
] as const;

function missing(): string[] {
  return REQUIRED.filter((name) => !process.env[name]);
}

function adapters() {
  const absent = missing();
  if (absent.length > 0) throw new Error(`sandbox suite needs ${absent.join(", ")}`);
  const account: ProviderAccountConfig = {
    ref: { id: "sandbox-suite", adapter: "namecheap", environment: "sandbox" },
    config: {
      apiUser: process.env.NAMECHEAP_SANDBOX_API_USER,
      userName: process.env.NAMECHEAP_SANDBOX_USERNAME,
      clientIp: process.env.NAMECHEAP_SANDBOX_CLIENT_IP,
    },
    secretRef: "env:NAMECHEAP_SANDBOX_API_KEY",
  };
  let calls = 0;
  const deps: AdapterDependencies = {
    secrets: createEnvSecretResolver(),
    // Published limit is 50/minute per key; this suite makes a handful of calls.
    quota: {
      async acquire() {
        calls += 1;
        if (calls > 40) throw new Error("sandbox suite exceeded its own call budget");
      },
    },
    fetch,
    now: () => new Date(),
  };
  const registrar = namecheapFactory.createRegistrar?.(account, deps);
  if (!registrar) throw new Error("factory did not build a registrar");
  return { registrar, calls: () => calls };
}

function ctx(): AdapterCallContext {
  return { correlationId: `sandbox-${Date.now()}`, beforeSubmit: async () => undefined };
}

const TIMEOUT = 60_000;

describe("Namecheap sandbox (opt-in)", () => {
  test("credentials are configured", () => {
    expect(missing()).toEqual([]);
    expect(NAMECHEAP_ENDPOINTS.sandbox).toContain("sandbox");
  });

  test("getTldList returns registerable extensions including com", async () => {
    const { registrar } = adapters();
    const suffixes = await registrar.listSuffixes(ctx());
    expect(suffixes.length).toBeGreaterThan(10);
    expect(suffixes.find((s) => s.suffix === "com")?.registerable).toBe(true);
  }, TIMEOUT);

  test("check answers for a random name and a certainly-registered one", async () => {
    const { registrar } = adapters();
    const suffixes = new Set(["com"]);
    const random = splitRegistrableName(`tnp-sandbox-${crypto.randomUUID().slice(0, 12)}.com`, suffixes);
    const known = splitRegistrableName("namecheap.com", suffixes);
    if (!random.ok || !known.ok) throw new Error("test names did not split");
    const results = await registrar.checkAvailability(ctx(), [random.name, known.name]);
    expect(results.map((r) => r.status)).toEqual(["available", "unavailable"]);
  }, TIMEOUT);

  test("getPricing quotes com registration per year in a stated currency", async () => {
    const { registrar } = adapters();
    const offers = await registrar.getPrices(ctx(), { operation: "register", suffix: "com" });
    const oneYear = offers.find((o) => o.years === 1);
    expect(oneYear?.cost.minor).toBeGreaterThan(0n);
    expect(oneYear?.cost.currency).toMatch(/^[A-Z]{3}$/);
  }, TIMEOUT);

  test("getBalances returns a balance", async () => {
    const { registrar } = adapters();
    const balance = await registrar.getBalance(ctx());
    expect(balance.currency).toMatch(/^[A-Z]{3}$/);
    expect(balance.minor).toBeGreaterThanOrEqual(0n);
  }, TIMEOUT);

  test("getList pages", async () => {
    const { registrar } = adapters();
    const page = await registrar.listDomains(ctx(), { page: 1, pageSize: 10 });
    expect(page.page).toBe(1);
    expect(page.total).toBeGreaterThanOrEqual(page.items.length);
  }, TIMEOUT);

  test.if(process.env.NAMECHEAP_SANDBOX_ALLOW_CREATE === "1")(
    "domains.create registers a random sandbox name, then getInfo sees it",
    async () => {
      const { registrar } = adapters();
      const split = splitRegistrableName(`tnp-sandbox-${crypto.randomUUID().slice(0, 12)}.com`, new Set(["com"]));
      if (!split.ok) throw new Error("test name did not split");
      const person = {
        firstName: "Sandbox",
        lastName: "Tester",
        address1: "1 Sandbox Street",
        city: "Phoenix",
        stateProvince: "AZ",
        postalCode: "85034",
        country: "US",
        phone: "+1.5555550100",
        email: "sandbox-tester@example.com",
      };
      const contacts: ContactSet = { registrant: person, admin: person, tech: person, billing: person };
      const result = await registrar.register(ctx(), {
        name: split.name,
        years: 1,
        contacts,
        nameservers: [],
        privacy: false,
        maxCost: { currency: "USD", minor: 5000n },
      });
      expect(result.remoteId).not.toBeNull();
      const info = await registrar.getInfo(ctx(), split.name);
      expect(info.ascii).toBe(split.name.ascii);
      expect(info.expiresAt).not.toBeNull();
    },
    TIMEOUT * 3,
  );
});
