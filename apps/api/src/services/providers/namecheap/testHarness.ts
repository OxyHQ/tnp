/**
 * Test harness for the Namecheap adapter: a recording fake `fetch`, a quota
 * gate and call context that log into one ordered event list, and fixtures.
 *
 * Imported only by `*.test.ts`. Every value is fake: the API key, the user
 * names and the client IP exist only here.
 */

import { readFileSync } from "node:fs";
import type { AdapterCallContext, ProviderEnvironment } from "../contracts.js";
import { ProviderError } from "../errors.js";
import type { AdapterDependencies, ProviderAccountConfig, QuotaPriority } from "../registry.js";
import type { PublicDomainName } from "../../publicNames.js";

export const FAKE_API_KEY = "FAKEapikey0000fixture1111notreal";
export const FAKE_CLIENT_IP = "44.0.0.1";

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

export function errorXml(number: string, description: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse Status="ERROR" xmlns="http://api.namecheap.com/xml.response">
  <Errors><Error Number="${number}">${description}</Error></Errors>
  <Warnings />
  <RequestedCommand />
</ApiResponse>`;
}

export interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly contentType: string | null;
  readonly body: URLSearchParams;
  readonly signal: AbortSignal | null;
}

export type Responder = (request: CapturedRequest) => Response | Promise<Response>;

export interface Harness {
  readonly events: string[];
  readonly requests: CapturedRequest[];
  readonly quotaCalls: Array<{ accountId: string; priority: QuotaPriority }>;
  readonly deps: AdapterDependencies;
  /** Responses served in order, one per request; the last one repeats. */
  respond(...responders: Array<Responder | string>): void;
  refuseQuota(): void;
  ctx(overrides?: Partial<AdapterCallContext>): AdapterCallContext;
}

export function xmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/xml; charset=utf-8" }, ...init });
}

export function createHarness(): Harness {
  const events: string[] = [];
  const requests: CapturedRequest[] = [];
  const quotaCalls: Array<{ accountId: string; priority: QuotaPriority }> = [];
  let responders: Array<Responder | string> = [];
  let refuse = false;

  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    const request: CapturedRequest = {
      url,
      method: init?.method ?? "GET",
      contentType: headers.get("content-type"),
      body: new URLSearchParams(bodyText),
      signal: init?.signal ?? null,
    };
    requests.push(request);
    events.push(`fetch:${request.body.get("Command") ?? "?"}`);
    const next = responders.length > 1 ? responders.shift() : responders[0];
    if (next === undefined) throw new Error("harness: no response queued");
    return typeof next === "string" ? xmlResponse(next) : next(request);
  };
  const fakeFetch: typeof fetch = Object.assign(impl, { preconnect: fetch.preconnect });

  return {
    events,
    requests,
    quotaCalls,
    deps: {
      fetch: fakeFetch,
      now: () => new Date("2026-09-17T00:00:00Z"),
      secrets: {
        resolve(ref) {
          if (ref !== "env:NAMECHEAP_FIXTURE_KEY") throw new ProviderError("credentials", "secret not set");
          return FAKE_API_KEY;
        },
      },
      quota: {
        async acquire(accountId, priority) {
          quotaCalls.push({ accountId, priority });
          events.push(`quota:${priority}`);
          if (refuse) throw new ProviderError("rate_limited", "quota exhausted", { submitted: false });
        },
      },
    },
    respond(...next) {
      responders = next;
    },
    refuseQuota() {
      refuse = true;
    },
    ctx(overrides = {}) {
      return {
        correlationId: "corr-fixture",
        beforeSubmit: async () => {
          events.push("beforeSubmit");
        },
        ...overrides,
      };
    },
  };
}

export function fakeAccount(
  environment: ProviderEnvironment = "sandbox",
  config: Record<string, unknown> = {},
  secretRef: string | null = "env:NAMECHEAP_FIXTURE_KEY",
): ProviderAccountConfig {
  return {
    ref: { id: "acct-fixture", adapter: "namecheap", environment },
    config: { apiUser: "fixtureuser", userName: "fixtureuser", clientIp: FAKE_CLIENT_IP, ...config },
    secretRef,
  };
}

export function publicName(sld: string, suffix: string): PublicDomainName {
  const ascii = `${sld}.${suffix}`;
  return { ascii, unicode: ascii, sld, suffix };
}

/** Run `fn`, returning the ProviderError it throws; fails the test if it resolves or throws anything else. */
export async function providerError(fn: () => Promise<unknown>): Promise<ProviderError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ProviderError) return err;
    throw new Error(`expected ProviderError, got ${String(err)}`);
  }
  throw new Error("expected ProviderError, call resolved");
}

/** Every string an error exposes, including its cause chain. */
export function errorStrings(err: ProviderError): string {
  const parts = [err.message, err.safeMessage, String(err.providerCode ?? "")];
  let cause: unknown = err.cause;
  for (let depth = 0; cause !== undefined && depth < 5; depth++) {
    parts.push(String(cause));
    if (cause instanceof Error) {
      parts.push(cause.message, cause.stack ?? "");
      cause = cause.cause;
    } else {
      break;
    }
  }
  return parts.join("\n");
}

/** A fetch responder that never answers until the request's signal aborts. */
export function hang(): Responder {
  return (request) =>
    new Promise<Response>((_, reject) => {
      const signal = request.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), {
        once: true,
      });
    });
}
