import { describe, expect, test } from "bun:test";
import type { ContactSet } from "../contracts.js";
import { createNamecheapRegistrar } from "./factory.js";
import { NAMECHEAP_REGISTRAR_CAPABILITIES } from "./capabilities.js";
import { lifecycleFromStatus } from "./registrar.js";
import {
  createHarness,
  errorXml,
  fakeAccount,
  fixture,
  providerError,
  publicName,
} from "./testHarness.js";

function setup() {
  const h = createHarness();
  return { h, registrar: createNamecheapRegistrar(fakeAccount(), h.deps) };
}

const held = publicName("held-fixture", "com");
const free = publicName("free-fixture", "com");

const person = (first: string) => ({
  firstName: first,
  lastName: "Example",
  organization: "Fixture Org",
  address1: "1 Fixture Way",
  address2: "Suite 0",
  city: "Testville",
  stateProvince: "TS",
  postalCode: "00000",
  country: "US",
  phone: "+1.5550000000",
  email: `${first.toLowerCase()}@example.invalid`,
});
const contacts: ContactSet = {
  registrant: person("Rita"),
  admin: person("Ada"),
  tech: person("Theo"),
  billing: person("Bill"),
};

describe("listSuffixes (domains.getTldList)", () => {
  test("maps each Tld's API flags and year limits", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("tld-list.xml"));
    const suffixes = await registrar.listSuffixes(h.ctx());
    expect(h.requests[0].body.get("Command")).toBe("namecheap.domains.getTldList");
    expect(suffixes).toEqual([
      { suffix: "biz", registerable: true, renewable: true, transferable: true, minYears: 1, maxYears: 10, idn: false, requiresExtendedAttributes: false },
      // IsApiTransferable="true" but .bz is not on transfer.create's list.
      { suffix: "bz", registerable: false, renewable: false, transferable: false, minYears: 1, maxYears: 10, idn: true, requiresExtendedAttributes: false },
      { suffix: "co.uk", registerable: true, renewable: false, transferable: false, minYears: 2, maxYears: 10, idn: false, requiresExtendedAttributes: true },
    ]);
  });

  test("a flag that is not a boolean is a provider failure, not false", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("tld-list.xml").replace('IsApiRegisterable="true"', 'IsApiRegisterable="yes"'));
    const err = await providerError(() => registrar.listSuffixes(h.ctx()));
    expect(err.code).toBe("provider_unavailable");
  });
});

describe("checkAvailability (domains.check)", () => {
  test("available, taken, premium, per-name error and unanswered names", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("check.xml"));
    const names = [
      publicName("taken-fixture", "com"),
      free,
      publicName("premium-fixture", "xyz"),
      publicName("error-fixture", "com"),
      publicName("silent-fixture", "com"),
    ];
    const results = await registrar.checkAvailability(h.ctx(), names);
    expect(h.requests[0].body.get("DomainList")).toBe(
      "taken-fixture.com,free-fixture.com,premium-fixture.xyz,error-fixture.com,silent-fixture.com",
    );
    expect(results.map((r) => [r.name.ascii, r.status, r.premium])).toEqual([
      ["taken-fixture.com", "unavailable", false],
      ["free-fixture.com", "available", false],
      ["premium-fixture.xyz", "available", true],
      ["error-fixture.com", "unknown", false],
      ["silent-fixture.com", "unknown", false],
    ]);
    // No currency in the response: no Money invented for the premium price.
    expect(results[2].premiumRegistrationPrice).toBeUndefined();
  });

  test("more than 50 names are split into documented-size batches", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("check.xml"));
    const names = Array.from({ length: 120 }, (_, i) => publicName(`n${i}`, "com"));
    await registrar.checkAvailability(h.ctx(), names);
    expect(h.requests.map((r) => (r.body.get("DomainList") ?? "").split(",").length)).toEqual([50, 50, 20]);
  });
});

describe("getPrices (users.getPricing)", () => {
  test("requests one product and prices per year, taking the larger of Price and YourPrice", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("pricing-register.xml"));
    const offers = await registrar.getPrices(h.ctx(), { operation: "register", suffix: "com" });
    const body = h.requests[0].body;
    expect([body.get("ProductType"), body.get("ProductCategory"), body.get("ActionName"), body.get("ProductName")]).toEqual([
      "DOMAIN", "DOMAINS", "REGISTER", "COM",
    ]);
    expect(offers).toEqual([
      // 1 year: Price 8.95 < YourPrice 9.58.
      { suffix: "com", operation: "register", years: 1, cost: { currency: "USD", minor: 958n }, fees: null },
      // 2 years at 8.95/year; fee max(0.20, 0.18) per year. MONTH row and .net skipped.
      { suffix: "com", operation: "register", years: 2, cost: { currency: "USD", minor: 1790n }, fees: { currency: "USD", minor: 40n } },
    ]);
  });

  test("a category for another action is not read as this one", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("pricing-renew.xml"));
    expect(await registrar.getPrices(h.ctx(), { operation: "register", suffix: "com" })).toEqual([]);
  });

  test("a price with more precision than the currency allows is refused, not rounded", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("pricing-register.xml").replace('YourPrice="9.58"', 'YourPrice="9.585"'));
    const err = await providerError(() => registrar.getPrices(h.ctx(), { operation: "register", suffix: "com" }));
    expect(err.code).toBe("provider_unavailable");
  });
});

describe("getBalance (users.getBalances)", () => {
  test("AvailableBalance in the stated currency", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("balances.xml"));
    expect(await registrar.getBalance(h.ctx())).toEqual({ currency: "USD", minor: 493296n });
  });
});

describe("register (domains.create)", () => {
  const request = { name: free, years: 1, contacts, nameservers: ["ns1.example.invalid", "ns2.example.invalid"], privacy: true, maxCost: null };

  test("sends every contact role, nameservers and privacy; returns ids and the charge", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("pricing-register.xml"), fixture("check-free.xml"), fixture("create-ok.xml"));
    const result = await registrar.register(h.ctx(), request);
    expect(h.requests.map((r) => r.body.get("Command"))).toEqual([
      "namecheap.users.getPricing",
      "namecheap.domains.check",
      "namecheap.domains.create",
    ]);
    const body = h.requests[2].body;
    expect(body.get("DomainName")).toBe("free-fixture.com");
    expect(body.get("Years")).toBe("1");
    expect(body.get("Nameservers")).toBe("ns1.example.invalid,ns2.example.invalid");
    expect(body.get("AddFreeWhoisguard")).toBe("yes");
    expect(body.get("WGEnabled")).toBe("yes");
    for (const [prefix, first] of [["Registrant", "Rita"], ["Admin", "Ada"], ["Tech", "Theo"], ["AuxBilling", "Bill"]]) {
      expect(body.get(`${prefix}FirstName`)).toBe(first);
      expect(body.get(`${prefix}EmailAddress`)).toBe(`${first.toLowerCase()}@example.invalid`);
      expect(body.get(`${prefix}Phone`)).toBe("+1.5550000000");
      expect(body.get(`${prefix}OrganizationName`)).toBe("Fixture Org");
      expect(body.get(`${prefix}Address2`)).toBe("Suite 0");
    }
    expect(result).toEqual({ remoteId: "103877", remoteOrderId: "22158", charged: { currency: "USD", minor: 958n } });
  });

  test("maxCost below the quoted price refuses before anything is bought", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("pricing-register.xml"), fixture("check-free.xml"), fixture("create-ok.xml"));
    let submitted = false;
    const err = await providerError(() =>
      registrar.register(h.ctx({ beforeSubmit: async () => { submitted = true; } }), {
        ...request,
        maxCost: { currency: "USD", minor: 957n },
      }),
    );
    expect(err.code).toBe("conflict");
    expect(submitted).toBe(false);
    expect(h.requests.map((r) => r.body.get("Command"))).toEqual(["namecheap.users.getPricing"]);
  });

  test("maxCost in another currency refuses; maxCost equal to the price proceeds", async () => {
    const other = setup();
    other.h.respond(fixture("pricing-register.xml"));
    const err = await providerError(() => other.registrar.register(other.h.ctx(), { ...request, maxCost: { currency: "EUR", minor: 100000n } }));
    expect(err.code).toBe("conflict");

    const equal = setup();
    equal.h.respond(fixture("pricing-register.xml"), fixture("check-free.xml"), fixture("create-ok.xml"));
    await equal.registrar.register(equal.h.ctx(), { ...request, maxCost: { currency: "USD", minor: 958n } });
    expect(equal.h.requests).toHaveLength(3);
  });

  test("a premium name is refused without a create", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("pricing-register.xml"), fixture("check-premium.xml"), fixture("create-ok.xml"));
    const err = await providerError(() => registrar.register(h.ctx(), request));
    expect(err.code).toBe("unsupported");
    expect(h.requests.map((r) => r.body.get("Command"))).not.toContain("namecheap.domains.create");
  });

  test("extended-attribute extensions, IDN names, bad years and bad contacts send nothing", async () => {
    const cases = [
      { ...request, name: publicName("fixture", "us") },
      { ...request, name: publicName("fixture", "co.uk") },
      { ...request, name: publicName("xn--fixtur-bua", "com") },
      { ...request, years: 0 },
      { ...request, years: 11 },
      { ...request, contacts: { ...contacts, tech: { ...contacts.tech, phone: "555-0000" } } },
      { ...request, contacts: { ...contacts, admin: { ...contacts.admin, country: "USA" } } },
    ];
    for (const c of cases) {
      const { h, registrar } = setup();
      h.respond(fixture("create-ok.xml"));
      const err = await providerError(() => registrar.register(h.ctx(), c));
      expect(["unsupported", "validation"]).toContain(err.code);
      expect(h.requests).toHaveLength(0);
    }
  });

  test("an extension with no price for the term is unsupported", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("pricing-register.xml"));
    const err = await providerError(() => registrar.register(h.ctx(), { ...request, years: 5 }));
    expect(err.code).toBe("unsupported");
  });
});

describe("renew (domains.renew)", () => {
  test("returns the new expiry parsed as UTC, and the charge", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("pricing-renew.xml"), fixture("renew-ok.xml"));
    const result = await registrar.renew(h.ctx(), { name: held, years: 1, maxCost: { currency: "USD", minor: 958n } });
    expect(h.requests[1].body.get("DomainName")).toBe("held-fixture.com");
    expect(h.requests[1].body.get("Years")).toBe("1");
    expect(result.expiresAt?.toISOString()).toBe("2031-04-30T23:31:13.000Z");
    expect(result).toMatchObject({ charged: { currency: "USD", minor: 958n }, remoteOrderId: "109116" });
  });

  test("an expired domain is refused as documented", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("pricing-renew.xml"), errorXml("2020166", "Domain has expired. Please reactivate your domain."));
    const err = await providerError(() => registrar.renew(h.ctx(), { name: held, years: 1, maxCost: null }));
    expect(err.code).toBe("permanent");
  });
});

describe("getInfo (domains.getInfo)", () => {
  test("dates, privacy, DNS and lifecycle", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("info-ok.xml"));
    const info = await registrar.getInfo(h.ctx(), held);
    expect(h.requests[0].body.get("DomainName")).toBe("held-fixture.com");
    expect({ ...info, createdAt: info.createdAt?.toISOString(), expiresAt: info.expiresAt?.toISOString() }).toEqual({
      ascii: "held-fixture.com",
      remoteId: "736542",
      rawStatus: "Ok",
      lifecycle: "active",
      createdAt: "2016-09-05T00:00:00.000Z",
      expiresAt: "2027-12-31T00:00:00.000Z",
      locked: null,
      privacy: true,
      autoRenew: null,
      usesProviderDns: true,
      nameservers: ["dns1.registrar-servers.com", "dns2.registrar-servers.com"],
    });
  });

  test("the documented example shape: no IsUsingOurDNS means unknown, not false", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("info-documented.xml"));
    const info = await registrar.getInfo(h.ctx(), held);
    expect(info.usesProviderDns).toBeNull();
    expect(info.nameservers).toEqual([]);
    expect(info.lifecycle).toBe("expired");
  });

  test("a domain another user shares with this account is not_found", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("info-not-owner.xml"));
    const err = await providerError(() => registrar.getInfo(h.ctx(), held));
    expect(err.code).toBe("not_found");
  });

  test("an unparseable date is a provider failure, not a null expiry", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("info-ok.xml").replace("12/31/2027", "2027-12-31"));
    const err = await providerError(() => registrar.getInfo(h.ctx(), held));
    expect(err.code).toBe("provider_unavailable");
  });

  test("lifecycle mapping table with unknown fallback", () => {
    expect(["OK", "Ok", "Locked", "Expired", "Suspended", ""].map(lifecycleFromStatus)).toEqual([
      "active", "active", "locked_by_registry", "expired", "unknown", "unknown",
    ]);
  });
});

describe("listDomains (domains.getList)", () => {
  test("rows and paging", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("list.xml"));
    const page = await registrar.listDomains(h.ctx(), { page: 2, pageSize: 10 });
    const body = h.requests[0].body;
    expect([body.get("Page"), body.get("PageSize"), body.get("ListType")]).toEqual(["2", "10", "ALL"]);
    expect({ page: page.page, pageSize: page.pageSize, total: page.total }).toEqual({ page: 2, pageSize: 10, total: 12 });
    expect(page.items.map((i) => ({ ...i, expiresAt: i.expiresAt?.toISOString() }))).toEqual([
      { ascii: "alpha-fixture.com", remoteId: "127", expiresAt: "2032-02-15T00:00:00.000Z", expired: false, locked: false, autoRenew: false },
      { ascii: "beta-fixture.net", remoteId: "381", expiresAt: "2023-04-28T00:00:00.000Z", expired: true, locked: true, autoRenew: true },
    ]);
  });

  test("page sizes outside the documented 10–100 are refused, not clamped", async () => {
    for (const pageSize of [9, 101, 20.5]) {
      const { h, registrar } = setup();
      h.respond(fixture("list.xml"));
      const err = await providerError(() => registrar.listDomains(h.ctx(), { page: 1, pageSize }));
      expect(err.code).toBe("validation");
      expect(h.requests).toHaveLength(0);
    }
  });
});

describe("contacts", () => {
  test("getContacts reads the four roles and ignores the privacy-service contacts", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("contacts.xml"));
    const read = await registrar.getContacts(h.ctx(), held);
    expect([read.registrant.firstName, read.admin.firstName, read.tech.firstName, read.billing.firstName]).toEqual([
      "Rita", "Ada", "Theo", "Bill",
    ]);
    expect(read.registrant).toEqual({
      firstName: "Rita",
      lastName: "Example",
      organization: "Fixture Org",
      jobTitle: undefined,
      address1: "1 Fixture Way",
      address2: undefined,
      city: "Testville",
      stateProvince: "TS",
      postalCode: "00000",
      country: "US",
      phone: "+1.5550000000",
      email: "rita@example.invalid",
    });
  });

  test("setContacts sends all four roles and requires IsSuccess", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("set-contacts-ok.xml"));
    await registrar.setContacts(h.ctx(), held, contacts);
    const body = h.requests[0].body;
    expect(body.get("DomainName")).toBe("held-fixture.com");
    expect(["Registrant", "Tech", "Admin", "AuxBilling"].map((p) => body.get(`${p}LastName`))).toEqual([
      "Example", "Example", "Example", "Example",
    ]);

    const failed = setup();
    failed.h.respond(fixture("set-contacts-ok.xml").replace('IsSuccess="true"', 'IsSuccess="false"'));
    const err = await providerError(() => failed.registrar.setContacts(failed.h.ctx(), held, contacts));
    expect(err.code).toBe("unknown_outcome");
  });
});

describe("registrar lock", () => {
  test("getLock reads RegistrarLockStatus; setLock sends LOCK/UNLOCK", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("lock-get.xml"));
    expect(await registrar.getLock(h.ctx(), held)).toBe(true);

    h.respond(fixture("lock-set-ok.xml"));
    await registrar.setLock(h.ctx(), held, false);
    await registrar.setLock(h.ctx(), held, true);
    expect(h.requests.slice(1).map((r) => r.body.get("LockAction"))).toEqual(["UNLOCK", "LOCK"]);
  });
});

describe("transfers", () => {
  test("transferIn sends an alphanumeric EPP code as-is and maps StatusID", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("pricing-transfer.xml"), fixture("transfer-create-ok.xml"));
    const status = await registrar.transferIn(h.ctx(), {
      name: publicName("incoming-fixture", "com"),
      authCode: "AbC123xyz",
      years: 1,
      maxCost: { currency: "USD", minor: 1000n },
    });
    const body = h.requests[1].body;
    expect([body.get("DomainName"), body.get("Years"), body.get("EPPCode")]).toEqual(["incoming-fixture.com", "1", "AbC123xyz"]);
    expect(status).toEqual({ remoteTransferId: "15", state: "pending", rawStatus: "StatusID -1" });
  });

  test("transferIn refuses unlisted extensions and terms other than one year", async () => {
    for (const request of [
      { name: publicName("incoming-fixture", "xyz"), authCode: "AbC123xyz", years: 1, maxCost: null },
      { name: publicName("incoming-fixture", "com"), authCode: "AbC123xyz", years: 2, maxCost: null },
    ]) {
      const { h, registrar } = setup();
      h.respond(fixture("transfer-create-ok.xml"));
      const err = await providerError(() => registrar.transferIn(h.ctx(), request));
      expect(["unsupported", "validation"]).toContain(err.code);
      expect(h.requests).toHaveLength(0);
    }
  });

  test("getTransferStatus maps documented ids and keeps the raw text", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("transfer-status.xml"));
    expect(await registrar.getTransferStatus(h.ctx(), "15")).toEqual({
      remoteTransferId: "15",
      state: "failed",
      rawStatus: "StatusID 32: Canceled - Invalid EPP/authorization key",
    });
    for (const [id, state] of [["5", "completed"], ["27", "cancelled"], ["-22", "unknown"], ["6", "unknown"], ["999", "unknown"]] as const) {
      h.respond(fixture("transfer-status.xml").replace('StatusID="32"', `StatusID="${id}"`));
      expect({ id, state: (await registrar.getTransferStatus(h.ctx(), "15")).state }).toEqual({ id, state });
    }
  });

  test("a non-numeric transfer id is refused before sending", async () => {
    const { h, registrar } = setup();
    const err = await providerError(() => registrar.getTransferStatus(h.ctx(), "15&Command=namecheap.domains.create"));
    expect(err.code).toBe("validation");
    expect(h.requests).toHaveLength(0);
  });
});

describe("capabilities", () => {
  test("nothing is claimed as validated, and transfer_out is manual", () => {
    for (const [operation, declaration] of Object.entries(NAMECHEAP_REGISTRAR_CAPABILITIES)) {
      expect({ operation, validatedAt: declaration.validatedAt, validatedIn: declaration.validatedIn }).toEqual({
        operation,
        validatedAt: null,
        validatedIn: null,
      });
    }
    expect(NAMECHEAP_REGISTRAR_CAPABILITIES.transfer_out.support).toBe("manual");
  });
});
