/**
 * Namecheap API transport: authentication, serialization, limits, timeouts and
 * error normalization. It decides nothing about ownership, pricing or money.
 *
 * Every rule here exists because of how a call can fail after money moved:
 *
 * - Quota is acquired before anything else, and `beforeSubmit` is awaited
 *   after quota and immediately before a mutating request is written, so a
 *   refused quota never leaves a `submitted_at` behind and a crash after
 *   `submitted_at` is reconciled, never re-executed.
 * - A mutating call that fails anywhere after the request may have been
 *   written — timeout, reset, 5xx, an oversized, truncated or malformed body,
 *   or a provider-side error number — is `unknown_outcome`. Only failures
 *   proven to happen before the request left (DNS resolution, connection
 *   refused, TLS verification) are `submitted: false`.
 * - The API key and any per-call secret (EPP code, contact data) are removed
 *   from every message and cause this module produces.
 */

import type { AdapterCallContext, ProviderEnvironment } from "../contracts.js";
import { ProviderError, isProviderError, type ProviderErrorCode } from "../errors.js";
import type { AdapterDependencies, QuotaPriority } from "../registry.js";
import { redact } from "../secrets.js";
import { classifyErrorNumber } from "./errorCodes.js";
import type { NamecheapSettings } from "./config.js";
import { XmlRejected, attr, child, children, parseXml, text, type XmlNode } from "./xml.js";

/** Allowlisted endpoints (https://www.namecheap.com/support/api/intro/). Never from config or input. */
export const NAMECHEAP_ENDPOINTS: Readonly<Record<ProviderEnvironment, string>> = {
  production: "https://api.namecheap.com/xml.response",
  sandbox: "https://api.sandbox.namecheap.com/xml.response",
};

/** Largest body read before the response is abandoned. A getList page of 100 domains is well under 100 KiB. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

export type NamecheapCommand =
  | "namecheap.domains.check"
  | "namecheap.domains.getTldList"
  | "namecheap.users.getPricing"
  | "namecheap.users.getBalances"
  | "namecheap.domains.create"
  | "namecheap.domains.renew"
  | "namecheap.domains.getInfo"
  | "namecheap.domains.getList"
  | "namecheap.domains.getContacts"
  | "namecheap.domains.setContacts"
  | "namecheap.domains.getRegistrarLock"
  | "namecheap.domains.setRegistrarLock"
  | "namecheap.domains.dns.getHosts"
  | "namecheap.domains.dns.setHosts"
  | "namecheap.domains.transfer.create"
  | "namecheap.domains.transfer.getStatus";

interface CommandSpec {
  readonly mutating: boolean;
  readonly priority: QuotaPriority;
  readonly timeoutMs: number;
}

/**
 * Per-command behaviour. Timeouts are generous for purchases on purpose: the
 * documented `domains.create` and `domains.renew` examples report an
 * `ExecutionTime` of 29.9 s, and a timeout that fires before the provider
 * finishes turns a success into an `unknown_outcome` that needs reconciling.
 */
export const COMMANDS: Readonly<Record<NamecheapCommand, CommandSpec>> = {
  "namecheap.domains.check": { mutating: false, priority: "interactive", timeoutMs: 15_000 },
  "namecheap.domains.getTldList": { mutating: false, priority: "interactive", timeoutMs: 30_000 },
  "namecheap.users.getPricing": { mutating: false, priority: "interactive", timeoutMs: 30_000 },
  "namecheap.users.getBalances": { mutating: false, priority: "critical", timeoutMs: 15_000 },
  "namecheap.domains.create": { mutating: true, priority: "critical", timeoutMs: 120_000 },
  "namecheap.domains.renew": { mutating: true, priority: "critical", timeoutMs: 120_000 },
  "namecheap.domains.getInfo": { mutating: false, priority: "critical", timeoutMs: 30_000 },
  "namecheap.domains.getList": { mutating: false, priority: "critical", timeoutMs: 30_000 },
  "namecheap.domains.getContacts": { mutating: false, priority: "critical", timeoutMs: 30_000 },
  "namecheap.domains.setContacts": { mutating: true, priority: "critical", timeoutMs: 60_000 },
  "namecheap.domains.getRegistrarLock": { mutating: false, priority: "critical", timeoutMs: 30_000 },
  "namecheap.domains.setRegistrarLock": { mutating: true, priority: "critical", timeoutMs: 60_000 },
  "namecheap.domains.dns.getHosts": { mutating: false, priority: "critical", timeoutMs: 30_000 },
  "namecheap.domains.dns.setHosts": { mutating: true, priority: "critical", timeoutMs: 60_000 },
  "namecheap.domains.transfer.create": { mutating: true, priority: "critical", timeoutMs: 120_000 },
  "namecheap.domains.transfer.getStatus": { mutating: false, priority: "critical", timeoutMs: 30_000 },
};

/**
 * Error codes from `fetch` that can only happen before a request is written:
 * name resolution, a refused connection, or TLS verification failing during
 * the handshake. Measured on Bun 1.4.2: a refused port rejects with
 * `code: "ConnectionRefused"`, an unresolvable host with `ENOTFOUND`, an
 * expired certificate with `CERT_HAS_EXPIRED`. `ECONNRESET` is deliberately
 * absent: a reset can arrive after the body was sent.
 */
const PRE_SEND_ERROR_CODES: ReadonlySet<string> = new Set([
  "ConnectionRefused",
  "ECONNREFUSED",
  "FailedToOpenSocket",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_NONAME",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export interface NamecheapClientOptions {
  /** Test seam: shorter timeouts. Production uses `COMMANDS`. */
  readonly timeoutOverridesMs?: Partial<Record<NamecheapCommand, number>>;
}

export interface CallOptions {
  /** Values that must never appear in an error: EPP codes, contact fields. */
  readonly sensitive?: readonly string[];
}

export interface CommandResult {
  /** The `<CommandResponse>` element. */
  readonly response: XmlNode;
  readonly mutating: boolean;
}

export class NamecheapClient {
  readonly endpoint: string;
  // A true private field: `private` is erased at runtime, and an adapter that
  // is logged, inspected or serialized must not carry the key with it.
  readonly #apiKey: string;

  constructor(
    private readonly accountId: string,
    environment: ProviderEnvironment,
    private readonly settings: NamecheapSettings,
    apiKey: string,
    private readonly deps: AdapterDependencies,
    private readonly options: NamecheapClientOptions = {},
  ) {
    this.endpoint = NAMECHEAP_ENDPOINTS[environment];
    this.#apiKey = apiKey;
  }

  async call(
    ctx: AdapterCallContext,
    command: NamecheapCommand,
    params: Readonly<Record<string, string>>,
    callOptions: CallOptions = {},
  ): Promise<CommandResult> {
    const spec = COMMANDS[command];
    const secrets = [this.#apiKey, ...(callOptions.sensitive ?? [])];
    const fail = new Failure(command, spec.mutating, secrets);

    if (ctx.signal?.aborted) {
      throw fail.error("provider_unavailable", "cancelled before the request was sent", { submitted: false });
    }

    // Quota first: a refusal throws `rate_limited` with `submitted: false`
    // and nothing else has happened yet — no `submitted_at`, no request.
    await this.deps.quota.acquire(this.accountId, spec.priority);

    const body = new URLSearchParams();
    body.set("ApiUser", this.settings.apiUser);
    body.set("ApiKey", this.#apiKey);
    body.set("UserName", this.settings.userName);
    body.set("ClientIp", this.settings.clientIp);
    body.set("Command", command);
    for (const [key, value] of Object.entries(params)) body.set(key, value);

    if (spec.mutating) {
      // The operation engine persists `submitted_at` here. If it throws, the
      // request is not sent: an unrecorded submission is exactly what
      // reconciliation cannot recover from.
      await ctx.beforeSubmit();
    }

    const timeoutMs = this.options.timeoutOverridesMs?.[command] ?? spec.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = () => controller.abort();
    ctx.signal?.addEventListener("abort", onCallerAbort, { once: true });

    try {
      let response: Response;
      try {
        // POST with a form body: the setHosts page recommends HTTP POST for
        // more than 10 hosts and the create page recommends it outright, and a
        // body keeps the API key out of any URL an intermediary might log.
        response = await this.deps.fetch(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
          body: body.toString(),
          signal: controller.signal,
          redirect: "error",
        });
      } catch (err) {
        throw fail.transport(err, timedOut);
      }

      if (response.status === 429) {
        throw fail.afterSend("rate_limited", "HTTP 429", retryAfterMs(response.headers.get("retry-after")));
      }
      if (response.status < 200 || response.status > 299) {
        throw fail.afterSend("provider_unavailable", `HTTP ${response.status}`);
      }

      let raw: string;
      try {
        raw = await readCapped(response, MAX_RESPONSE_BYTES);
      } catch (err) {
        if (err instanceof BodyTooLarge) throw fail.afterSend("provider_unavailable", "response exceeds size cap");
        throw fail.afterSend("provider_unavailable", timedOut ? "timed out reading response" : "response body failed", undefined, err);
      }

      let doc: XmlNode;
      try {
        doc = parseXml(raw);
      } catch (err) {
        const reason = err instanceof XmlRejected ? err.reason : "malformed";
        throw fail.afterSend("provider_unavailable", `response rejected (${reason})`);
      }

      const apiResponse = child(doc, "ApiResponse");
      const status = apiResponse ? attr(apiResponse, "Status") : undefined;
      if (!apiResponse || status === undefined) {
        throw fail.afterSend("provider_unavailable", "response has no ApiResponse status");
      }
      if (status.toUpperCase() === "ERROR") {
        throw fail.apiError(apiResponse);
      }
      if (status.toUpperCase() !== "OK") {
        throw fail.afterSend("provider_unavailable", "response status is neither OK nor ERROR");
      }
      const commandResponse = child(apiResponse, "CommandResponse");
      if (!commandResponse) throw fail.afterSend("provider_unavailable", "response has no CommandResponse");
      return { response: commandResponse, mutating: spec.mutating };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /** Turn a response this adapter cannot interpret into the right error for the command. */
  shapeError(command: NamecheapCommand, detail: string, sensitive: readonly string[] = []): ProviderError {
    const spec = COMMANDS[command];
    return new Failure(command, spec.mutating, [this.#apiKey, ...sensitive]).afterSend(
      "provider_unavailable",
      `unexpected response shape: ${detail}`,
    );
  }
}

/** Builds errors for one call, with that call's secrets redacted from every string. */
class Failure {
  constructor(
    private readonly command: NamecheapCommand,
    private readonly mutating: boolean,
    private readonly secrets: readonly string[],
  ) {}

  error(
    code: ProviderErrorCode,
    detail: string,
    options: { submitted: boolean; providerCode?: string; retryAfterMs?: number; cause?: unknown },
  ): ProviderError {
    return new ProviderError(code, redact(`namecheap ${this.command}: ${detail}`, this.secrets), {
      submitted: options.submitted,
      providerCode: options.providerCode,
      retryAfterMs: options.retryAfterMs,
      cause: options.cause === undefined ? undefined : this.safeCause(options.cause),
    });
  }

  /**
   * A failure after the request may have reached Namecheap. For a read that is
   * the given code; for a write it is always `unknown_outcome`.
   */
  afterSend(code: ProviderErrorCode, detail: string, retryAfter?: number, cause?: unknown): ProviderError {
    return this.error(this.mutating ? "unknown_outcome" : code, detail, {
      submitted: true,
      retryAfterMs: this.mutating ? undefined : retryAfter,
      cause,
    });
  }

  transport(err: unknown, timedOut: boolean): ProviderError {
    if (timedOut) return this.afterSend("provider_unavailable", "timed out", undefined, err);
    const code = errorCode(err);
    if (code !== undefined && PRE_SEND_ERROR_CODES.has(code)) {
      return this.error("provider_unavailable", `request not sent (${code})`, { submitted: false, cause: err });
    }
    return this.afterSend("provider_unavailable", `transport failure${code ? ` (${code})` : ""}`, undefined, err);
  }

  apiError(apiResponse: XmlNode): ProviderError {
    const errorsNode = child(apiResponse, "Errors");
    const entries = errorsNode ? children(errorsNode, "Error") : [];
    if (entries.length === 0) {
      return this.afterSend("provider_unavailable", "Status=ERROR without an error number");
    }
    const classified = entries.map((entry) => {
      const number = attr(entry, "Number") ?? "";
      const description = text(entry) ?? "";
      return { ...classifyErrorNumber(number, description, this.mutating), description };
    });
    // One unknown outcome among several errors makes the whole call unknown.
    const chosen = classified.find((c) => c.code === "unknown_outcome") ?? classified[0];
    const description = chosen.description.slice(0, 200);
    return this.error(chosen.code, `error ${chosen.number}: ${description}`, {
      submitted: true,
      providerCode: chosen.number,
    });
  }

  private safeCause(cause: unknown): Error {
    if (isProviderError(cause)) return cause;
    const name = cause instanceof Error ? cause.name : "Error";
    const message = cause instanceof Error ? cause.message : String(cause);
    const safe = new Error(redact(message, this.secrets));
    safe.name = name;
    return safe;
  }
}

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = err.code;
  return typeof code === "string" ? code : undefined;
}

function retryAfterMs(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim()) * 1000;
}

class BodyTooLarge extends Error {}

/** Read a body as UTF-8, abandoning it as soon as it passes `limit` bytes. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new BodyTooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let received = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLarge();
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}
