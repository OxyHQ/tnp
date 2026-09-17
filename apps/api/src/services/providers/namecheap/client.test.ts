/**
 * Transport behaviour, driven through the real adapters over a fake `fetch`.
 * Nothing here calls the client's internals directly: every assertion is about
 * the bytes a real call would send and the error a real caller would receive.
 */

import { describe, expect, test } from "bun:test";
import { provesNothingApplied } from "../errors.js";
import type { ContactSet } from "../contracts.js";
import { MAX_RESPONSE_BYTES, NAMECHEAP_ENDPOINTS } from "./client.js";
import { createNamecheapDns, createNamecheapRegistrar } from "./factory.js";
import {
  FAKE_API_KEY,
  FAKE_CLIENT_IP,
  createHarness,
  errorStrings,
  errorXml,
  fakeAccount,
  fixture,
  hang,
  providerError,
  publicName,
  xmlResponse,
} from "./testHarness.js";

const held = publicName("held-fixture", "com");
const free = publicName("free-fixture", "com");

const contact = {
  firstName: "Rita",
  lastName: "Example",
  address1: "1 Fixture Way",
  city: "Testville",
  stateProvince: "TS",
  postalCode: "00000",
  country: "US",
  phone: "+1.5550000000",
  email: "rita@example.invalid",
};
const contacts: ContactSet = { registrant: contact, admin: contact, tech: contact, billing: contact };

function setup(environment: "sandbox" | "production" = "sandbox", shortTimeouts = false) {
  const h = createHarness();
  const options = shortTimeouts
    ? {
        timeoutOverridesMs: {
          "namecheap.domains.create": 20,
          "namecheap.domains.renew": 20,
          "namecheap.domains.dns.setHosts": 20,
          "namecheap.domains.getInfo": 20,
        },
      }
    : {};
  const registrar = createNamecheapRegistrar(fakeAccount(environment), h.deps, options);
  const dns = createNamecheapDns(fakeAccount(environment), h.deps, options);
  return { h, registrar, dns };
}

/** Queue the reads `register` performs before `domains.create`, then `last`. */
function queueRegister(h: ReturnType<typeof createHarness>, last: Parameters<typeof h.respond>[0]) {
  h.respond(fixture("pricing-register.xml"), fixture("check-free.xml"), last);
}

describe("endpoint and request encoding", () => {
  test("sandbox and production accounts call their own allowlisted endpoint", async () => {
    for (const environment of ["sandbox", "production"] as const) {
      const { h, registrar } = setup(environment);
      h.respond(fixture("balances.xml"));
      await registrar.getBalance(h.ctx());
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0].url).toBe(NAMECHEAP_ENDPOINTS[environment]);
    }
    expect(NAMECHEAP_ENDPOINTS.sandbox).toBe("https://api.sandbox.namecheap.com/xml.response");
    expect(NAMECHEAP_ENDPOINTS.production).toBe("https://api.namecheap.com/xml.response");
  });

  test("an endpoint in account config is ignored", async () => {
    const h = createHarness();
    const registrar = createNamecheapRegistrar(
      fakeAccount("production", { endpoint: "https://attacker.invalid/xml.response" }),
      h.deps,
    );
    h.respond(fixture("balances.xml"));
    await registrar.getBalance(h.ctx());
    expect(h.requests[0].url).toBe(NAMECHEAP_ENDPOINTS.production);
  });

  test("global parameters travel in a POST form body, never the URL", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("balances.xml"));
    await registrar.getBalance(h.ctx());
    const [request] = h.requests;
    expect(request.method).toBe("POST");
    expect(request.contentType).toContain("application/x-www-form-urlencoded");
    expect(request.url).not.toContain(FAKE_API_KEY);
    expect(request.body.get("ApiUser")).toBe("fixtureuser");
    expect(request.body.get("ApiKey")).toBe(FAKE_API_KEY);
    expect(request.body.get("UserName")).toBe("fixtureuser");
    expect(request.body.get("ClientIp")).toBe(FAKE_CLIENT_IP);
    expect(request.body.get("Command")).toBe("namecheap.users.getBalances");
  });

  test("the API key is not reachable by serializing the adapter", () => {
    const { registrar, dns } = setup();
    expect(JSON.stringify(registrar)).not.toContain(FAKE_API_KEY);
    expect(JSON.stringify(dns)).not.toContain(FAKE_API_KEY);
    expect(Bun.inspect(registrar)).not.toContain(FAKE_API_KEY);
  });
});

describe("HTTP 200 with Status=ERROR", () => {
  test("is a failure, mapped by error number", async () => {
    const cases = [
      { number: "1011150", description: "Invalid request IP", code: "credentials" },
      { number: "1017411", description: "Too many login attempts", code: "rate_limited" },
      { number: "2011170", description: "PromotionCode is invalid", code: "validation" },
      { number: "4022312", description: "Balance information is not available", code: "provider_unavailable" },
      { number: "9999999", description: "never documented", code: "permanent" },
    ] as const;
    for (const c of cases) {
      const { h, registrar } = setup();
      h.respond(errorXml(c.number, c.description));
      const err = await providerError(() => registrar.getBalance(h.ctx()));
      expect({ number: c.number, code: err.code }).toEqual({ number: c.number, code: c.code });
      expect(err.providerCode).toBe(c.number);
      expect(err.submitted).toBe(true);
      expect(err.message).not.toContain("<");
      expect(err.safeMessage).not.toContain(c.description);
    }
  });

  test("the documented IP-not-whitelisted response is a credentials error", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("error-ip-not-whitelisted.xml"));
    const err = await providerError(() => registrar.getBalance(h.ctx()));
    expect(err.code).toBe("credentials");
    expect(err.providerCode).toBe("1011150");
  });

  test("getInfo on a name this account does not hold is not_found", async () => {
    for (const number of ["2019166", "2016166", "4011103"]) {
      const { h, registrar } = setup();
      h.respond(errorXml(number, "DomainName not Available"));
      const err = await providerError(() => registrar.getInfo(h.ctx(), held));
      expect({ number, code: err.code }).toEqual({ number, code: "not_found" });
    }
  });

  test("4011103 describing the user name is a configuration problem, not a missing domain", async () => {
    const { h, registrar } = setup();
    h.respond(errorXml("4011103", "UserName not Available"));
    const err = await providerError(() => registrar.getInfo(h.ctx(), held));
    expect(err.code).toBe("credentials");
  });

  test("domain taken on create is not_available and proves nothing was applied", async () => {
    const { h, registrar } = setup();
    queueRegister(h, errorXml("3019166", "Domain not available"));
    const err = await providerError(() =>
      registrar.register(h.ctx(), { name: free, years: 1, contacts, nameservers: [], privacy: false, maxCost: null }),
    );
    expect(err.code).toBe("not_available");
    expect(provesNothingApplied(err)).toBe(true);
  });

  test("order creation failed citing funds is insufficient_funds", async () => {
    const { h, registrar } = setup();
    queueRegister(h, errorXml("2528166", "Order creation failed: insufficient funds"));
    const err = await providerError(() =>
      registrar.register(h.ctx(), { name: free, years: 1, contacts, nameservers: [], privacy: false, maxCost: null }),
    );
    expect(err.code).toBe("insufficient_funds");
    expect(provesNothingApplied(err)).toBe(true);
  });

  test("a provider-side error after a create was sent is unknown_outcome", async () => {
    for (const number of ["4023166", "5050900", "4026312", "3031166", "7000001"]) {
      const { h, registrar } = setup();
      queueRegister(h, errorXml(number, "Error while adding a domain"));
      const err = await providerError(() =>
        registrar.register(h.ctx(), { name: free, years: 1, contacts, nameservers: [], privacy: false, maxCost: null }),
      );
      expect({ number, code: err.code, submitted: err.submitted }).toEqual({
        number,
        code: "unknown_outcome",
        submitted: true,
      });
      expect(provesNothingApplied(err)).toBe(false);
    }
  });

  test("the same provider-side number on a read is provider_unavailable, not unknown_outcome", async () => {
    const { h, registrar } = setup();
    h.respond(errorXml("5050900", "Unknown exceptions"));
    const err = await providerError(() => registrar.getLock(h.ctx(), held));
    expect(err.code).toBe("provider_unavailable");
  });

  test("Status=ERROR with no error element is still a failure", async () => {
    const { h, registrar } = setup();
    h.respond(`<?xml version="1.0"?><ApiResponse Status="ERROR"><Errors /></ApiResponse>`);
    const err = await providerError(() => registrar.getBalance(h.ctx()));
    expect(err.code).toBe("provider_unavailable");
  });

  test("Status=OK with a create that did not register is unknown_outcome", async () => {
    const { h, registrar } = setup();
    queueRegister(h, fixture("create-not-registered.xml"));
    const err = await providerError(() =>
      registrar.register(h.ctx(), { name: free, years: 1, contacts, nameservers: [], privacy: false, maxCost: null }),
    );
    expect(err.code).toBe("unknown_outcome");
  });
});

describe("hostile and broken bodies", () => {
  const billionLaughs = `<?xml version="1.0"?>
<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">]>
<ApiResponse Status="OK"><CommandResponse><UserGetBalancesResult Currency="USD" AvailableBalance="&lol2;" /></CommandResponse></ApiResponse>`;

  test("a DOCTYPE or ENTITY declaration is rejected before parsing", async () => {
    for (const body of [billionLaughs, `<?xml version="1.0"?><!ENTITY x "y"><ApiResponse Status="OK" />`]) {
      const { h, registrar } = setup();
      h.respond(body);
      const err = await providerError(() => registrar.getBalance(h.ctx()));
      expect(err.code).toBe("provider_unavailable");
      expect(err.message).toContain("doctype");
    }
  });

  test("a DOCTYPE on a mutating call is unknown_outcome", async () => {
    const { h, registrar } = setup();
    h.respond(billionLaughs);
    const err = await providerError(() => registrar.setLock(h.ctx(), held, true));
    expect(err.code).toBe("unknown_outcome");
  });

  test("malformed and truncated bodies are failures for reads and unknown for writes", async () => {
    const full = fixture("balances.xml");
    const bodies = ["this is not xml", full.slice(0, Math.floor(full.length / 2)), "", "<html><body>502</body></html>"];
    for (const body of bodies) {
      const read = setup();
      read.h.respond(body);
      const readErr = await providerError(() => read.registrar.getBalance(read.h.ctx()));
      expect(readErr.code).toBe("provider_unavailable");

      const write = setup();
      write.h.respond(body);
      const writeErr = await providerError(() => write.registrar.setLock(write.h.ctx(), held, false));
      expect(writeErr.code).toBe("unknown_outcome");
      expect(writeErr.submitted).toBe(true);
    }
  });

  test("a well-formed response without the expected element is not a success", async () => {
    const { h, registrar } = setup();
    h.respond(`<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse /></ApiResponse>`);
    const err = await providerError(() => registrar.getBalance(h.ctx()));
    expect(err.code).toBe("provider_unavailable");
    expect(err.message).toContain("UserGetBalancesResult");
  });

  test("a body over the cap is abandoned while streaming, without a content-length", async () => {
    const { h, registrar } = setup();
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    h.respond(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulled += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
          { status: 200 },
        ),
    );
    const err = await providerError(() => registrar.getBalance(h.ctx()));
    expect(err.code).toBe("provider_unavailable");
    expect(err.message).toContain("size cap");
    // An infinite stream was stopped shortly after the cap, not drained.
    expect(pulled).toBeGreaterThan(MAX_RESPONSE_BYTES);
    expect(pulled).toBeLessThan(MAX_RESPONSE_BYTES + 4 * chunk.byteLength);
  });

  test("a declared content-length over the cap is refused, and is unknown for a write", async () => {
    const { h, dns } = setup();
    h.respond(fixture("hosts-get.xml"), () =>
      xmlResponse("<ApiResponse/>", { headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } }),
    );
    const zone = await dns.readZone(h.ctx(), held);
    const err = await providerError(() => dns.replaceZone(h.ctx(), held, zone));
    expect(err.code).toBe("unknown_outcome");
  });
});

describe("HTTP and transport failures", () => {
  test("429 and 5xx on a read are retryable failures, on a write unknown", async () => {
    for (const [status, readCode] of [
      [429, "rate_limited"],
      [503, "provider_unavailable"],
    ] as const) {
      const read = setup();
      read.h.respond(() => new Response("busy", { status, headers: { "retry-after": "7" } }));
      const readErr = await providerError(() => read.registrar.getBalance(read.h.ctx()));
      expect(readErr.code).toBe(readCode);
      if (status === 429) expect(readErr.retryAfterMs).toBe(7000);

      const write = setup();
      write.h.respond(() => new Response("busy", { status }));
      const writeErr = await providerError(() => write.registrar.setLock(write.h.ctx(), held, true));
      expect(writeErr.code).toBe("unknown_outcome");
    }
  });

  test("a failure proven before sending is submitted:false even for a write", async () => {
    for (const code of ["ConnectionRefused", "ENOTFOUND", "CERT_HAS_EXPIRED"]) {
      const { h, registrar } = setup();
      h.respond(() => {
        throw Object.assign(new TypeError("Unable to connect"), { code });
      });
      const err = await providerError(() => registrar.setLock(h.ctx(), held, true));
      expect({ code, result: err.code, submitted: err.submitted }).toEqual({
        code,
        result: "provider_unavailable",
        submitted: false,
      });
      expect(provesNothingApplied(err)).toBe(true);
    }
  });

  test("a reset or unclassified transport error on a write is unknown_outcome", async () => {
    for (const code of ["ECONNRESET", undefined]) {
      const { h, registrar } = setup();
      h.respond(() => {
        throw Object.assign(new TypeError("socket closed"), code === undefined ? {} : { code });
      });
      const err = await providerError(() => registrar.setLock(h.ctx(), held, true));
      expect(err.code).toBe("unknown_outcome");
      expect(err.submitted).toBe(true);
    }
  });
});

describe("timeouts", () => {
  test("timeout on domains.create, domains.renew and dns.setHosts is unknown_outcome, submitted", async () => {
    const create = setup("sandbox", true);
    queueRegister(create.h, hang());
    const createErr = await providerError(() =>
      create.registrar.register(create.h.ctx(), {
        name: free, years: 1, contacts, nameservers: [], privacy: false, maxCost: null,
      }),
    );

    const renew = setup("sandbox", true);
    renew.h.respond(fixture("pricing-renew.xml"), hang());
    const renewErr = await providerError(() =>
      renew.registrar.renew(renew.h.ctx(), { name: held, years: 1, maxCost: null }),
    );

    const setHosts = setup("sandbox", true);
    setHosts.h.respond(fixture("hosts-get.xml"), hang());
    const zone = await setHosts.dns.readZone(setHosts.h.ctx(), held);
    const setHostsErr = await providerError(() => setHosts.dns.replaceZone(setHosts.h.ctx(), held, zone));

    for (const err of [createErr, renewErr, setHostsErr]) {
      expect({ code: err.code, submitted: err.submitted }).toEqual({ code: "unknown_outcome", submitted: true });
      expect(err.message).toContain("timed out");
    }
    expect(create.h.events.at(-1)).toBe("fetch:namecheap.domains.create");
    expect(renew.h.events.at(-1)).toBe("fetch:namecheap.domains.renew");
    expect(setHosts.h.events.at(-1)).toBe("fetch:namecheap.domains.dns.setHosts");
  });

  test("timeout on a read is not unknown_outcome", async () => {
    const { h, registrar } = setup("sandbox", true);
    h.respond(hang());
    const err = await providerError(() => registrar.getInfo(h.ctx(), held));
    expect(err.code).toBe("provider_unavailable");
    expect(err.message).toContain("timed out");
  });

  test("a caller's abort during a write is unknown_outcome", async () => {
    const { h, registrar } = setup();
    const controller = new AbortController();
    h.respond((request) => {
      controller.abort();
      return hang()(request);
    });
    const err = await providerError(() => registrar.setLock(h.ctx({ signal: controller.signal }), held, true));
    expect(err.code).toBe("unknown_outcome");
  });
});

describe("beforeSubmit and quota ordering", () => {
  test("a write acquires quota, awaits beforeSubmit, then sends — in that order", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("lock-set-ok.xml"));
    let resolved = false;
    const ctx = h.ctx({
      beforeSubmit: async () => {
        // Yield to the event loop: an un-awaited beforeSubmit would let the
        // request go out before this resolves.
        await new Promise((r) => setTimeout(r, 10));
        resolved = true;
        h.events.push("beforeSubmit");
      },
    });
    await registrar.setLock(ctx, held, true);
    expect(resolved).toBe(true);
    expect(h.events).toEqual(["quota:critical", "beforeSubmit", "fetch:namecheap.domains.setRegistrarLock"]);
  });

  test("every mutating command awaits beforeSubmit exactly once, immediately before its request", async () => {
    const { h, registrar, dns } = setup();
    h.respond(fixture("hosts-get.xml"), fixture("hosts-set-ok.xml"));
    const zone = await dns.readZone(h.ctx(), held);
    await dns.replaceZone(h.ctx(), held, zone);

    h.respond(fixture("set-contacts-ok.xml"));
    await registrar.setContacts(h.ctx(), held, contacts);

    queueRegister(h, fixture("create-ok.xml"));
    await registrar.register(h.ctx(), { name: free, years: 1, contacts, nameservers: [], privacy: false, maxCost: null });

    h.respond(fixture("pricing-renew.xml"), fixture("renew-ok.xml"));
    await registrar.renew(h.ctx(), { name: held, years: 1, maxCost: null });

    h.respond(fixture("pricing-transfer.xml"), fixture("transfer-create-ok.xml"));
    await registrar.transferIn(h.ctx(), { name: publicName("incoming-fixture", "com"), authCode: "AbC123xyz", years: 1, maxCost: null });

    const mutating = [
      "namecheap.domains.dns.setHosts",
      "namecheap.domains.setContacts",
      "namecheap.domains.create",
      "namecheap.domains.renew",
      "namecheap.domains.transfer.create",
    ];
    for (const command of mutating) {
      const index = h.events.indexOf(`fetch:${command}`);
      expect({ command, previous: h.events[index - 1] }).toEqual({ command, previous: "beforeSubmit" });
    }
    const fetches = h.events.filter((e) => e.startsWith("fetch:")).length;
    expect(h.events.filter((e) => e === "beforeSubmit")).toHaveLength(mutating.length);
    // Reads never call beforeSubmit.
    expect(fetches).toBeGreaterThan(mutating.length);
  });

  test("a rejecting beforeSubmit means no request is sent", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("lock-set-ok.xml"));
    const boom = new Error("could not persist submitted_at");
    const ctx = h.ctx({ beforeSubmit: () => Promise.reject(boom) });
    await expect(registrar.setLock(ctx, held, true)).rejects.toBe(boom);
    expect(h.requests).toHaveLength(0);
  });

  test("a rejecting beforeSubmit on create sends no create", async () => {
    const { h, registrar } = setup();
    queueRegister(h, fixture("create-ok.xml"));
    const ctx = h.ctx({ beforeSubmit: () => Promise.reject(new Error("db down")) });
    await expect(
      registrar.register(ctx, { name: free, years: 1, contacts, nameservers: [], privacy: false, maxCost: null }),
    ).rejects.toThrow("db down");
    expect(h.requests.map((r) => r.body.get("Command"))).not.toContain("namecheap.domains.create");
  });

  test("quota refusal means no request and no beforeSubmit", async () => {
    const { h, registrar } = setup();
    h.refuseQuota();
    h.respond(fixture("lock-set-ok.xml"));
    const err = await providerError(() => registrar.setLock(h.ctx(), held, true));
    expect(err.code).toBe("rate_limited");
    expect(err.submitted).toBe(false);
    expect(h.requests).toHaveLength(0);
    expect(h.events).toEqual(["quota:critical"]);
  });

  test("search-path commands are interactive; everything else is critical", async () => {
    const { h, registrar } = setup();
    h.respond(fixture("tld-list.xml"));
    await registrar.listSuffixes(h.ctx());
    h.respond(fixture("check.xml"));
    await registrar.checkAvailability(h.ctx(), [free]);
    h.respond(fixture("pricing-register.xml"));
    await registrar.getPrices(h.ctx(), { operation: "register", suffix: "com" });
    h.respond(fixture("balances.xml"));
    await registrar.getBalance(h.ctx());
    h.respond(fixture("info-ok.xml"));
    await registrar.getInfo(h.ctx(), held);
    expect(h.quotaCalls.map((q) => q.priority)).toEqual(["interactive", "interactive", "interactive", "critical", "critical"]);
    expect(new Set(h.quotaCalls.map((q) => q.accountId))).toEqual(new Set(["acct-fixture"]));
  });
});

describe("secrets never leak into errors", () => {
  test("the API key is redacted from provider descriptions and transport causes", async () => {
    const provider = setup();
    provider.h.respond(errorXml("1011102", `Parameter APIKey ${FAKE_API_KEY} is invalid`));
    const providerErr = await providerError(() => provider.registrar.getBalance(provider.h.ctx()));
    expect(providerErr.message).toContain("[REDACTED]");

    const transport = setup();
    transport.h.respond((request) => {
      throw new Error(`failed POST ${request.body.toString()}`);
    });
    const transportErr = await providerError(() => transport.registrar.setLock(transport.h.ctx(), held, true));
    expect(transportErr.cause).toBeDefined();

    for (const err of [providerErr, transportErr]) {
      expect(errorStrings(err)).not.toContain(FAKE_API_KEY);
      expect(errorStrings(err)).not.toContain(encodeURIComponent(FAKE_API_KEY));
    }
  });

  test("the EPP code is redacted, plain and base64, from every error path", async () => {
    const authCode = "s3cr3t&EPP<code>";
    const base64 = Buffer.from(authCode).toString("base64");
    const name = publicName("incoming-fixture", "com");
    const errors = [];

    const echoed = setup();
    echoed.h.respond(fixture("pricing-transfer.xml"), (request) =>
      xmlResponse(errorXml("5050900", `bad code ${request.body.get("EPPCode") ?? ""} for ${authCode.replace(/[<&>]/g, "")}`)),
    );
    errors.push(await providerError(() => echoed.registrar.transferIn(echoed.h.ctx(), { name, authCode, years: 1, maxCost: null })));
    expect(echoed.h.requests[1].body.get("EPPCode")).toBe(`base64:${base64}`);

    const thrown = setup();
    thrown.h.respond(fixture("pricing-transfer.xml"), (request) => {
      throw new Error(`reset while sending ${request.body.toString()} ${authCode}`);
    });
    errors.push(await providerError(() => thrown.registrar.transferIn(thrown.h.ctx(), { name, authCode, years: 1, maxCost: null })));

    const malformed = setup();
    malformed.h.respond(fixture("pricing-transfer.xml"), fixture("transfer-create-ok.xml").replace('Transfer="true"', 'Transfer="maybe"'));
    errors.push(await providerError(() => malformed.registrar.transferIn(malformed.h.ctx(), { name, authCode, years: 1, maxCost: null })));

    for (const err of errors) {
      const strings = errorStrings(err);
      expect(strings).not.toContain(authCode);
      expect(strings).not.toContain(base64);
      expect(strings).not.toContain(encodeURIComponent(authCode));
      expect(strings).not.toContain(FAKE_API_KEY);
    }
    expect(errors.map((e) => e.code)).toEqual(["unknown_outcome", "unknown_outcome", "unknown_outcome"]);
  });

  test("contact values echoed by the provider are redacted", async () => {
    const { h, registrar } = setup();
    h.respond(errorXml("2015182", `The contact phone ${contact.phone} for ${contact.email} is invalid`));
    const err = await providerError(() => registrar.setContacts(h.ctx(), held, contacts));
    expect(err.code).toBe("validation");
    expect(errorStrings(err)).not.toContain(contact.email);
    expect(errorStrings(err)).not.toContain(contact.phone);
  });
});
